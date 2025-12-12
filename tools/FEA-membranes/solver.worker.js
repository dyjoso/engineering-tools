/**
 * FEA Solver Web Worker
 * Handles matrix assembly, boundary conditions, solving, and result calculation
 * off the main thread for better UI responsiveness.
 */

// Import math.js for sparse matrix operations
importScripts('https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.1/math.min.js');

// --- Constants ---
const DEFAULT_MATERIAL_E = 10.5e6;
const DEFAULT_MATERIAL_NU = 0.3;
const DEFAULT_MATERIAL_T = 0.05;

// --- Helper Functions ---
function zeros(rows, cols) {
    return Array(rows).fill(0).map(() => Array(cols).fill(0));
}

function matrixMultiply(A, B) {
    const A_rows = A.length;
    const A_cols = A[0]?.length || 0;
    const B_rows = B.length;
    const B_cols = B[0]?.length || 0;
    if (A_cols !== B_rows) return null;
    const C = zeros(A_rows, B_cols);
    for (let i = 0; i < A_rows; i++) {
        for (let j = 0; j < B_cols; j++) {
            for (let k = 0; k < A_cols; k++) {
                C[i][j] += (A[i]?.[k] || 0) * (B[k]?.[j] || 0);
            }
        }
    }
    return C;
}

function matrixTranspose(A) {
    const A_rows = A.length;
    const A_cols = A[0]?.length || 0;
    const C = zeros(A_cols, A_rows);
    for (let i = 0; i < A_rows; i++) {
        for (let j = 0; j < A_cols; j++) {
            C[j][i] = A[i][j];
        }
    }
    return C;
}

function scalarMultiply(scalar, A) {
    const A_rows = A.length;
    const A_cols = A[0]?.length || 0;
    const C = zeros(A_rows, A_cols);
    for (let i = 0; i < A_rows; i++) {
        for (let j = 0; j < A_cols; j++) {
            C[i][j] = scalar * (A[i]?.[j] || 0);
        }
    }
    return C;
}

function matrixVectorMultiply(A, v) {
    const A_rows = A.length;
    const A_cols = A[0]?.length || 0;
    const v_rows = v.length;
    if (A_cols !== v_rows) return null;
    const C = Array(A_rows).fill(0);
    for (let i = 0; i < A_rows; i++) {
        for (let k = 0; k < A_cols; k++) {
            C[i] += (A[i]?.[k] || 0) * (v[k] || 0);
        }
    }
    return C;
}

// --- Element Stiffness Calculations ---
function calculateQuadElementStiffness(elementNodes, E, nu, t) {
    const Ke = zeros(8, 8);
    const coords = elementNodes.map(n => ({ x: n.x, y: n.y }));

    const D = zeros(3, 3);
    const E_factor = E / (1.0 - nu * nu);
    D[0][0] = E_factor;
    D[0][1] = E_factor * nu;
    D[1][0] = E_factor * nu;
    D[1][1] = E_factor;
    D[2][2] = E_factor * (1.0 - nu) / 2.0;

    const gpVal = 1.0 / Math.sqrt(3.0);
    const gaussPoints = [
        { xi: -gpVal, eta: -gpVal },
        { xi: gpVal, eta: -gpVal },
        { xi: gpVal, eta: gpVal },
        { xi: -gpVal, eta: gpVal }
    ];

    for (let gp = 0; gp < gaussPoints.length; gp++) {
        const xi = gaussPoints[gp].xi;
        const eta = gaussPoints[gp].eta;

        const dNdXiEta = [
            [-0.25 * (1 - eta), 0.25 * (1 - eta), 0.25 * (1 + eta), -0.25 * (1 + eta)],
            [-0.25 * (1 - xi), -0.25 * (1 + xi), 0.25 * (1 + xi), 0.25 * (1 - xi)]
        ];

        const J = zeros(2, 2);
        for (let i = 0; i < 4; i++) {
            J[0][0] += dNdXiEta[0][i] * coords[i].x;
            J[0][1] += dNdXiEta[0][i] * coords[i].y;
            J[1][0] += dNdXiEta[1][i] * coords[i].x;
            J[1][1] += dNdXiEta[1][i] * coords[i].y;
        }

        const detJ = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        if (detJ <= 1e-9) continue;

        const invDetJ = 1.0 / detJ;
        const invJ = [
            [invDetJ * J[1][1], -invDetJ * J[0][1]],
            [-invDetJ * J[1][0], invDetJ * J[0][0]]
        ];

        const dNdXY = zeros(4, 2);
        for (let i = 0; i < 4; i++) {
            dNdXY[i][0] = invJ[0][0] * dNdXiEta[0][i] + invJ[0][1] * dNdXiEta[1][i];
            dNdXY[i][1] = invJ[1][0] * dNdXiEta[0][i] + invJ[1][1] * dNdXiEta[1][i];
        }

        const B = zeros(3, 8);
        for (let i = 0; i < 4; i++) {
            B[0][2 * i] = dNdXY[i][0];
            B[1][2 * i + 1] = dNdXY[i][1];
            B[2][2 * i] = dNdXY[i][1];
            B[2][2 * i + 1] = dNdXY[i][0];
        }

        const B_T = matrixTranspose(B);
        const D_B = matrixMultiply(D, B);
        const B_T_D_B = matrixMultiply(B_T, D_B);

        if (B_T_D_B) {
            const scalarFactor = t * detJ;
            const Ke_gp = scalarMultiply(scalarFactor, B_T_D_B);
            for (let r = 0; r < 8; r++) {
                for (let c = 0; c < 8; c++) {
                    Ke[r][c] += Ke_gp[r][c];
                }
            }
        }
    }
    return Ke;
}

function calculateSpringElementStiffness(k) {
    return [
        [k, 0, -k, 0],
        [0, k, 0, -k],
        [-k, 0, k, 0],
        [0, -k, 0, k]
    ];
}

// --- OPTIMIZED: COO-based Matrix Assembly ---
function assembleGlobalMatricesCOO(feNodes, feElements, feSprings, membranes) {
    console.log("[Worker] Assembling global matrices (COO format)...");
    console.time("WorkerAssembly");

    const numNodes = feNodes.length;
    const N_DOF = numNodes * 2;

    // Build node index map
    const nodeIndexMap = new Map();
    const feNodeMap = new Map();
    feNodes.forEach((node, index) => {
        nodeIndexMap.set(node.id, index);
        feNodeMap.set(node.id, node);
    });

    // Build membrane map
    const membraneMap = new Map();
    membranes.forEach(m => membraneMap.set(m.id, m));

    // COO format: collect triplets (row, col, value)
    const triplets = [];

    // Process elements
    feElements.forEach(element => {
        if (element.type === 'quad' && element.nodeIds.length === 4) {
            const elementNodes = element.nodeIds.map(id => feNodeMap.get(id));
            if (!elementNodes.every(n => n)) return;

            const membrane = membraneMap.get(element.membraneId);
            if (!membrane) return;

            const E = element.propE !== undefined ? element.propE : (membrane.materialE ?? DEFAULT_MATERIAL_E);
            const nu = element.propNu !== undefined ? element.propNu : (membrane.materialNu ?? DEFAULT_MATERIAL_NU);
            const t = element.propT !== undefined ? element.propT : (membrane.materialT ?? DEFAULT_MATERIAL_T);

            if (isNaN(E) || isNaN(nu) || isNaN(t) || E <= 0 || t <= 0 || nu < 0 || nu >= 0.5) {
                throw new Error(`Invalid material on Membrane ${membrane.id}`);
            }

            const Ke = calculateQuadElementStiffness(elementNodes, E, nu, t);

            // Collect triplets
            element.nodeIds.forEach((nodeId_i, i) => {
                const globalRowIndex = nodeIndexMap.get(nodeId_i);
                if (globalRowIndex === undefined) return;

                element.nodeIds.forEach((nodeId_j, j) => {
                    const globalColIndex = nodeIndexMap.get(nodeId_j);
                    if (globalColIndex === undefined) return;

                    // Add 4 entries for each i,j pair
                    const r0 = 2 * globalRowIndex;
                    const c0 = 2 * globalColIndex;

                    if (Math.abs(Ke[2 * i][2 * j]) > 1e-15) triplets.push([r0, c0, Ke[2 * i][2 * j]]);
                    if (Math.abs(Ke[2 * i][2 * j + 1]) > 1e-15) triplets.push([r0, c0 + 1, Ke[2 * i][2 * j + 1]]);
                    if (Math.abs(Ke[2 * i + 1][2 * j]) > 1e-15) triplets.push([r0 + 1, c0, Ke[2 * i + 1][2 * j]]);
                    if (Math.abs(Ke[2 * i + 1][2 * j + 1]) > 1e-15) triplets.push([r0 + 1, c0 + 1, Ke[2 * i + 1][2 * j + 1]]);
                });
            });
        }
    });

    // Process springs
    feSprings.forEach(spring => {
        const node1 = feNodeMap.get(spring.feNodeId1);
        const node2 = feNodeMap.get(spring.feNodeId2);
        if (!node1 || !node2) return;

        const Ks = calculateSpringElementStiffness(spring.stiffness);
        const globalIndex1 = nodeIndexMap.get(node1.id);
        const globalIndex2 = nodeIndexMap.get(node2.id);

        if (globalIndex1 !== undefined && globalIndex2 !== undefined) {
            const dofMap = [2 * globalIndex1, 2 * globalIndex1 + 1, 2 * globalIndex2, 2 * globalIndex2 + 1];
            for (let i = 0; i < 4; i++) {
                for (let j = 0; j < 4; j++) {
                    if (Math.abs(Ks[i][j]) > 1e-15) {
                        triplets.push([dofMap[i], dofMap[j], Ks[i][j]]);
                    }
                }
            }
        }
    });

    console.log(`[Worker] Collected ${triplets.length} triplets`);

    // Sort triplets by (row, col) and sum duplicates
    triplets.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

    const condensedTriplets = [];
    for (let i = 0; i < triplets.length; i++) {
        const [r, c, v] = triplets[i];
        if (condensedTriplets.length > 0 &&
            condensedTriplets[condensedTriplets.length - 1][0] === r &&
            condensedTriplets[condensedTriplets.length - 1][1] === c) {
            condensedTriplets[condensedTriplets.length - 1][2] += v;
        } else {
            condensedTriplets.push([r, c, v]);
        }
    }

    console.log(`[Worker] After condensing: ${condensedTriplets.length} unique entries`);

    // Build math.js sparse matrix from COO
    let K_global = math.sparse();
    condensedTriplets.forEach(([r, c, v]) => {
        K_global.set([r, c], v);
    });

    // Build force vector
    const F_array = new Array(N_DOF).fill(0);
    feNodes.forEach(node => {
        if (node.bc && node.bc.type === 'load') {
            const globalIndex = nodeIndexMap.get(node.id);
            if (globalIndex !== undefined) {
                F_array[2 * globalIndex] += (node.bc.value.fx ?? 0);
                F_array[2 * globalIndex + 1] += (node.bc.value.fy ?? 0);
            }
        }
    });
    const F_global = math.matrix(F_array);

    console.timeEnd("WorkerAssembly");
    console.log(`[Worker] Global matrix: ${N_DOF}x${N_DOF}, ${condensedTriplets.length} non-zeros`);

    return { K_global, F_global, nodeIndexMap, N_DOF, feNodeMap };
}

// --- Apply Boundary Conditions ---
function applyBoundaryConditions(K_global, F_global, feNodes, nodeIndexMap, N_DOF) {
    console.log("[Worker] Applying boundary conditions...");
    console.time("WorkerApplyBCs");

    const K_modified = math.clone(K_global);
    let F_modified = math.clone(F_global);
    const PENALTY = 1e10;

    feNodes.forEach(node => {
        if (!node.bc || (node.bc.type !== 'fixed' && node.bc.type !== 'enforced')) return;

        const globalIndex = nodeIndexMap.get(node.id);
        if (globalIndex === undefined) return;

        const dofX = 2 * globalIndex;
        const dofY = 2 * globalIndex + 1;

        if (node.bc.type === 'fixed') {
            if (node.bc.value.fixX) {
                // Zero out row and column, set diagonal to 1
                for (let j = 0; j < N_DOF; j++) {
                    if (j !== dofX) K_modified.set([dofX, j], 0);
                }
                for (let i = 0; i < N_DOF; i++) {
                    if (i !== dofX) K_modified.set([i, dofX], 0);
                }
                K_modified.set([dofX, dofX], 1);
                F_modified = math.subset(F_modified, math.index(dofX), 0);
            }
            if (node.bc.value.fixY) {
                for (let j = 0; j < N_DOF; j++) {
                    if (j !== dofY) K_modified.set([dofY, j], 0);
                }
                for (let i = 0; i < N_DOF; i++) {
                    if (i !== dofY) K_modified.set([i, dofY], 0);
                }
                K_modified.set([dofY, dofY], 1);
                F_modified = math.subset(F_modified, math.index(dofY), 0);
            }
        } else if (node.bc.type === 'enforced') {
            const dx = node.bc.value.dx;
            const dy = node.bc.value.dy;

            if (dx !== null) {
                const currentDiag = K_modified.get([dofX, dofX]) || 0;
                K_modified.set([dofX, dofX], currentDiag + PENALTY);
                const currentF = math.subset(F_modified, math.index(dofX)) || 0;
                F_modified = math.subset(F_modified, math.index(dofX), currentF + PENALTY * dx);
            }
            if (dy !== null) {
                const currentDiag = K_modified.get([dofY, dofY]) || 0;
                K_modified.set([dofY, dofY], currentDiag + PENALTY);
                const currentF = math.subset(F_modified, math.index(dofY)) || 0;
                F_modified = math.subset(F_modified, math.index(dofY), currentF + PENALTY * dy);
            }
        }
    });

    console.timeEnd("WorkerApplyBCs");
    return { K_modified, F_modified };
}

// --- Solve System ---
function solveSystem(K_modified, F_modified, N_DOF) {
    console.log("[Worker] Solving system...");
    console.time("WorkerSolve");

    try {
        let F_col = F_modified;
        if (F_modified.size().length === 1) {
            F_col = math.reshape(F_modified, [N_DOF, 1]);
        }

        const d_matrix = math.lusolve(K_modified, F_col);
        const d_vec = d_matrix.toArray().flat();

        console.timeEnd("WorkerSolve");
        console.log("[Worker] System solved successfully");
        return d_vec;
    } catch (error) {
        console.error("[Worker] Solve failed:", error.message);
        throw error;
    }
}

// --- Calculate Results ---
function calculateResults(d, K_original, F_original, feNodes, feSprings, feElements, membranes, nodeIndexMap, N_DOF) {
    console.log("[Worker] Calculating results...");
    console.time("WorkerResults");

    const feNodeMap = new Map();
    feNodes.forEach(n => feNodeMap.set(n.id, n));

    const membraneMap = new Map();
    membranes.forEach(m => membraneMap.set(m.id, m));

    // Spring Loads
    const springLoads = [];
    feSprings.forEach(spring => {
        const idx1 = nodeIndexMap.get(spring.feNodeId1);
        const idx2 = nodeIndexMap.get(spring.feNodeId2);
        if (idx1 !== undefined && idx2 !== undefined) {
            const dx1 = d[2 * idx1], dy1 = d[2 * idx1 + 1];
            const dx2 = d[2 * idx2], dy2 = d[2 * idx2 + 1];
            const forceX = spring.stiffness * (dx2 - dx1);
            const forceY = spring.stiffness * (dy2 - dy1);
            springLoads.push({ id: spring.id, fx: forceX.toExponential(3), fy: forceY.toExponential(3) });
        }
    });

    // Reactions
    const reactions = [];
    try {
        const d_matrix = math.matrix(d);
        let F_orig = F_original;
        if (F_original.size().length === 1) {
            F_orig = math.reshape(F_original, [N_DOF, 1]);
        }
        const K_d = math.multiply(K_original, d_matrix);
        const R_matrix = math.subtract(K_d, F_orig);
        const R_vec = R_matrix.toArray().flat();

        feNodes.forEach(node => {
            if (node.bc && (node.bc.type === 'fixed' || node.bc.type === 'enforced')) {
                const globalIndex = nodeIndexMap.get(node.id);
                if (globalIndex !== undefined) {
                    const dofX = 2 * globalIndex;
                    const dofY = 2 * globalIndex + 1;
                    let rx = 0, ry = 0;

                    const reportX = (node.bc.type === 'fixed' && node.bc.value.fixX) ||
                        (node.bc.type === 'enforced' && node.bc.value.dx !== null);
                    const reportY = (node.bc.type === 'fixed' && node.bc.value.fixY) ||
                        (node.bc.type === 'enforced' && node.bc.value.dy !== null);

                    if (reportX) rx = Number(R_vec[dofX]).toExponential(3);
                    if (reportY) ry = Number(R_vec[dofY]).toExponential(3);

                    if (reportX || reportY) {
                        reactions.push({ feNodeId: node.id, rx, ry });
                    }
                }
            }
        });
    } catch (e) {
        console.error("[Worker] Reaction calculation failed:", e);
    }

    // Element Stresses
    const elementStresses = [];
    feElements.forEach(element => {
        if (element.type !== 'quad' || element.nodeIds.length !== 4) return;

        const elementNodes = element.nodeIds.map(id => feNodeMap.get(id));
        if (!elementNodes.every(n => n)) return;

        const membrane = membraneMap.get(element.membraneId);
        if (!membrane) return;

        const E = element.propE !== undefined ? element.propE : (membrane.materialE ?? DEFAULT_MATERIAL_E);
        const nu = element.propNu !== undefined ? element.propNu : (membrane.materialNu ?? DEFAULT_MATERIAL_NU);

        const D = zeros(3, 3);
        const E_factor = E / (1.0 - nu * nu);
        D[0][0] = E_factor; D[0][1] = E_factor * nu;
        D[1][0] = E_factor * nu; D[1][1] = E_factor;
        D[2][2] = E_factor * (1.0 - nu) / 2.0;

        const coords = elementNodes.map(n => ({ x: n.x, y: n.y }));

        // Element displacements
        const elemDisp = [];
        let valid = true;
        element.nodeIds.forEach(nodeId => {
            const idx = nodeIndexMap.get(nodeId);
            if (idx === undefined) { valid = false; return; }
            elemDisp.push(d[2 * idx], d[2 * idx + 1]);
        });
        if (!valid) return;

        // Stress at center (xi=0, eta=0)
        const xi = 0, eta = 0;
        const dNdXiEta = [
            [-0.25 * (1 - eta), 0.25 * (1 - eta), 0.25 * (1 + eta), -0.25 * (1 + eta)],
            [-0.25 * (1 - xi), -0.25 * (1 + xi), 0.25 * (1 + xi), 0.25 * (1 - xi)]
        ];

        const J = zeros(2, 2);
        for (let i = 0; i < 4; i++) {
            J[0][0] += dNdXiEta[0][i] * coords[i].x;
            J[0][1] += dNdXiEta[0][i] * coords[i].y;
            J[1][0] += dNdXiEta[1][i] * coords[i].x;
            J[1][1] += dNdXiEta[1][i] * coords[i].y;
        }

        const detJ = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        if (detJ <= 1e-9) return;

        const invDetJ = 1.0 / detJ;
        const invJ = [[invDetJ * J[1][1], -invDetJ * J[0][1]], [-invDetJ * J[1][0], invDetJ * J[0][0]]];

        const dNdXY = zeros(4, 2);
        for (let i = 0; i < 4; i++) {
            dNdXY[i][0] = invJ[0][0] * dNdXiEta[0][i] + invJ[0][1] * dNdXiEta[1][i];
            dNdXY[i][1] = invJ[1][0] * dNdXiEta[0][i] + invJ[1][1] * dNdXiEta[1][i];
        }

        const B = zeros(3, 8);
        for (let i = 0; i < 4; i++) {
            B[0][2 * i] = dNdXY[i][0];
            B[1][2 * i + 1] = dNdXY[i][1];
            B[2][2 * i] = dNdXY[i][1];
            B[2][2 * i + 1] = dNdXY[i][0];
        }

        const epsilon = matrixVectorMultiply(B, elemDisp);
        if (!epsilon) return;

        const sigma = matrixVectorMultiply(D, epsilon);
        if (!sigma) return;

        const sxx = sigma[0], syy = sigma[1], sxy = sigma[2];
        const sigmaVM = Math.sqrt(Math.max(0, sxx ** 2 - sxx * syy + syy ** 2 + 3 * sxy ** 2));

        elementStresses.push({
            elementId: element.id,
            sxx: sxx.toExponential(3),
            syy: syy.toExponential(3),
            sxy: sxy.toExponential(3),
            sigmaVM
        });
    });

    console.timeEnd("WorkerResults");
    return { springLoads, reactions, elementStresses, displacements: d };
}

// --- Message Handler ---
self.onmessage = function (e) {
    const { type, data } = e.data;
    console.log("[Worker] Received message:", type);

    if (type === 'solve') {
        try {
            const { feNodes, feElements, feSprings, membranes } = data;

            // Step 1: Assemble
            self.postMessage({ type: 'progress', message: 'Assembling matrices...' });
            const assembly = assembleGlobalMatricesCOO(feNodes, feElements, feSprings, membranes);
            const { K_global, F_global, nodeIndexMap, N_DOF } = assembly;

            // Store originals for reaction calc
            const K_original = math.clone(K_global);
            const F_original = math.clone(F_global);

            // Step 2: Apply BCs
            self.postMessage({ type: 'progress', message: 'Applying boundary conditions...' });
            const { K_modified, F_modified } = applyBoundaryConditions(K_global, F_global, feNodes, nodeIndexMap, N_DOF);

            // Step 3: Solve
            self.postMessage({ type: 'progress', message: 'Solving system...' });
            const d = solveSystem(K_modified, F_modified, N_DOF);

            // Step 4: Calculate results
            self.postMessage({ type: 'progress', message: 'Calculating results...' });
            const results = calculateResults(d, K_original, F_original, feNodes, feSprings, feElements, membranes, nodeIndexMap, N_DOF);

            // Send results back
            self.postMessage({
                type: 'done',
                results: results
            });

        } catch (error) {
            self.postMessage({
                type: 'error',
                message: error.message
            });
        }
    }
};

console.log("[Worker] Solver worker initialized");
