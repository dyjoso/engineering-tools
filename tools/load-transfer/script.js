// --- Material Definitions ---
const MATERIALS = {
    "Aluminum": { E: 10.5e6, nu: 0.33 }, // psi, Poisson's Ratio
    "Titanium": { E: 16.5e6, nu: 0.31 }, // psi, Poisson's Ratio
    "Steel": { E: 29.5e6, nu: 0.30 }  // psi, Poisson's Ratio
};

// --- Global Variables ---
let model = {
    nodes: [],                    // Layer nodes: { id, x, y, u, F, isFixed, prescribedU, layer, nodeColIndex, fastenerIndex }
    fastenerNodes: [],            // Fastener shadow nodes: { id, x, y, u, theta, correspondingLayerNodeId, layerId, fastenerId }
    layers: [],
    fasteners: [],
    layerElements: [],
    beamElements: [],             // Timoshenko beam elements connecting fastener nodes vertically
    contactSpringElements: [],    // Shear springs connecting layer node to fastener node
    rotationalSpringElements: [], // Grounded rotational springs at each fastener node
    numLayers: 0,
    numFasteners: 0,
    defaultSegmentLength: 4.0,    // inches
    fastenerMaterialName: "Steel", // Default fastener material
};

// ============================================
// DEBUG AND VALIDATION MODULE
// ============================================
const DEBUG = {
    enabled: true,  // Set to false to disable all debug output
    logLevel: 'all', // 'all', 'errors', 'summary'

    log: function (message, level = 'info') {
        if (!this.enabled) return;
        if (this.logLevel === 'errors' && level !== 'error') return;
        const prefix = level === 'error' ? '❌ ERROR: ' : level === 'warn' ? '⚠️ WARN: ' : '📊 ';
        console.log(prefix + message);
    },

    // Format number for display
    fmt: function (value, decimals = 4) {
        if (value === undefined || value === null) return 'N/A';
        if (isNaN(value)) return 'NaN';
        if (!isFinite(value)) return value > 0 ? '+Inf' : '-Inf';
        if (Math.abs(value) < 1e-10) return '0';
        if (Math.abs(value) > 1e6 || Math.abs(value) < 1e-3) {
            return value.toExponential(decimals);
        }
        return value.toFixed(decimals);
    }
};

/**
 * Comprehensive solver validation - call after solve() completes
 * Checks equilibrium, traces load paths, and identifies issues
 */
function debugSolverValidation() {
    if (!DEBUG.enabled) return;

    console.log('\n' + '='.repeat(60));
    console.log('🔍 SOLVER VALIDATION REPORT');
    console.log('='.repeat(60));

    // 1. GLOBAL SUMMARY
    console.log('\n📋 MODEL SUMMARY:');
    console.log(`   Layer nodes: ${model.nodes.length}`);
    console.log(`   Fastener nodes: ${model.fastenerNodes.length}`);
    console.log(`   Layer elements: ${model.layerElements.length}`);
    console.log(`   Beam elements: ${model.beamElements.length}`);
    console.log(`   Contact springs: ${model.contactSpringElements.length}`);
    console.log(`   Rotational springs: ${model.rotationalSpringElements.length}`);

    // 2. APPLIED LOADS AND BCS
    console.log('\n📌 BOUNDARY CONDITIONS & LOADS:');
    const fixedNodes = model.nodes.filter(n => n.isFixed);
    const loadedNodes = model.nodes.filter(n => n.F !== 0 && n.prescribedU === null);
    const dispNodes = model.nodes.filter(n => n.prescribedU !== null);

    console.log(`   Fixed nodes: ${fixedNodes.map(n => `L${n.layer}_N${n.id}`).join(', ') || 'None'}`);
    loadedNodes.forEach(n => {
        console.log(`   Load on L${n.layer}_N${n.id}: ${DEBUG.fmt(n.F)} lbf`);
    });
    dispNodes.forEach(n => {
        console.log(`   Prescribed disp on L${n.layer}_N${n.id}: ${DEBUG.fmt(n.prescribedU)} in`);
    });

    const totalAppliedLoad = loadedNodes.reduce((sum, n) => sum + n.F, 0);
    console.log(`   TOTAL APPLIED LOAD: ${DEBUG.fmt(totalAppliedLoad)} lbf`);

    // 3. DISPLACEMENTS
    console.log('\n📏 DISPLACEMENTS:');
    console.log('   Layer Nodes:');
    model.nodes.forEach(n => {
        console.log(`     L${n.layer}_N${n.id}: u = ${DEBUG.fmt(n.u)} in`);
    });
    console.log('   Fastener Nodes:');
    model.fastenerNodes.forEach(fn => {
        console.log(`     F${fn.fastenerId}_L${fn.layerId}: u = ${DEBUG.fmt(fn.u)} in, θ = ${DEBUG.fmt(fn.theta)} rad (${DEBUG.fmt(fn.theta * 180 / Math.PI)}°)`);
    });

    // 4. ELEMENT FORCES
    console.log('\n⚡ ELEMENT FORCES:');

    // Layer elements
    console.log('   Layer Elements:');
    model.layerElements.forEach(el => {
        const n1 = getNode(el.node1Id);
        const n2 = getNode(el.node2Id);
        console.log(`     LE${el.id} (L${el.layerId}): k=${DEBUG.fmt(el.stiffness)} lbf/in, F=${DEBUG.fmt(el.force)} lbf, Δu=${DEBUG.fmt((n2?.u || 0) - (n1?.u || 0))} in`);
    });

    // Beam elements
    console.log('   Beam Elements (Fastener Shank):');
    let totalBeamForce = 0;
    model.beamElements.forEach(el => {
        const fn1 = getFastenerNode(el.node1Id);
        const fn2 = getFastenerNode(el.node2Id);
        const deltaU = (fn2?.u || 0) - (fn1?.u || 0);
        const deltaTheta = (fn2?.theta || 0) - (fn1?.theta || 0);
        console.log(`     BE${el.id} (F${el.fastenerId}): F=${DEBUG.fmt(el.force)} lbf, Δu=${DEBUG.fmt(deltaU)} in, Δθ=${DEBUG.fmt(deltaTheta)} rad`);
        totalBeamForce += Math.abs(el.force || 0);
    });
    console.log(`   ➤ Sum |Beam Forces|: ${DEBUG.fmt(totalBeamForce)} lbf`);

    // Contact springs
    console.log('   Contact Springs:');
    let totalContactForce = 0;
    model.contactSpringElements.forEach(el => {
        const ln = getNode(el.layerNodeId);
        const fn = getFastenerNode(el.fastenerNodeId);
        const deltaU = (fn?.u || 0) - (ln?.u || 0);
        console.log(`     CS${el.id} (L${el.layerId}, F${el.fastenerId}): k=${DEBUG.fmt(el.stiffness)} lbf/in, F=${DEBUG.fmt(el.force)} lbf, Δu=${DEBUG.fmt(deltaU)} in`);
        totalContactForce += el.force || 0;
    });
    console.log(`   ➤ Sum Contact Forces: ${DEBUG.fmt(totalContactForce)} lbf`);

    // Rotational springs
    console.log('   Rotational Springs:');
    model.rotationalSpringElements.forEach(el => {
        const fn = getFastenerNode(el.fastenerNodeId);
        console.log(`     RS${el.id} (L${el.layerId}, F${el.fastenerId}): k=${DEBUG.fmt(el.stiffness)} lb-in/rad, M=${DEBUG.fmt(el.moment)} lb-in, θ=${DEBUG.fmt(fn?.theta)} rad`);
    });

    // 5. NODE EQUILIBRIUM CHECK
    console.log('\n⚖️ NODE EQUILIBRIUM CHECK:');
    let maxImbalance = 0;
    let totalReaction = 0;

    // Check each layer node
    model.nodes.forEach(node => {
        let sumForces = 0;
        let contributions = [];

        // Applied load
        if (node.F !== 0 && node.prescribedU === null) {
            sumForces += node.F;
            contributions.push(`Applied: ${DEBUG.fmt(node.F)}`);
        }

        // Layer elements connected to this node
        model.layerElements.forEach(le => {
            if (le.node1Id === node.id) {
                // Node is at left end of element - force = -F (reaction)
                sumForces -= le.force || 0;
                contributions.push(`LE${le.id}(left): ${DEBUG.fmt(-(le.force || 0))}`);
            }
            if (le.node2Id === node.id) {
                // Node is at right end of element - force = +F
                sumForces += le.force || 0;
                contributions.push(`LE${le.id}(right): ${DEBUG.fmt(le.force || 0)}`);
            }
        });

        // Contact springs connected to this layer node
        model.contactSpringElements.forEach(cs => {
            if (cs.layerNodeId === node.id) {
                // Force on layer node from contact spring = -k*(u_f - u_L) = -F_contact
                sumForces -= cs.force || 0;
                contributions.push(`CS${cs.id}: ${DEBUG.fmt(-(cs.force || 0))}`);
            }
        });

        // Fixed node reaction
        if (node.isFixed) {
            totalReaction += sumForces;  // The imbalance IS the reaction
            contributions.push(`REACTION: ${DEBUG.fmt(-sumForces)}`);
        }

        const imbalance = node.isFixed ? 0 : sumForces;
        if (Math.abs(imbalance) > 1e-6) {
            maxImbalance = Math.max(maxImbalance, Math.abs(imbalance));
            console.log(`   ⚠️ L${node.layer}_N${node.id}: Σ = ${DEBUG.fmt(imbalance)} lbf [${contributions.join(', ')}]`);
        }
    });

    // Check each fastener node
    model.fastenerNodes.forEach(fNode => {
        let sumForces = 0;
        let sumMoments = 0;
        let contributions = [];

        // Contact spring connected to this fastener node
        model.contactSpringElements.forEach(cs => {
            if (cs.fastenerNodeId === fNode.id) {
                sumForces += cs.force || 0;
                contributions.push(`CS${cs.id}: ${DEBUG.fmt(cs.force || 0)}`);
            }
        });

        // Beam elements connected to this fastener node
        model.beamElements.forEach(be => {
            if (be.node1Id === fNode.id) {
                // This node is at the "bottom" of the beam
                sumForces -= be.force || 0;
                contributions.push(`BE${be.id}(n1): ${DEBUG.fmt(-(be.force || 0))}`);
            }
            if (be.node2Id === fNode.id) {
                // This node is at the "top" of the beam
                sumForces += be.force || 0;
                contributions.push(`BE${be.id}(n2): ${DEBUG.fmt(be.force || 0)}`);
            }
        });

        // Rotational spring (grounded)
        model.rotationalSpringElements.forEach(rs => {
            if (rs.fastenerNodeId === fNode.id) {
                sumMoments -= rs.moment || 0;  // Grounded spring provides reaction
            }
        });

        if (Math.abs(sumForces) > 1e-6) {
            maxImbalance = Math.max(maxImbalance, Math.abs(sumForces));
            console.log(`   ⚠️ F${fNode.fastenerId}_L${fNode.layerId}: ΣF = ${DEBUG.fmt(sumForces)} lbf [${contributions.join(', ')}]`);
        }
    });

    // 6. GLOBAL EQUILIBRIUM
    console.log('\n🌐 GLOBAL EQUILIBRIUM:');
    console.log(`   Total Applied Load: ${DEBUG.fmt(totalAppliedLoad)} lbf`);
    console.log(`   Total Reaction (at fixed nodes): ${DEBUG.fmt(totalReaction)} lbf`);
    console.log(`   Imbalance: ${DEBUG.fmt(totalAppliedLoad + totalReaction)} lbf`);

    // 7. LOAD PATH TRACE (for each fastener column)
    console.log('\n🔄 LOAD PATH TRACE (per fastener):');
    for (let fIdx = 0; fIdx < model.numFasteners; fIdx++) {
        console.log(`   Fastener ${fIdx}:`);
        const fNodes = model.fastenerNodes.filter(fn => fn.fastenerId === fIdx);
        const beams = model.beamElements.filter(be => be.fastenerId === fIdx);
        const contacts = model.contactSpringElements.filter(cs => cs.fastenerId === fIdx);

        fNodes.forEach(fn => {
            const cs = contacts.find(c => c.fastenerNodeId === fn.id);
            const layer = getLayer(fn.layerId);
            console.log(`     Layer ${layer?.name || fn.layerId}: CS_force=${DEBUG.fmt(cs?.force)} lbf`);
        });
        beams.forEach(be => {
            console.log(`     Beam ${be.id}: shear=${DEBUG.fmt(be.force)} lbf`);
        });
    }

    // 8. VALIDATION SUMMARY
    console.log('\n' + '='.repeat(60));
    if (maxImbalance < 1e-6) {
        console.log('✅ VALIDATION PASSED - All nodes in equilibrium');
    } else {
        console.log(`❌ VALIDATION FAILED - Max node imbalance: ${DEBUG.fmt(maxImbalance)} lbf`);
        console.log('   Possible causes:');
        console.log('   1. Beam force calculation may be incorrect');
        console.log('   2. Sign convention mismatch between element types');
        console.log('   3. Double-counting of forces');
    }
    console.log('='.repeat(60) + '\n');

    return { maxImbalance, totalAppliedLoad, totalReaction };
}

/**
 * Debug function to print stiffness matrix structure
 */
function debugStiffnessMatrix(K, dofMap, label = 'K') {
    if (!DEBUG.enabled) return;
    console.log(`\n📦 ${label} Matrix Structure:`);
    const size = K.size()[0];
    console.log(`   Size: ${size} x ${size}`);

    // Print diagonal terms
    console.log('   Diagonal terms:');
    for (let i = 0; i < Math.min(size, 20); i++) {
        const val = math.subset(K, math.index(i, i));
        console.log(`     K[${i},${i}] = ${DEBUG.fmt(val)}`);
    }
}

let selectedElement = null;

// --- DOM Elements ---
const numLayersInput = document.getElementById('num-layers');
const numFastenersInput = document.getElementById('num-fasteners');
const layerLengthInput = document.getElementById('layer-length');
const generateBtn = document.getElementById('generate-btn');
const visualizationSVG = document.getElementById('visualization');
const solveBtn = document.getElementById('solve-btn');
const resultsSummaryDiv = document.getElementById('results-summary');
const elementEditorDiv = document.getElementById('element-editor');
const editorTitle = document.getElementById('editor-title');
const editorContent = document.getElementById('editor-content');
const updateElementBtn = document.getElementById('update-element-btn');
const deleteElementBtn = document.getElementById('delete-element-btn');
const deselectBtn = document.getElementById('deselect-btn');
const bcLayerSelect = document.getElementById('bc-layer-select');
const loadLayerSelect = document.getElementById('load-layer-select');
const dispLayerSelect = document.getElementById('disp-layer-select');
const fixNodeBtn = document.getElementById('fix-node-btn');
const unfixNodeBtn = document.getElementById('unfix-node-btn');
const applyLoadBtn = document.getElementById('apply-load-btn');
const removeLoadBtn = document.getElementById('remove-load-btn');
const loadValueInput = document.getElementById('load-value');
const applyDispBtn = document.getElementById('apply-disp-btn');
const removeDispBtn = document.getElementById('remove-disp-btn');
const dispValueInput = document.getElementById('disp-value');
const fixedNodesDisplay = document.getElementById('fixed-nodes-display');
const appliedLoadsDisplay = document.getElementById('applied-loads-display');
const appliedDispsDisplay = document.getElementById('applied-disps-display');
const globalLayerMaterialSelect = document.getElementById('global-layer-material');
const globalLayerWInput = document.getElementById('global-layer-W');
const globalLayerThicknessInput = document.getElementById('global-layer-thickness');
const applyGlobalLayerPropsBtn = document.getElementById('apply-global-layer-props-btn');
const globalFastenerMaterialSelect = document.getElementById('global-fastener-material');
const globalFastenerDiameterInput = document.getElementById('global-fastener-diameter');
const applyGlobalFastenerPropsBtn = document.getElementById('apply-global-fastener-props-btn');
const messageBox = document.getElementById('message-box');
const messageText = document.getElementById('message-text');
const rightEdgeConditionRadios = document.querySelectorAll('input[name="rightEdgeCondition"]');
const forceInputSection = document.getElementById('force-input-section');
const displacementInputSection = document.getElementById('displacement-input-section');
const renameLayerSelect = document.getElementById('rename-layer-select');
const renameLayerNewNameInput = document.getElementById('rename-layer-new-name');
const renameLayerBtn = document.getElementById('rename-layer-btn');


// --- Constants ---
const SVG_PADDING = 60;
const LAYER_SPACING = 50;
const LOAD_ARROW_LENGTH = 30;
const LOAD_ARROW_OFFSET = 10;
const BASE_STROKE_WIDTH = 2;
const MAX_STROKE_WIDTH = 10;
const CLICK_TARGET_WIDTH = 15;


// --- Utility Functions ---
function showMessage(text, isError = true) {
    messageText.textContent = text;
    const msgBox = document.getElementById('message-box');
    msgBox.className = `absolute top-4 right-4 max-w-sm z-50 transition-all duration-300 transform translate-y-0 opacity-100 ${isError ? 'error' : 'success'}`;
    msgBox.style.display = 'block';

    // Auto-hide after 5 seconds
    setTimeout(() => {
        if (messageText.textContent === text) {
            msgBox.style.display = 'none';
        }
    }, 5000);
}

function getNode(id) {
    return model.nodes.find(n => n.id === id) || null;
}

function getLayerElement(id) {
    return model.layerElements.find(el => el.id === id);
}

function getFastenerElement(id) {
    return model.fastenerElements.find(el => el.id === id);
}

function getLayer(id) {
    return model.layers.find(l => l.id === id);
}

function getFastener(id) {
    return model.fasteners.find(f => f.id === id);
}

function toggleSection(contentId, buttonElement, forceOpen = null) {
    const contentDiv = document.getElementById(contentId);
    const iconSpan = buttonElement.querySelector('.toggle-icon');

    if (contentDiv) {
        const isHidden = contentDiv.classList.contains('hidden');
        let shouldBeOpen = forceOpen !== null ? forceOpen : isHidden;

        if (shouldBeOpen) {
            contentDiv.classList.remove('hidden');
            if (iconSpan) iconSpan.classList.add('rotate-180');
        } else {
            contentDiv.classList.add('hidden');
            if (iconSpan) iconSpan.classList.remove('rotate-180');
        }
    }
}

// --- Stiffness Calculation Helpers ---

function calculateLayerElementStiffness(layerElement) {
    if (!layerElement) return 0;
    if (!layerElement.materialName || !MATERIALS[layerElement.materialName] || layerElement.W <= 0 || layerElement.t <= 0 || layerElement.length <= 0) {
        console.warn(`Invalid properties for calculating stiffness of Layer Element ${layerElement.id}`);
        return 0;
    }
    const E = MATERIALS[layerElement.materialName].E;
    const A = layerElement.W * layerElement.t;
    const L = layerElement.length;
    return (E * A) / L;
}

function calculateFastenerElementStiffness(fastenerElement) {
    if (!fastenerElement) return 0;

    const node1 = getNode(fastenerElement.node1Id);
    const node2 = getNode(fastenerElement.node2Id);
    const fastener = getFastener(fastenerElement.fastenerId);

    if (!node1 || !node2 || !fastener || fastener.diameter <= 0) {
        console.warn(`Invalid properties for calculating stiffness of Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    const layer1_obj = getLayer(node1.layer);
    const layer2_obj = getLayer(node2.layer);
    if (!layer1_obj || !layer2_obj) {
        console.warn(`Invalid layer objects for Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    const layerEl1 = model.layerElements.find(el => el.node2Id === node1.id);
    const layerEl2 = model.layerElements.find(el => el.node2Id === node2.id);

    const layerEl1_right = model.layerElements.find(el => el.node1Id === node1.id);
    const layerEl2_right = model.layerElements.find(el => el.node1Id === node2.id);

    const el1 = layerEl1 || layerEl1_right;
    const el2 = layerEl2 || layerEl2_right;

    if (!el1 || !el2) {
        console.warn(`Could not find adjacent layer elements for Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    if (!el1.materialName || !el2.materialName ||
        !MATERIALS[el1.materialName] || !MATERIALS[el2.materialName] ||
        el1.t <= 0 || el2.t <= 0) {
        console.warn(`Invalid layer element properties for calculating stiffness of Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    const E1 = MATERIALS[el1.materialName].E;
    const E2 = MATERIALS[el2.materialName].E;
    const t1 = el1.t;
    const t2 = el2.t;

    const d = fastener.diameter;

    const fastenerMaterialProps = MATERIALS[model.fastenerMaterialName];
    if (!fastenerMaterialProps) {
        console.warn(`Invalid fastener material selected: ${model.fastenerMaterialName}`);
        return 0;
    }
    const Ef = fastenerMaterialProps.E;
    const nu_f = fastenerMaterialProps.nu;

    if (E1 <= 0 || E2 <= 0 || Ef <= 0 || d <= 0 || nu_f === undefined) {
        console.warn(`Zero or negative property encountered for Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    // Tate & Rosenfeld Flexibility Calculation
    const safeTerm = (val) => (isFinite(val) && val >= 0 ? val : 0);
    const term1 = safeTerm(1 / (Ef * t1));
    const term2 = safeTerm(1 / (Ef * t2));
    const term3 = safeTerm(1 / (E1 * t1));
    const term4 = safeTerm(1 / (E2 * t2));
    const term5_coeff_denom = 9 * Ef * Math.PI * d ** 2;
    const term5_coeff = term5_coeff_denom !== 0 ? 32 / term5_coeff_denom : 0;
    const term5 = safeTerm(term5_coeff * (1 + nu_f) * (t1 + t2));
    const term6_coeff_denom = 5 * Ef * Math.PI * d ** 4;
    const term6_coeff = term6_coeff_denom !== 0 ? 8 / term6_coeff_denom : 0;
    const term6 = safeTerm(term6_coeff * (t1 ** 3 + 5 * t1 ** 2 * t2 + 5 * t1 * t2 ** 2 + t2 ** 3));
    const flexibility = term1 + term2 + term3 + term4 + term5 + term6;

    if (flexibility <= 1e-12 || !isFinite(flexibility)) {
        console.warn(`Invalid or near-zero flexibility calculated (${flexibility}) for Fastener Element ${fastenerElement.id}. Stiffness set to very large.`);
        return 1e12;
    }

    const stiffness = 1 / flexibility;
    console.log(`DEBUG: Fastener Element ${fastenerElement.id} (Fastener ${fastenerElement.fastenerId}) calculated stiffness: ${stiffness.toExponential(3)} lbf/in`);
    return stiffness;
}

// --- NEW: Beam + Contact Spring Stiffness Functions ---

/**
 * Get fastener node by ID
 */
function getFastenerNode(id) {
    return model.fastenerNodes.find(n => n.id === id) || null;
}

/**
 * Calculate the Tate & Rosenfeld flexibility for an interface between two layers
 * @param {number} t1 - Thickness of layer 1
 * @param {number} t2 - Thickness of layer 2
 * @param {number} E1 - Modulus of layer 1
 * @param {number} E2 - Modulus of layer 2
 * @param {number} d - Fastener diameter
 * @param {number} Ef - Fastener modulus
 * @param {number} nu_f - Fastener Poisson's ratio
 * @returns {number} Total flexibility C_TR
 */
function calculateTateRosenfeldFlexibility(t1, t2, E1, E2, d, Ef, nu_f) {
    const safeTerm = (val) => (isFinite(val) && val >= 0 ? val : 0);
    const term1 = safeTerm(1 / (Ef * t1));      // Fastener bearing in layer 1
    const term2 = safeTerm(1 / (Ef * t2));      // Fastener bearing in layer 2
    const term3 = safeTerm(1 / (E1 * t1));      // Plate bearing in layer 1
    const term4 = safeTerm(1 / (E2 * t2));      // Plate bearing in layer 2
    const term5_coeff_denom = 9 * Ef * Math.PI * d ** 2;
    const term5_coeff = term5_coeff_denom !== 0 ? 32 / term5_coeff_denom : 0;
    const term5 = safeTerm(term5_coeff * (1 + nu_f) * (t1 + t2));  // Shear deformation
    const term6_coeff_denom = 5 * Ef * Math.PI * d ** 4;
    const term6_coeff = term6_coeff_denom !== 0 ? 8 / term6_coeff_denom : 0;
    const term6 = safeTerm(term6_coeff * (t1 ** 3 + 5 * t1 ** 2 * t2 + 5 * t1 * t2 ** 2 + t2 ** 3)); // Bending

    return term1 + term2 + term3 + term4 + term5 + term6;
}

/**
 * Calculate the beam flexibility for a segment of length L
 * Uses guided boundary conditions (theta=0 at ends) for the flexibility extraction
 * @param {number} L - Beam segment length
 * @param {number} d - Fastener diameter
 * @param {number} Ef - Fastener modulus
 * @param {number} nu_f - Fastener Poisson's ratio
 * @returns {number} Beam flexibility C_beam
 */
function calculateBeamFlexibility(L, d, Ef, nu_f) {
    const I = Math.PI * Math.pow(d, 4) / 64;    // Moment of inertia
    const A = Math.PI * Math.pow(d, 2) / 4;     // Cross-sectional area
    const kappa = 0.9;                           // Shear correction factor for circular section
    const As = kappa * A;                        // Shear area
    const Gf = Ef / (2 * (1 + nu_f));           // Shear modulus

    // Flexibility = bending + shear (for guided boundary conditions)
    const C_bending = Math.pow(L, 3) / (12 * Ef * I);
    const C_shear = L / (Gf * As);

    return C_bending + C_shear;
}

/**
 * Calculate the 4x4 Timoshenko beam element stiffness matrix
 * DOF order: [u_i, theta_i, u_j, theta_j] where u is shear displacement, theta is rotation
 * @param {Object} beamElement - The beam element
 * @returns {Object} { matrix: 4x4 stiffness matrix, Ef, I, L, Phi } or null on error
 */
function calculateBeamElementStiffnessMatrix(beamElement) {
    if (!beamElement) return null;

    const fastenerNode1 = getFastenerNode(beamElement.node1Id);
    const fastenerNode2 = getFastenerNode(beamElement.node2Id);
    const fastener = getFastener(beamElement.fastenerId);

    if (!fastenerNode1 || !fastenerNode2 || !fastener || fastener.diameter <= 0) {
        console.warn(`Invalid properties for beam element ${beamElement.id}`);
        return null;
    }

    // Get layer thicknesses from adjacent layer elements
    const layerNode1 = getNode(fastenerNode1.correspondingLayerNodeId);
    const layerNode2 = getNode(fastenerNode2.correspondingLayerNodeId);
    if (!layerNode1 || !layerNode2) {
        console.warn(`Could not find corresponding layer nodes for beam element ${beamElement.id}`);
        return null;
    }

    // Find layer element at each layer to get thickness
    const layerEl1 = model.layerElements.find(el => el.node1Id === layerNode1.id || el.node2Id === layerNode1.id);
    const layerEl2 = model.layerElements.find(el => el.node1Id === layerNode2.id || el.node2Id === layerNode2.id);

    if (!layerEl1 || !layerEl2) {
        console.warn(`Could not find layer elements for beam element ${beamElement.id}`);
        return null;
    }

    const t1 = layerEl1.t;
    const t2 = layerEl2.t;
    const d = fastener.diameter;

    const fastenerMaterialProps = MATERIALS[model.fastenerMaterialName];
    if (!fastenerMaterialProps) {
        console.warn(`Invalid fastener material: ${model.fastenerMaterialName}`);
        return null;
    }

    const Ef = fastenerMaterialProps.E;
    const nu_f = fastenerMaterialProps.nu;

    // Beam length = distance between layer mid-planes
    const L = (t1 + t2) / 2;

    // Beam properties
    const I = Math.PI * Math.pow(d, 4) / 64;
    const A = Math.PI * Math.pow(d, 2) / 4;
    const kappa = 0.9;
    const Gf = Ef / (2 * (1 + nu_f));

    // Shear deformation parameter
    const Phi = (12 * Ef * I) / (kappa * A * Gf * L * L);

    // Timoshenko beam stiffness matrix coefficients
    const coeff = Ef * I / (Math.pow(L, 3) * (1 + Phi));

    // 4x4 stiffness matrix: [u_i, theta_i, u_j, theta_j]
    const k = [
        [12 * coeff, 6 * L * coeff, -12 * coeff, 6 * L * coeff],
        [6 * L * coeff, 4 * L * L * coeff * (1 + Phi / 4), -6 * L * coeff, 2 * L * L * coeff * (1 - Phi / 2)],
        [-12 * coeff, -6 * L * coeff, 12 * coeff, -6 * L * coeff],
        [6 * L * coeff, 2 * L * L * coeff * (1 - Phi / 2), -6 * L * coeff, 4 * L * L * coeff * (1 + Phi / 4)]
    ];

    // Store properties on the element for later use
    beamElement.length = L;
    beamElement.stiffnessMatrix = k;

    console.log(`DEBUG: Beam Element ${beamElement.id} L=${L.toFixed(4)} in, k[0,0]=${k[0][0].toExponential(3)}`);

    return { matrix: k, Ef, I, L, Phi, t1, t2 };
}

/**
 * Calculate contact spring stiffness (residual flexibility after beam)
 * @param {Object} contactSpring - The contact spring element
 * @returns {number} Stiffness k_contact
 */
function calculateContactSpringStiffness(contactSpring) {
    if (!contactSpring) return 0;

    const fastenerNode = getFastenerNode(contactSpring.fastenerNodeId);
    const layerNode = getNode(contactSpring.layerNodeId);

    if (!fastenerNode || !layerNode) {
        console.warn(`Invalid nodes for contact spring ${contactSpring.id}`);
        return 1e12; // Very stiff as fallback
    }

    const fastener = getFastener(fastenerNode.fastenerId);
    if (!fastener || fastener.diameter <= 0) {
        console.warn(`Invalid fastener for contact spring ${contactSpring.id}`);
        return 1e12;
    }

    // Find adjacent beam element to get the interface properties
    const beamElement = model.beamElements.find(be =>
        be.node1Id === fastenerNode.id || be.node2Id === fastenerNode.id
    );

    if (!beamElement) {
        // This is a fastener node at the end (top or bottom layer) - no beam above/below
        // Use single-layer flexibility approximation
        const layerEl = model.layerElements.find(el =>
            el.node1Id === layerNode.id || el.node2Id === layerNode.id
        );
        if (!layerEl) return 1e12;

        const t = layerEl.t;
        const E_layer = MATERIALS[layerEl.materialName]?.E || 10e6;
        const d = fastener.diameter;
        const fastenerMat = MATERIALS[model.fastenerMaterialName];
        const Ef = fastenerMat?.E || 29e6;
        const nu_f = fastenerMat?.nu || 0.3;

        // Simple bearing flexibility for single layer
        const C_bearing = 1 / (E_layer * t) + 1 / (Ef * t);
        return 1 / C_bearing;
    }

    // Get beam properties to calculate C_beam
    const beamProps = calculateBeamElementStiffnessMatrix(beamElement);
    if (!beamProps) return 1e12;

    const { t1, t2, L, Ef, Phi } = beamProps;
    const d = fastener.diameter;
    const nu_f = MATERIALS[model.fastenerMaterialName]?.nu || 0.3;

    // Find layer properties
    const layerEl = model.layerElements.find(el =>
        el.node1Id === layerNode.id || el.node2Id === layerNode.id
    );
    const otherFastenerNodeId = beamElement.node1Id === fastenerNode.id ? beamElement.node2Id : beamElement.node1Id;
    const otherFastenerNode = getFastenerNode(otherFastenerNodeId);
    const otherLayerNode = otherFastenerNode ? getNode(otherFastenerNode.correspondingLayerNodeId) : null;
    const otherLayerEl = otherLayerNode ? model.layerElements.find(el =>
        el.node1Id === otherLayerNode.id || el.node2Id === otherLayerNode.id
    ) : null;

    if (!layerEl || !otherLayerEl) return 1e12;

    const E1 = MATERIALS[layerEl.materialName]?.E || 10e6;
    const E2 = MATERIALS[otherLayerEl.materialName]?.E || 10e6;
    const t_this = layerEl.t;
    const t_other = otherLayerEl.t;

    // Calculate T&R total flexibility
    const C_TR = calculateTateRosenfeldFlexibility(t_this, t_other, E1, E2, d, Ef, nu_f);

    // Calculate beam flexibility
    const C_beam = calculateBeamFlexibility(L, d, Ef, nu_f);

    // Residual flexibility
    const C_resid = C_TR - C_beam;

    if (C_resid <= 0) {
        console.warn(`Contact spring ${contactSpring.id}: C_resid <= 0, using very stiff spring`);
        return 1e12;
    }

    // Split residual between two contact springs (one at each end of beam)
    const k_node = 2 / C_resid;

    contactSpring.stiffness = k_node;
    console.log(`DEBUG: Contact Spring ${contactSpring.id} k=${k_node.toExponential(3)} lbf/in`);

    return k_node;
}

/**
 * Calculate rotational spring stiffness (grounded, representing plate bore restraint)
 * k_theta = C_rot * E_layer * t^3 / d
 * @param {Object} rotSpring - The rotational spring element
 * @returns {number} Rotational stiffness k_theta (moment per radian)
 */
function calculateRotationalSpringStiffness(rotSpring) {
    if (!rotSpring) return 0;

    const fastenerNode = getFastenerNode(rotSpring.fastenerNodeId);
    if (!fastenerNode) {
        console.warn(`Invalid fastener node for rotational spring ${rotSpring.id}`);
        return 0;
    }

    const layerNode = getNode(fastenerNode.correspondingLayerNodeId);
    const fastener = getFastener(fastenerNode.fastenerId);

    if (!layerNode || !fastener) {
        console.warn(`Invalid layer node or fastener for rotational spring ${rotSpring.id}`);
        return 0;
    }

    // Find layer element to get material and thickness
    const layerEl = model.layerElements.find(el =>
        el.node1Id === layerNode.id || el.node2Id === layerNode.id
    );

    if (!layerEl) {
        console.warn(`Could not find layer element for rotational spring ${rotSpring.id}`);
        return 0;
    }

    const E_layer = MATERIALS[layerEl.materialName]?.E || 10e6;
    const t = layerEl.t;
    const d = fastener.diameter;

    // Empirical constant for rotational restraint (can be tuned)
    const C_rot = 1.0;

    // k_theta = C_rot * E * t^3 / d
    // Units: (psi * in^3) / in = lb-in / rad
    const k_theta = C_rot * E_layer * Math.pow(t, 3) / d;

    rotSpring.stiffness = k_theta;
    console.log(`DEBUG: Rotational Spring ${rotSpring.id} k_theta=${k_theta.toExponential(3)} lb-in/rad`);

    return k_theta;
}

// --- Model Generation ---
function generateInitialModel() {
    console.log("Generating model...");
    resultsSummaryDiv.innerHTML = '<p>Generating model...</p>';
    visualizationSVG.innerHTML = '';
    deselectElement();

    try {
        model.numLayers = parseInt(numLayersInput.value);
        model.numFasteners = parseInt(numFastenersInput.value);
        model.defaultSegmentLength = parseFloat(layerLengthInput.value);

        if (isNaN(model.numLayers) || isNaN(model.numFasteners) || isNaN(model.defaultSegmentLength) ||
            model.numLayers < 2 || model.numFasteners < 1 || model.defaultSegmentLength <= 0) {
            throw new Error("Invalid input. Layers >= 2, Fasteners >= 1, Default Length > 0.");
        }

        model.nodes = [];
        model.fastenerNodes = [];
        model.layers = [];
        model.fasteners = [];
        model.layerElements = [];
        model.beamElements = [];
        model.contactSpringElements = [];
        model.rotationalSpringElements = [];

        const globalLayerMatName = globalLayerMaterialSelect.value;
        const globalW_in = parseFloat(globalLayerWInput.value);
        const globalThickness_in = parseFloat(globalLayerThicknessInput.value);
        const globalFastenerMatName = globalFastenerMaterialSelect.value;
        const globalDiameter_in = parseFloat(globalFastenerDiameterInput.value);

        if (!MATERIALS[globalLayerMatName] || !MATERIALS[globalFastenerMatName] || isNaN(globalW_in) || isNaN(globalThickness_in) ||
            isNaN(globalDiameter_in) ||
            globalW_in <= 0 || globalThickness_in <= 0 ||
            globalDiameter_in <= 0) {
            throw new Error("Invalid default property values. Ensure Materials, W, t, d are valid positive numbers.");
        }
        model.fastenerMaterialName = globalFastenerMatName;


        for (let i = 0; i < model.numLayers; i++) {
            model.layers.push({
                id: i,
                name: `Layer_${i}`
            });
        }
        for (let i = 0; i < model.numFasteners; i++) {
            model.fasteners.push({ id: i, diameter: globalDiameter_in });
        }

        const numNodeCols = model.numFasteners + 2;
        let nodeId = 0;
        for (let i = 0; i < model.numLayers; i++) {
            for (let j = 0; j < numNodeCols; j++) {
                model.nodes.push({
                    id: nodeId++,
                    x: SVG_PADDING + j * 100,
                    y: i * LAYER_SPACING + SVG_PADDING,
                    u: 0, F: 0, isFixed: false, prescribedU: null,
                    layer: i,
                    nodeColIndex: j,
                    fastenerIndex: (j > 0 && j < numNodeCols - 1) ? j - 1 : -1
                });
            }
        }

        let layerElementId = 0;
        for (let i = 0; i < model.numLayers; i++) {
            for (let j = 0; j < numNodeCols - 1; j++) {
                const node1Id = i * numNodeCols + j;
                const node2Id = node1Id + 1;
                model.layerElements.push({
                    id: layerElementId++,
                    node1Id: node1Id,
                    node2Id: node2Id,
                    layerId: i,
                    materialName: globalLayerMatName,
                    W: globalW_in,
                    t: globalThickness_in,
                    stiffness: 0,
                    force: 0,
                    length: model.defaultSegmentLength
                });
            }
        }

        // --- NEW: Create fastener nodes, beam elements, contact springs, rotational springs ---
        let fastenerNodeId = 0;
        let beamElementId = 0;
        let contactSpringId = 0;
        let rotationalSpringId = 0;

        for (let j = 0; j < model.numFasteners; j++) {
            const nodeColIndex = j + 1; // Fastener columns are 1, 2, ... numFasteners

            // Create fastener nodes at each layer for this fastener column
            const fastenerNodesInColumn = [];
            for (let i = 0; i < model.numLayers; i++) {
                // Find corresponding layer node
                const layerNode = model.nodes.find(n => n.layer === i && n.nodeColIndex === nodeColIndex);
                if (!layerNode) continue;

                const fNode = {
                    id: fastenerNodeId++,
                    x: layerNode.x,  // Coincident with layer node
                    y: layerNode.y,
                    u: 0,            // Translation DOF
                    theta: 0,        // Rotation DOF
                    correspondingLayerNodeId: layerNode.id,
                    layerId: i,
                    fastenerId: j
                };
                model.fastenerNodes.push(fNode);
                fastenerNodesInColumn.push(fNode);

                // Create contact spring connecting layer node to fastener node
                model.contactSpringElements.push({
                    id: contactSpringId++,
                    layerNodeId: layerNode.id,
                    fastenerNodeId: fNode.id,
                    fastenerId: j,
                    layerId: i,
                    stiffness: 0,
                    force: 0
                });

                // Create rotational spring at this fastener node (grounded)
                model.rotationalSpringElements.push({
                    id: rotationalSpringId++,
                    fastenerNodeId: fNode.id,
                    fastenerId: j,
                    layerId: i,
                    stiffness: 0,
                    moment: 0
                });
            }

            // Create beam elements connecting adjacent fastener nodes vertically
            for (let i = 0; i < fastenerNodesInColumn.length - 1; i++) {
                const fNode1 = fastenerNodesInColumn[i];
                const fNode2 = fastenerNodesInColumn[i + 1];
                model.beamElements.push({
                    id: beamElementId++,
                    node1Id: fNode1.id,
                    node2Id: fNode2.id,
                    fastenerId: j,
                    stiffnessMatrix: null,  // Will be computed during solve
                    length: 0,
                    force: 0
                });
            }
        }

        console.log("Model generated:", model);
        console.log(`  Layer nodes: ${model.nodes.length}`);
        console.log(`  Fastener nodes: ${model.fastenerNodes.length}`);
        console.log(`  Layer elements: ${model.layerElements.length}`);
        console.log(`  Beam elements: ${model.beamElements.length}`);
        console.log(`  Contact springs: ${model.contactSpringElements.length}`);
        console.log(`  Rotational springs: ${model.rotationalSpringElements.length}`);

        updateVisualization();
        updateLayerSelectors();
        updateDisplays();
        resultsSummaryDiv.innerHTML = '<p>Model generated. Define properties, BCs, and loads.</p>';
        showMessage("Model generated successfully.", false);

        // Auto-open next steps
        const propsContent = document.getElementById('properties-content');
        if (propsContent && propsContent.classList.contains('hidden')) {
            toggleSection('properties-content', propsContent.previousElementSibling.querySelector('button'), true);
        }

        const bcsContent = document.getElementById('bcs-content');
        if (bcsContent && bcsContent.classList.contains('hidden')) {
            toggleSection('bcs-content', bcsContent.previousElementSibling.querySelector('button'), true);
        }


    } catch (error) {
        showMessage(`Error generating model: ${error.message}`);
        console.error("Model Generation Error:", error);
        resultsSummaryDiv.innerHTML = `<p class="text-red-600">Model generation failed: ${error.message}</p>`;
        model.nodes = []; model.fastenerNodes = []; model.layers = []; model.fasteners = [];
        model.layerElements = []; model.beamElements = []; model.contactSpringElements = []; model.rotationalSpringElements = [];
        updateVisualization(); updateLayerSelectors(); updateDisplays();
    }
}

// --- Visualization ---
function updateVisualization(showForces = false) {
    const defs = visualizationSVG.querySelector('defs');
    visualizationSVG.innerHTML = '';
    if (defs) {
        visualizationSVG.appendChild(defs.cloneNode(true));
    } else {
        const defsElement = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        defsElement.innerHTML = `
            <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto" markerUnits="strokeWidth"><polygon points="0 0, 10 3.5, 0 7" fill="red" /></marker>
            <marker id="dispArrowhead" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto" markerUnits="strokeWidth"><polygon points="0 3.5, 10 0, 7 3.5, 10 7" fill="green" /></marker>`;
        visualizationSVG.appendChild(defsElement);
    }

    if (!model.nodes.length) return;

    const numNodeCols = model.numFasteners + 2;
    let maxModelLength = 0;
    const layerLengths = [];

    for (let i = 0; i < model.numLayers; i++) {
        let currentLayerLength = 0;
        for (let j = 0; j < numNodeCols - 1; j++) {
            const element = model.layerElements.find(el => el.layerId === i && getNode(el.node1Id)?.nodeColIndex === j);
            if (element && element.length > 0) {
                currentLayerLength += element.length;
            } else {
                currentLayerLength += model.defaultSegmentLength;
            }
        }
        layerLengths[i] = currentLayerLength;
        if (currentLayerLength > maxModelLength) {
            maxModelLength = currentLayerLength;
        }
    }

    if (maxModelLength <= 0) maxModelLength = model.defaultSegmentLength * (numNodeCols - 1);

    const targetSvgWidth = 800;
    const availableDrawingWidth = targetSvgWidth - 2 * SVG_PADDING;
    const scaleFactor = availableDrawingWidth / maxModelLength;

    for (let i = 0; i < model.numLayers; i++) {
        let currentX = SVG_PADDING;
        const firstNodeIndex = model.nodes.findIndex(n => n.layer === i && n.nodeColIndex === 0);
        if (firstNodeIndex !== -1) {
            model.nodes[firstNodeIndex].x = currentX;

            for (let j = 0; j < numNodeCols - 1; j++) {
                const element = model.layerElements.find(el => el.layerId === i && getNode(el.node1Id)?.nodeColIndex === j);
                const segmentLength = (element && element.length > 0) ? element.length : model.defaultSegmentLength;
                currentX += segmentLength * scaleFactor;

                const nextNodeIndex = model.nodes.findIndex(n => n.layer === i && n.nodeColIndex === j + 1);
                if (nextNodeIndex !== -1) {
                    model.nodes[nextNodeIndex].x = currentX;
                }
            }
        }
    }

    const maxX = Math.max(...model.nodes.map(n => n.x), 0);
    const vbWidth = maxX + SVG_PADDING;
    const vbHeight = (model.numLayers > 1 ? (model.numLayers - 1) * LAYER_SPACING : LAYER_SPACING) + 2 * SVG_PADDING;
    visualizationSVG.setAttribute('viewBox', `0 0 ${vbWidth} ${vbHeight}`);

    // Ensure SVG fits in container
    visualizationSVG.style.height = '100%';
    visualizationSVG.style.width = '100%';

    let minThickness = Infinity;
    if (model.layerElements.length > 0) {
        model.layerElements.forEach(element => {
            if (element.t > 0 && element.t < minThickness) {
                minThickness = element.t;
            }
        });
        if (!isFinite(minThickness) || minThickness <= 0) {
            minThickness = 0.1;
        }
    } else {
        minThickness = 0.1;
    }

    model.layerElements.forEach(el => {
        const node1 = getNode(el.node1Id);
        const node2 = getNode(el.node2Id);
        if (!node1 || !node2) { console.warn(`Nodes not found for Layer El ${el.id}`); return; }

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', node1.x); line.setAttribute('y1', node1.y);
        line.setAttribute('x2', node2.x); line.setAttribute('y2', node2.y);
        line.setAttribute('class', 'layer-element');

        let scaleFactor = 1.0;
        if (minThickness > 0 && el.t > 0) {
            scaleFactor = el.t / minThickness;
        }
        let scaledWidth = BASE_STROKE_WIDTH * scaleFactor;
        scaledWidth = Math.min(scaledWidth, MAX_STROKE_WIDTH);
        scaledWidth = Math.max(scaledWidth, 1);
        line.setAttribute('stroke-width', scaledWidth.toFixed(2));
        visualizationSVG.appendChild(line);

        const clickTargetLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        clickTargetLine.setAttribute('x1', node1.x); clickTargetLine.setAttribute('y1', node1.y);
        clickTargetLine.setAttribute('x2', node2.x); clickTargetLine.setAttribute('y2', node2.y);
        clickTargetLine.setAttribute('class', 'click-target');
        clickTargetLine.dataset.elementType = 'layerElement';
        clickTargetLine.dataset.elementId = el.id;
        clickTargetLine.addEventListener('click', handleElementSelect);
        visualizationSVG.appendChild(clickTargetLine);


        if (selectedElement && selectedElement.type === 'layerElement' && selectedElement.id === el.id) {
            line.classList.add('selected');
        }

        if (showForces && el.force !== undefined && !isNaN(el.force)) {
            const forceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            forceLabel.setAttribute('x', (node1.x + node2.x) / 2);
            forceLabel.setAttribute('y', node1.y - (scaledWidth / 2 + 4));
            forceLabel.setAttribute('class', 'force-label');
            forceLabel.textContent = `${el.force.toFixed(1)} lbf`;
            visualizationSVG.appendChild(forceLabel);
        }
    });

    // Update fastener node positions to match their corresponding layer nodes
    model.fastenerNodes.forEach(fNode => {
        const layerNode = getNode(fNode.correspondingLayerNodeId);
        if (layerNode) {
            fNode.x = layerNode.x + 8; // Slight offset for visibility
            fNode.y = layerNode.y;
        }
    });

    // Draw beam elements (fastener shank segments)
    model.beamElements.forEach(el => {
        const fNode1 = getFastenerNode(el.node1Id);
        const fNode2 = getFastenerNode(el.node2Id);
        if (!fNode1 || !fNode2) { console.warn(`Fastener nodes not found for Beam El ${el.id}`); return; }

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fNode1.x); line.setAttribute('y1', fNode1.y);
        line.setAttribute('x2', fNode2.x); line.setAttribute('y2', fNode2.y);
        line.setAttribute('class', 'beam-element');
        line.setAttribute('stroke', '#22c55e');  // Green
        line.setAttribute('stroke-width', '4');
        visualizationSVG.appendChild(line);

        const clickTargetLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        clickTargetLine.setAttribute('x1', fNode1.x); clickTargetLine.setAttribute('y1', fNode1.y);
        clickTargetLine.setAttribute('x2', fNode2.x); clickTargetLine.setAttribute('y2', fNode2.y);
        clickTargetLine.setAttribute('class', 'click-target');
        clickTargetLine.dataset.elementType = 'beamElement';
        clickTargetLine.dataset.elementId = el.id;
        clickTargetLine.addEventListener('click', handleElementSelect);
        visualizationSVG.appendChild(clickTargetLine);

        if (selectedElement && selectedElement.type === 'beamElement' && selectedElement.id === el.id) {
            line.classList.add('selected');
        }

        if (showForces && el.force !== undefined && !isNaN(el.force)) {
            const forceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            forceLabel.setAttribute('x', fNode1.x + 10);
            forceLabel.setAttribute('y', (fNode1.y + fNode2.y) / 2);
            forceLabel.setAttribute('class', 'force-label');
            forceLabel.setAttribute('fill', '#22c55e');
            forceLabel.textContent = `${el.force.toFixed(1)} lbf`;
            visualizationSVG.appendChild(forceLabel);
        }
    });

    // Draw contact springs (layer node to fastener node connections)
    model.contactSpringElements.forEach(el => {
        const layerNode = getNode(el.layerNodeId);
        const fNode = getFastenerNode(el.fastenerNodeId);
        if (!layerNode || !fNode) { console.warn(`Nodes not found for Contact Spring ${el.id}`); return; }

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', layerNode.x); line.setAttribute('y1', layerNode.y);
        line.setAttribute('x2', fNode.x); line.setAttribute('y2', fNode.y);
        line.setAttribute('class', 'contact-spring');
        line.setAttribute('stroke', '#f59e0b');  // Amber/orange
        line.setAttribute('stroke-width', '2');
        line.setAttribute('stroke-dasharray', '3,2');
        visualizationSVG.appendChild(line);
    });

    const actualRightmostNodeX = Math.max(...model.nodes.map(n => n.x));

    model.nodes.forEach(node => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', node.x); circle.setAttribute('cy', node.y);
        circle.setAttribute('class', 'node');
        circle.setAttribute('fill', 'blue');
        circle.setAttribute('r', '5');
        circle.dataset.nodeId = node.id;

        circle.removeAttribute('style');
        circle.removeAttribute('stroke');
        circle.removeAttribute('stroke-width');

        if (node.isFixed) {
            circle.setAttribute('style', 'fill: red;');
        }
        if (node.F !== 0 && node.prescribedU === null) {
            circle.setAttribute('stroke', 'red');
            circle.setAttribute('stroke-width', '2');
        }
        if (node.prescribedU !== null) {
            circle.setAttribute('stroke', 'green');
            circle.setAttribute('stroke-width', '2');
        }

        if (Math.abs(node.x - actualRightmostNodeX) < 1e-6) {
            if (node.prescribedU !== null) {
                const dispArrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                const arrowStartX = node.x + LOAD_ARROW_OFFSET;
                const arrowEndX = node.x + LOAD_ARROW_OFFSET + LOAD_ARROW_LENGTH;
                dispArrow.setAttribute('x1', arrowStartX); dispArrow.setAttribute('y1', node.y);
                dispArrow.setAttribute('x2', arrowEndX); dispArrow.setAttribute('y2', node.y);
                dispArrow.setAttribute('class', 'disp-arrow');
                visualizationSVG.appendChild(dispArrow);
                const dispLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                dispLabel.setAttribute('x', arrowEndX + 5);
                dispLabel.setAttribute('y', node.y - 4);
                dispLabel.setAttribute('class', 'force-label'); dispLabel.setAttribute('fill', 'green');
                dispLabel.textContent = `${node.prescribedU.toExponential(2)} in`;
                visualizationSVG.appendChild(dispLabel);
            } else if (node.F !== 0) {
                const loadArrow = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                const arrowStartX = node.x + LOAD_ARROW_OFFSET;
                const arrowEndX = node.x + LOAD_ARROW_OFFSET + LOAD_ARROW_LENGTH;
                loadArrow.setAttribute('x1', arrowStartX); loadArrow.setAttribute('y1', node.y);
                loadArrow.setAttribute('x2', arrowEndX); loadArrow.setAttribute('y2', node.y);
                loadArrow.setAttribute('class', 'load-arrow');
                visualizationSVG.appendChild(loadArrow);
                const loadLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                loadLabel.setAttribute('x', arrowEndX + 5);
                loadLabel.setAttribute('y', node.y - 4);
                loadLabel.setAttribute('class', 'force-label'); loadLabel.setAttribute('fill', 'red');
                loadLabel.textContent = `${node.F.toFixed(0)} lbf`;
                visualizationSVG.appendChild(loadLabel);
            }
        }
        visualizationSVG.appendChild(circle);
    });

    // Draw fastener nodes (purple circles, slightly offset)
    model.fastenerNodes.forEach(fNode => {
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', fNode.x);
        circle.setAttribute('cy', fNode.y);
        circle.setAttribute('class', 'fastener-node');
        circle.setAttribute('fill', '#9333ea');  // Purple
        circle.setAttribute('r', '4');
        circle.dataset.fastenerNodeId = fNode.id;
        visualizationSVG.appendChild(circle);
    });

    model.layers.forEach(layer => {
        const nodesInLayer = model.nodes.filter(n => n.layer === layer.id);
        if (nodesInLayer.length > 0) {
            let leftmostNodeInLayer = nodesInLayer[0];
            for (let i = 1; i < nodesInLayer.length; i++) {
                if (nodesInLayer[i].nodeColIndex < leftmostNodeInLayer.nodeColIndex) {
                    leftmostNodeInLayer = nodesInLayer[i];
                }
            }
            const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            label.setAttribute('x', SVG_PADDING - 10);
            label.setAttribute('y', leftmostNodeInLayer.y);
            label.setAttribute('class', 'layer-name-label');
            label.textContent = layer.name;
            visualizationSVG.appendChild(label);
        }
    });
}

// --- Element Selection & Editing ---
function handleElementSelect(event) {
    const target = event.currentTarget;
    const type = target.dataset.elementType;
    const id = parseInt(target.dataset.elementId);
    if (!type || isNaN(id)) { console.error("Invalid element data:", target.dataset); return; }
    deselectElement();
    selectedElement = { type, id };
    console.log("Selected:", selectedElement);
    populateEditor();
    elementEditorDiv.classList.remove('hidden');
    updateVisualization();
}

function deselectElement() {
    if (selectedElement) {
        selectedElement = null;
        elementEditorDiv.classList.add('hidden');
        updateVisualization();
    }
}

function populateEditor() {
    if (!selectedElement) return;
    editorContent.innerHTML = '';
    let element, layer, fastener;

    try {
        switch (selectedElement.type) {
            case 'layerElement':
                element = getLayerElement(selectedElement.id);
                if (!element) throw new Error(`Layer Element ${selectedElement.id} not found.`);
                layer = getLayer(element.layerId);
                if (!layer) throw new Error(`Layer ${element.layerId} not found.`);
                editorTitle.textContent = `Edit Element ${element.id} (${layer.name})`;

                let materialOptions = '';
                Object.keys(MATERIALS).forEach(matName => {
                    materialOptions += `<option value='${matName}' ${element.materialName === matName ? 'selected' : ''}>${matName}</option>`;
                });

                editorContent.innerHTML = `
                    <div>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Material</label>
                    <select id='edit-layer-material' class='input-field text-sm py-1'>${materialOptions}</select>
                    </div>
                    <div class='grid grid-cols-3 gap-2'>
                    <div>
                        <label class='block text-xs text-gray-500 mb-1'>W (in)</label>
                        <input type='number' id='edit-layer-W' value='${element.W}' min='0.001' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    <div>
                        <label class='block text-xs text-gray-500 mb-1'>t (in)</label>
                        <input type='number' id='edit-layer-thickness' value='${element.t}' min='0.001' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    <div>
                        <label class='block text-xs text-gray-500 mb-1'>L (in)</label>
                        <input type='number' id='edit-layer-length' value='${element.length}' min='0.001' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    </div>
                    <div class='mt-2 flex items-start'>
                    <input type='checkbox' id='edit-apply-to-layer' checked class='mt-1 mr-2 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500'>
                    <label for='edit-apply-to-layer' class='text-xs text-gray-600 leading-tight'>Apply Material, W, t to entire Layer?</label>
                    </div>
                    <div class='mt-2 p-2 bg-yellow-100 rounded text-xs text-yellow-800'>
                    <p>k = ${(element.stiffness / 1000).toFixed(2)} kip/in</p>
                    <p class='opacity-75 text-[10px] mt-0.5'>Length change applies to column.</p>
                    </div>`;
                break;

            case 'fastenerElement':
                element = getFastenerElement(selectedElement.id);
                if (!element) throw new Error(`Fastener Element ${selectedElement.id} not found.`);
                fastener = getFastener(element.fastenerId);
                if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                editorTitle.textContent = `Edit Fastener ${element.id} (Col ${element.fastenerId})`;
                editorContent.innerHTML = `
                    <div>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Diameter (in)</label>
                    <input type='number' id='edit-fastener-diameter' value='${fastener.diameter}' min='0.01' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    <div class='mt-2 p-2 bg-yellow-100 rounded text-xs text-yellow-800'>
                    <p>k = ${(element.stiffness / 1000).toFixed(2)} kip/in</p>
                    <p class='opacity-75 text-[10px] mt-0.5'>Updates entire fastener column.</p>
                    </div>`;
                break;

            default:
                throw new Error(`Unknown element type selected: ${selectedElement.type}`);
        }
    } catch (error) {
        showMessage(`Error populating editor: ${error.message}`);
        console.error("Editor Population Error:", error);
        deselectElement();
    }
}

function updateElementProperties() {
    if (!selectedElement) { showMessage("No element selected to update."); return; }
    try {
        let propsChanged = false;

        switch (selectedElement.type) {
            case 'layerElement': {
                const element = getLayerElement(selectedElement.id); if (!element) throw new Error(`Layer Element ${selectedElement.id} not found.`);
                const layer = getLayer(element.layerId); if (!layer) throw new Error(`Layer ${element.layerId} not found.`);
                const applyToLayer = document.getElementById('edit-apply-to-layer').checked;

                const newMaterialName = document.getElementById('edit-layer-material').value;
                const newW_in = parseFloat(document.getElementById('edit-layer-W').value);
                const newT_in = parseFloat(document.getElementById('edit-layer-thickness').value);
                const newLength_in = parseFloat(document.getElementById('edit-layer-length').value);
                if (!MATERIALS[newMaterialName] || isNaN(newW_in) || isNaN(newT_in) || isNaN(newLength_in) || newW_in <= 0 || newT_in <= 0 || newLength_in <= 0) {
                    throw new Error("Invalid input values. Check Material, W, t, L.");
                }

                if (applyToLayer) {
                    model.layerElements.forEach(el => {
                        if (el.layerId === element.layerId) {
                            if (el.materialName !== newMaterialName || el.W !== newW_in || el.t !== newT_in) {
                                el.materialName = newMaterialName;
                                el.W = newW_in;
                                el.t = newT_in;
                                propsChanged = true;
                            }
                        }
                    });
                    if (propsChanged) console.log(`Updated Layer ${layer.id} props (Material/W/t) for all its elements.`);

                } else {
                    if (element.materialName !== newMaterialName || element.W !== newW_in || element.t !== newT_in) {
                        element.materialName = newMaterialName;
                        element.W = newW_in;
                        element.t = newT_in;
                        propsChanged = true;
                        console.log(`Updated props for single Layer Element ${element.id}.`);
                    }
                }

                const node1 = getNode(element.node1Id);
                if (!node1) throw new Error(`Node ${element.node1Id} not found for element ${element.id}`);
                const colIdx = node1.nodeColIndex;

                let lengthChangedInThisColumn = false;
                model.layerElements.forEach(el => {
                    const elNode1 = getNode(el.node1Id);
                    if (elNode1 && elNode1.nodeColIndex === colIdx) {
                        if (el.length !== newLength_in) {
                            el.length = newLength_in;
                            lengthChangedInThisColumn = true;
                        }
                    }
                });

                if (lengthChangedInThisColumn) {
                    propsChanged = true;
                    console.log(`Updated length for column ${colIdx} to ${newLength_in}.`);
                }

                break;
            }
            case 'fastenerElement': {
                const element = getFastenerElement(selectedElement.id); if (!element) throw new Error(`Fastener Element ${selectedElement.id} not found.`);
                const fastener = getFastener(element.fastenerId); if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                const newD_in = parseFloat(document.getElementById('edit-fastener-diameter').value);
                if (isNaN(newD_in) || newD_in <= 0) {
                    throw new Error("Invalid input value for diameter.");
                }

                if (fastener.diameter !== newD_in) {
                    fastener.diameter = newD_in;
                    propsChanged = true;
                    console.log(`Updated Fastener Column ${fastener.id} diameter.`);
                }
                break;
            }
            default:
                throw new Error(`Unknown element type: ${selectedElement.type}`);
        }

        if (propsChanged) {
            showMessage("Element properties updated.", false);
            resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Model properties updated. Please re-solve.</p>';
            updateVisualization(false);
            populateEditor();
        } else {
            showMessage("No changes detected in properties.", false);
        }
    } catch (error) {
        showMessage(`Error updating properties: ${error.message}`);
        console.error("Update Error:", error);
    }
}

function cleanupOrphanedNodes() {
    console.log("DEBUG: Starting orphan node cleanup...");
    if (model.nodes.length === 0) {
        console.log("DEBUG: No nodes to clean up.");
        return false;
    }

    const connectedNodeIds = new Set();
    model.layerElements.forEach(el => {
        connectedNodeIds.add(el.node1Id);
        connectedNodeIds.add(el.node2Id);
    });
    model.fastenerElements.forEach(el => {
        connectedNodeIds.add(el.node1Id);
        connectedNodeIds.add(el.node2Id);
    });
    console.log("DEBUG: Connected Node IDs:", connectedNodeIds);

    const originalNodeCount = model.nodes.length;
    model.nodes = model.nodes.filter(node => {
        const isConnected = connectedNodeIds.has(node.id);
        if (!isConnected) {
            console.log(`DEBUG: Removing orphaned node ${node.id} (Layer ${node.layer})`);
        }
        return isConnected;
    });
    const removedCount = originalNodeCount - model.nodes.length;
    if (removedCount > 0) {
        console.log(`DEBUG: Removed ${removedCount} orphaned node(s).`);
        showMessage(`Removed ${removedCount} unconnected node(s).`, false);
        updateDisplays();
        return true;
    } else {
        console.log("DEBUG: No orphaned nodes found to remove.");
        return false;
    }
}

function handleDeleteElement() {
    console.log('handleDeleteElement called. Current selectedElement:', selectedElement);

    if (!selectedElement || selectedElement.id == null || !selectedElement.type) {
        console.error("Delete called with invalid selectedElement state:", selectedElement);
        showMessage("Error: No valid element selected for deletion.");
        return;
    }

    const type = selectedElement.type;
    const id = selectedElement.id;

    const confirmed = window.confirm(`Are you sure you want to delete ${type} ${id}?\n\nThis action cannot be undone and may remove associated nodes if they become unconnected.`);
    if (!confirmed) {
        console.log("DEBUG: Deletion cancelled by user.");
        return;
    }

    console.log(`DEBUG: Proceeding with deletion logic for ${type} ${id}`);
    try {
        let index = -1;
        let deleted = false;
        let arrayToModify = null;

        if (type === 'layerElement') {
            arrayToModify = model.layerElements;
        } else if (type === 'fastenerElement') {
            arrayToModify = model.fastenerElements;
        } else {
            throw new Error("Cannot delete this type of element.");
        }

        console.log(`DEBUG: Searching for index of id ${id} in array:`, arrayToModify);
        index = arrayToModify.findIndex(el => el.id === id);
        console.log(`DEBUG: findIndex result: ${index}`);

        if (index > -1) {
            console.log(`DEBUG: Splicing element at index ${index}`);
            const deletedItem = arrayToModify.splice(index, 1);
            console.log(`DEBUG: Splice complete. Array length now: ${arrayToModify.length}`, deletedItem);
            deleted = true;
        } else {
            console.error(`${type} ${id} not found in array for deletion. Current elements:`, arrayToModify);
            throw new Error(`${type} ${id} not found for deletion.`);
        }

        if (deleted) {
            const deletedInfo = `${type} ${id}`;
            const nodesWereRemoved = cleanupOrphanedNodes();
            if (nodesWereRemoved) {
                updateLayerSelectors();
            }
            deselectElement();
            resultsSummaryDiv.innerHTML = `<p class="text-orange-600">Element ${deletedInfo} deleted. Unconnected nodes removed. Please re-solve if necessary.</p>`;
            showMessage(`Element ${deletedInfo} deleted.`, false);
            console.log("Deletion successful, orphaned nodes cleaned, visualization updated.");
        }

    } catch (error) {
        showMessage(`Error during deletion process: ${error.message}`);
        console.error("Deletion Error:", error);
        deselectElement();
    }
}

function applyGlobalLayerProperties() {
    try {
        const globalMaterialName = globalLayerMaterialSelect.value;
        const globalW_in = parseFloat(globalLayerWInput.value);
        const globalThickness_in = parseFloat(globalLayerThicknessInput.value);
        if (!MATERIALS[globalMaterialName] || isNaN(globalW_in) || isNaN(globalThickness_in) || globalW_in <= 0 || globalThickness_in <= 0) {
            throw new Error("Invalid global layer inputs. Check Material, W, t.");
        }

        let layerPropsChanged = false;
        model.layerElements.forEach(el => {
            if (el.materialName !== globalMaterialName || el.W !== globalW_in || el.t !== globalThickness_in) {
                el.materialName = globalMaterialName;
                el.W = globalW_in;
                el.t = globalThickness_in;
                layerPropsChanged = true;
            }
        });

        if (layerPropsChanged) {
            showMessage("Global layer properties applied.", false);
            if (selectedElement && selectedElement.type === 'layerElement') {
                populateEditor();
            }
            resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Global layer properties updated. Please re-solve.</p>';
            updateVisualization(false);
        } else {
            showMessage("No changes detected in global layer properties.", false);
        }
    } catch (error) {
        showMessage(`Error applying global layer props: ${error.message}`);
        console.error("Global Layer Props Error:", error);
    }
}

function applyGlobalFastenerProperties() {
    try {
        const globalFastenerMatName = globalFastenerMaterialSelect.value;
        const globalDiameter_in = parseFloat(globalFastenerDiameterInput.value);

        if (!MATERIALS[globalFastenerMatName] || isNaN(globalDiameter_in) ||
            globalDiameter_in <= 0) {
            throw new Error("Invalid global fastener inputs. Check Material and Diameter.");
        }

        let propsChanged = false;
        if (model.fastenerMaterialName !== globalFastenerMatName) {
            model.fastenerMaterialName = globalFastenerMatName;
            propsChanged = true;
            console.log("Updated global Fastener Material to:", globalFastenerMatName);
        }

        model.fasteners.forEach(fastener => {
            if (fastener.diameter !== globalDiameter_in) {
                fastener.diameter = globalDiameter_in;
                propsChanged = true;
            }
        });

        if (propsChanged) {
            showMessage("Global fastener properties applied.", false);
            if (selectedElement && selectedElement.type === 'fastenerElement') {
                populateEditor();
            }
            resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Global fastener properties updated. Please re-solve.</p>';
            updateVisualization(false);
        } else {
            showMessage("No changes detected in global fastener properties.", false);
        }

    } catch (error) {
        showMessage(`Error applying global fastener props: ${error.message}`);
        console.error("Global Fastener Props Error:", error);
    }
}

function renameLayer() {
    const layerId = parseInt(renameLayerSelect.value);
    const newName = renameLayerNewNameInput.value.trim();

    if (isNaN(layerId)) {
        showMessage("Please select a layer to rename.");
        return;
    }
    if (!newName) {
        showMessage("Please enter a valid new name for the layer.");
        renameLayerNewNameInput.focus();
        return;
    }

    const layer = getLayer(layerId);
    if (layer) {
        const oldName = layer.name;
        layer.name = newName;
        console.log(`Renamed Layer ${layerId} from "${oldName}" to "${newName}"`);
        showMessage(`Layer "${oldName}" renamed to "${newName}".`, false);

        updateLayerSelectors();
        updateVisualization();
        updateDisplays();
        if (selectedElement && selectedElement.type === 'layerElement' && getLayerElement(selectedElement.id)?.layerId === layerId) {
            populateEditor();
        }
        renameLayerNewNameInput.value = '';
    } else {
        showMessage(`Error: Layer with ID ${layerId} not found.`);
    }
}

function updateLayerSelectors() {
    const selectsToUpdate = [
        { select: bcLayerSelect, placeholder: "N/A (No Layers)" },
        { select: loadLayerSelect, placeholder: "N/A" },
        { select: dispLayerSelect, placeholder: "N/A" },
        { select: renameLayerSelect, placeholder: "Select Layer" },
        { select: globalLayerMaterialSelect, placeholder: null },
        { select: globalFastenerMaterialSelect, placeholder: null }
    ];

    globalLayerMaterialSelect.innerHTML = '';
    globalFastenerMaterialSelect.innerHTML = '';
    Object.keys(MATERIALS).forEach(matName => {
        const option = document.createElement('option');
        option.value = matName;
        option.textContent = matName;
        if (matName === "Steel") {
            option.selected = true;
        }
        globalLayerMaterialSelect.appendChild(option.cloneNode(true));
        globalFastenerMaterialSelect.appendChild(option.cloneNode(true));
    });
    model.fastenerMaterialName = globalFastenerMaterialSelect.value;


    selectsToUpdate.forEach(item => {
        if (item.select !== globalLayerMaterialSelect && item.select !== globalFastenerMaterialSelect) {
            item.select.innerHTML = '';
        }
    });

    if (model.layers.length > 0) {
        const sortedLayers = [...model.layers].sort((a, b) => a.id - b.id);

        sortedLayers.forEach(layer => {
            const option = document.createElement('option');
            option.value = layer.id;
            option.textContent = layer.name;

            selectsToUpdate.forEach(item => {
                if (item.select !== globalLayerMaterialSelect && item.select !== globalFastenerMaterialSelect) {
                    const hasNodes = model.nodes.some(node => node.layer === layer.id);
                    if (item.select === renameLayerSelect || hasNodes) {
                        item.select.appendChild(option.cloneNode(true));
                    }
                }
            });
        });

        selectsToUpdate.forEach(item => {
            if (item.select !== renameLayerSelect && item.select !== globalLayerMaterialSelect && item.select !== globalFastenerMaterialSelect && item.select.options.length === 0) {
                const optionPlaceholder = document.createElement('option');
                optionPlaceholder.textContent = item.placeholder;
                optionPlaceholder.value = "";
                optionPlaceholder.disabled = true;
                optionPlaceholder.selected = true;
                item.select.appendChild(optionPlaceholder);
            } else if (item.select === renameLayerSelect && item.select.options.length === 0) {
                const optionPlaceholder = document.createElement('option');
                optionPlaceholder.textContent = item.placeholder;
                optionPlaceholder.value = "";
                optionPlaceholder.disabled = true;
                optionPlaceholder.selected = true;
                item.select.appendChild(optionPlaceholder);
            }
        });

    } else {
        selectsToUpdate.forEach(item => {
            if (item.select !== globalLayerMaterialSelect && item.select !== globalFastenerMaterialSelect) {
                const optionPlaceholder = document.createElement('option');
                optionPlaceholder.textContent = item.placeholder;
                optionPlaceholder.value = "";
                optionPlaceholder.disabled = true;
                optionPlaceholder.selected = true;
                item.select.appendChild(optionPlaceholder);
            }
        });
    }
}

function setBoundaryCondition(fix) {
    if (!model.nodes.length) { showMessage("Generate model first or no nodes remaining."); return; }
    const layerId = parseInt(bcLayerSelect.value);
    if (isNaN(layerId) || !model.nodes.some(n => n.layer === layerId)) {
        showMessage("Selected layer does not exist or has no nodes."); return;
    }

    const leftNode = model.nodes.find(n => n.layer === layerId && n.nodeColIndex === 0);
    const layer = getLayer(layerId);
    const layerName = layer ? layer.name : `Layer ${layerId}`;

    if (leftNode) {
        const nodeId = leftNode.id;
        if (leftNode.isFixed !== fix) {
            leftNode.isFixed = fix;
            console.log(`Node ${nodeId} (${layerName}, Left Edge) ${fix ? 'fixed' : 'unfixed'}.`);
            updateVisualization();
            updateDisplays();
            resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Boundary conditions changed. Please re-solve.</p>';
        } else {
            showMessage(`Node ${nodeId} (${layerName}) is already ${fix ? 'fixed' : 'unfixed'}.`, false);
        }
    } else {
        showMessage(`Leftmost node for ${layerName} not found (may have been removed).`);
        console.warn(`Leftmost node for Layer ${layerId} not found in setBoundaryCondition`);
    }
}

function applyLoad(apply) {
    if (!model.nodes.length) { showMessage("Generate model first or no nodes remaining."); return; }
    const layerId = parseInt(loadLayerSelect.value);
    if (isNaN(layerId) || !model.nodes.some(n => n.layer === layerId)) {
        showMessage("Selected layer does not exist or has no nodes for Load."); return;
    }

    const layerNodes = model.nodes.filter(n => n.layer === layerId);
    if (layerNodes.length === 0) {
        showMessage(`No nodes found for Layer ${layerId}.`); return;
    }
    const maxColIndex = Math.max(...layerNodes.map(n => n.nodeColIndex));
    const rightNode = layerNodes.find(n => n.nodeColIndex === maxColIndex);
    const layer = getLayer(layerId);
    const layerName = layer ? layer.name : `Layer ${layerId}`;

    if (rightNode) {
        const nodeId = rightNode.id;
        if (apply) {
            const loadValue_lbf = parseFloat(loadValueInput.value);
            if (isNaN(loadValue_lbf)) { showMessage("Invalid load value entered."); return; }
            if (rightNode.F !== loadValue_lbf || rightNode.prescribedU !== null) {
                rightNode.F = loadValue_lbf;
                rightNode.prescribedU = null;
                console.log(`Load ${loadValue_lbf} lbf applied to Node ${nodeId} (${layerName}, Rightmost Edge).`);
                updateVisualization(); updateDisplays();
                resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Loads changed. Please re-solve.</p>';
            } else {
                showMessage(`Load on Node ${nodeId} (${layerName}) is already ${loadValue_lbf} lbf.`, false);
            }
        } else { // Remove load
            if (rightNode.F !== 0) {
                rightNode.F = 0;
                console.log(`Load removed from Node ${nodeId} (${layerName}).`);
                updateVisualization(); updateDisplays();
                resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Loads changed. Please re-solve.</p>';
            } else {
                showMessage(`No load to remove from Node ${nodeId} (${layerName}).`, false);
            }
        }
    } else {
        showMessage(`Error: Rightmost node for ${layerName} not found (may have been removed).`);
        console.warn(`Rightmost node for Layer ${layerId} not found in applyLoad`);
    }
}

function applyDisplacement(apply) {
    if (!model.nodes.length) { showMessage("Generate model first or no nodes remaining."); return; }
    const layerId = parseInt(dispLayerSelect.value);
    if (isNaN(layerId) || !model.nodes.some(n => n.layer === layerId)) {
        showMessage("Selected layer does not exist or has no nodes for Displacement BC."); return;
    }

    const layerNodes = model.nodes.filter(n => n.layer === layerId);
    if (layerNodes.length === 0) {
        showMessage(`No nodes found for Layer ${layerId}.`); return;
    }
    const maxColIndex = Math.max(...layerNodes.map(n => n.nodeColIndex));
    const rightNode = layerNodes.find(n => n.nodeColIndex === maxColIndex);
    const layer = getLayer(layerId);
    const layerName = layer ? layer.name : `Layer ${layerId}`;

    if (rightNode) {
        const nodeId = rightNode.id;
        if (apply) {
            const dispValue_in = parseFloat(dispValueInput.value);
            if (isNaN(dispValue_in)) { showMessage("Invalid displacement value entered."); return; }
            if (rightNode.prescribedU !== dispValue_in || rightNode.F !== 0) {
                rightNode.prescribedU = dispValue_in;
                rightNode.F = 0;
                console.log(`Displacement ${dispValue_in} in applied to Node ${nodeId} (${layerName}, Rightmost Edge).`);
                updateVisualization(); updateDisplays();
                resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Displacement BCs changed. Please re-solve.</p>';
            } else {
                showMessage(`Displacement BC on Node ${nodeId} (${layerName}) is already ${dispValue_in} in.`, false);
            }
        } else { // Remove displacement BC
            if (rightNode.prescribedU !== null) {
                rightNode.prescribedU = null;
                console.log(`Displacement BC removed from Node ${nodeId} (${layerName}).`);
                updateVisualization(); updateDisplays();
                resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Displacement BCs changed. Please re-solve.</p>';
            } else {
                showMessage(`No displacement BC to remove from Node ${nodeId} (${layerName}).`, false);
            }
        }
    } else {
        showMessage(`Error: Rightmost node for ${layerName} not found (may have been removed).`);
        console.warn(`Rightmost node for Layer ${layerId} not found in applyDisplacement`);
    }
}

function updateDisplays() {
    const fixedNodeInfo = model.nodes
        .filter(n => n.isFixed)
        .map(n => {
            const layer = getLayer(n.layer);
            return layer ? layer.name : `L${n.layer}`;
        });
    fixedNodesDisplay.textContent = fixedNodeInfo.length > 0 ? `Fixed Nodes: ${fixedNodeInfo.join(', ')}` : 'Fixed Nodes: None';

    const loadedNodeInfo = model.nodes
        .filter(n => n.F !== 0 && n.prescribedU === null)
        .map(n => {
            const layer = getLayer(n.layer);
            const layerName = layer ? layer.name : `L${n.layer}`;
            return `${layerName} (${n.F.toFixed(1)} lbf)`;
        });
    appliedLoadsDisplay.textContent = loadedNodeInfo.length > 0 ? `Applied Loads: ${loadedNodeInfo.join(', ')}` : 'Applied Loads: None';

    const displacedNodeInfo = model.nodes
        .filter(n => n.prescribedU !== null)
        .map(n => {
            const layer = getLayer(n.layer);
            const layerName = layer ? layer.name : `L${n.layer}`;
            return `${layerName} (${n.prescribedU.toExponential(2)} in)`;
        });
    appliedDispsDisplay.textContent = displacedNodeInfo.length > 0 ? `Applied Displacements: ${displacedNodeInfo.join(', ')}` : 'Applied Displacements: None';
}

// --- Solver ---
function solve() {
    console.log("Starting solver with beam + contact spring topology...");
    resultsSummaryDiv.innerHTML = '<p>Solving...</p>';
    updateVisualization(false);

    // Delay to allow UI to update
    setTimeout(() => {
        try {
            if (model.nodes.length === 0) throw new Error("No nodes in model to solve.");

            // 1. Assign Degrees of Freedom (DOF)
            // Layer nodes: 1 DOF each (u - translation)
            // Fastener nodes: 2 DOFs each (u - translation, theta - rotation)
            let dofCounter = 0;
            const layerNodeDofMap = new Map();  // nodeId -> { u_dof }
            const fastenerNodeDofMap = new Map();  // nodeId -> { u_dof, theta_dof }

            model.nodes.forEach(node => {
                layerNodeDofMap.set(node.id, { u_dof: dofCounter++ });
            });

            model.fastenerNodes.forEach(fNode => {
                fastenerNodeDofMap.set(fNode.id, {
                    u_dof: dofCounter++,
                    theta_dof: dofCounter++
                });
            });

            const N_solve = dofCounter;
            console.log(`System DOF: ${N_solve} (${model.nodes.length} layer nodes + ${model.fastenerNodes.length} fastener nodes × 2)`);

            // 2. Initialize Global Stiffness Matrix (K) and Force Vector (F)
            let K_global = math.zeros(N_solve, N_solve, 'sparse');
            let F_global = math.zeros(N_solve);

            // Helper function to add to sparse matrix
            const addToK = (i, j, val) => {
                if (i < 0 || j < 0 || i >= N_solve || j >= N_solve) return;
                const current = math.subset(K_global, math.index(i, j));
                K_global = math.subset(K_global, math.index(i, j), (current || 0) + val);
            };

            // 3. Assemble Stiffness Matrix
            console.log("Assembling Global Stiffness Matrix K...");

            // 3a. Layer elements (axial springs between layer nodes)
            model.layerElements.forEach(el => {
                const dof1 = layerNodeDofMap.get(el.node1Id);
                const dof2 = layerNodeDofMap.get(el.node2Id);
                if (!dof1 || !dof2) {
                    throw new Error(`DOF not found for Layer Element ${el.id}.`);
                }

                const k = calculateLayerElementStiffness(el);
                el.stiffness = k;

                if (isNaN(k) || !isFinite(k)) {
                    throw new Error(`Invalid stiffness for Layer Element ${el.id} (k=${k}).`);
                }

                const i = dof1.u_dof;
                const j = dof2.u_dof;
                addToK(i, i, k);
                addToK(j, j, k);
                addToK(i, j, -k);
                addToK(j, i, -k);
            });

            // 3b. Beam elements (Timoshenko beams between fastener nodes)
            model.beamElements.forEach(el => {
                const dof1 = fastenerNodeDofMap.get(el.node1Id);
                const dof2 = fastenerNodeDofMap.get(el.node2Id);
                if (!dof1 || !dof2) {
                    throw new Error(`DOF not found for Beam Element ${el.id}.`);
                }

                const beamResult = calculateBeamElementStiffnessMatrix(el);
                if (!beamResult || !beamResult.matrix) {
                    console.warn(`Could not calculate beam stiffness for Element ${el.id}, skipping`);
                    return;  // Skip this element
                }

                const kMatrix = beamResult.matrix;
                // DOF order: [u_i, theta_i, u_j, theta_j]
                const dofs = [dof1.u_dof, dof1.theta_dof, dof2.u_dof, dof2.theta_dof];

                for (let r = 0; r < 4; r++) {
                    for (let c = 0; c < 4; c++) {
                        addToK(dofs[r], dofs[c], kMatrix[r][c]);
                    }
                }
            });

            // 3c. Contact springs (shear springs between layer node and fastener node)
            model.contactSpringElements.forEach(el => {
                const layerDof = layerNodeDofMap.get(el.layerNodeId);
                const fastenerDof = fastenerNodeDofMap.get(el.fastenerNodeId);
                if (!layerDof || !fastenerDof) {
                    throw new Error(`DOF not found for Contact Spring ${el.id}.`);
                }

                const k = calculateContactSpringStiffness(el);
                el.stiffness = k;

                if (isNaN(k) || !isFinite(k) || k <= 0) {
                    console.warn(`Invalid contact spring stiffness for ${el.id}, using 1e12`);
                    el.stiffness = 1e12;
                }

                const i = layerDof.u_dof;
                const j = fastenerDof.u_dof;
                addToK(i, i, el.stiffness);
                addToK(j, j, el.stiffness);
                addToK(i, j, -el.stiffness);
                addToK(j, i, -el.stiffness);
            });

            // 3d. Rotational springs (grounded at each fastener node theta DOF)
            model.rotationalSpringElements.forEach(el => {
                const fastenerDof = fastenerNodeDofMap.get(el.fastenerNodeId);
                if (!fastenerDof) {
                    throw new Error(`DOF not found for Rotational Spring ${el.id}.`);
                }

                const k_theta = calculateRotationalSpringStiffness(el);
                el.stiffness = k_theta;

                if (isNaN(k_theta) || !isFinite(k_theta) || k_theta < 0) {
                    console.warn(`Invalid rotational spring stiffness for ${el.id}, using 0`);
                    el.stiffness = 0;
                }

                // Grounded spring: only adds to diagonal of theta DOF
                const theta_idx = fastenerDof.theta_dof;
                addToK(theta_idx, theta_idx, el.stiffness);
            });

            // 4. Assemble Force Vector
            console.log("Assembling Global Force Vector F (lbf)...");
            model.nodes.forEach(node => {
                if (node.F !== 0 && node.prescribedU === null) {
                    const dof = layerNodeDofMap.get(node.id);
                    if (!dof) {
                        throw new Error(`DOF not found for Force application at Node ${node.id}.`);
                    }
                    const currentF = math.subset(F_global, math.index(dof.u_dof));
                    F_global = math.subset(F_global, math.index(dof.u_dof), (currentF || 0) + node.F);
                }
            });

            // 5. Apply Boundary Conditions (Penalty Method)
            console.log("Applying Boundary Conditions (Penalty Method)...");
            let max_diag = 0;
            for (let i = 0; i < N_solve; i++) {
                const diagVal = math.subset(K_global, math.index(i, i));
                if (typeof diagVal === 'number' && isFinite(diagVal)) {
                    max_diag = Math.max(max_diag, Math.abs(diagVal));
                }
            }
            const penaltyStiffness = max_diag > 1e-9 ? max_diag * 1e8 : 1e8;
            console.log("Penalty Stiffness:", penaltyStiffness.toExponential(3));

            let constrainedCount = 0;
            model.nodes.forEach(node => {
                const dof = layerNodeDofMap.get(node.id);
                if (!dof) return;

                let applyPenalty = false;
                let prescribedDisp = 0;

                if (node.isFixed) {
                    applyPenalty = true;
                    prescribedDisp = 0;
                    constrainedCount++;
                } else if (node.prescribedU !== null) {
                    applyPenalty = true;
                    prescribedDisp = node.prescribedU;
                    constrainedCount++;
                }

                if (applyPenalty) {
                    const idx = dof.u_dof;
                    addToK(idx, idx, penaltyStiffness);
                    const currentF = math.subset(F_global, math.index(idx));
                    F_global = math.subset(F_global, math.index(idx), (currentF || 0) + penaltyStiffness * prescribedDisp);
                }
            });

            if (constrainedCount === 0) {
                throw new Error("Solver Error: No boundary conditions applied.");
            }
            console.log(`Applied BCs to ${constrainedCount} nodes.`);

            // 6. Solve KU = F
            console.log("Solving KU=F using LU decomposition...");
            const F_col_vector = math.reshape(F_global, [N_solve, 1]);
            const U_solution_matrix = math.lusolve(K_global, F_col_vector);
            console.log("Solver finished.");

            // 7. Extract displacements
            model.nodes.forEach(node => {
                const dof = layerNodeDofMap.get(node.id);
                if (dof) {
                    const displacement = U_solution_matrix.get([dof.u_dof, 0]);
                    node.u = isFinite(displacement) ? displacement : 0;
                }
            });

            model.fastenerNodes.forEach(fNode => {
                const dof = fastenerNodeDofMap.get(fNode.id);
                if (dof) {
                    const u = U_solution_matrix.get([dof.u_dof, 0]);
                    const theta = U_solution_matrix.get([dof.theta_dof, 0]);
                    fNode.u = isFinite(u) ? u : 0;
                    fNode.theta = isFinite(theta) ? theta : 0;
                }
            });

            // 8. Calculate element forces
            model.layerElements.forEach(el => {
                const n1 = getNode(el.node1Id);
                const n2 = getNode(el.node2Id);
                if (n1 && n2) {
                    el.force = el.stiffness * (n2.u - n1.u);
                } else {
                    el.force = NaN;
                }
            });

            model.contactSpringElements.forEach(el => {
                const layerNode = getNode(el.layerNodeId);
                const fastenerNode = getFastenerNode(el.fastenerNodeId);
                if (layerNode && fastenerNode) {
                    el.force = el.stiffness * (fastenerNode.u - layerNode.u);
                } else {
                    el.force = NaN;
                }
            });

            // Beam element forces (shear force = k_shear * (u2 - u1) approximately)
            model.beamElements.forEach(el => {
                const fNode1 = getFastenerNode(el.node1Id);
                const fNode2 = getFastenerNode(el.node2Id);
                if (fNode1 && fNode2 && el.stiffnessMatrix) {
                    // Approximate shear force using the (0,0) term of the stiffness matrix
                    el.force = el.stiffnessMatrix[0][0] * (fNode2.u - fNode1.u);
                } else {
                    el.force = NaN;
                }
            });

            // Rotational spring moments
            model.rotationalSpringElements.forEach(el => {
                const fNode = getFastenerNode(el.fastenerNodeId);
                if (fNode) {
                    el.moment = el.stiffness * fNode.theta;
                } else {
                    el.moment = NaN;
                }
            });

            displayResults();
            updateVisualization(true);

            // Run debug validation
            debugSolverValidation();

            showMessage("Solution successful!", false);

        } catch (error) {
            showMessage(`Solver Error: ${error.message}`);
            console.error("Solver Error Details:", error);
            resultsSummaryDiv.innerHTML = `<p class="text-red-600">Solver failed: ${error.message}. Check console for details.</p>`;

            // Reset displacements
            model.nodes.forEach(node => node.u = 0);
            model.fastenerNodes.forEach(fNode => { fNode.u = 0; fNode.theta = 0; });
            model.layerElements.forEach(el => el.force = 0);
            model.beamElements.forEach(el => el.force = 0);
            model.contactSpringElements.forEach(el => el.force = 0);
            model.rotationalSpringElements.forEach(el => el.moment = 0);
            updateVisualization(false);
        }
    }, 100);
}

// --- Results Display ---
function displayResults() {
    let html = '<div class="space-y-4">';

    // Layer Element Forces
    html += '<div class="bg-gray-50 p-3 rounded border border-gray-200">';
    html += '<h4 class="font-semibold text-sm text-gray-700 mb-2">Layer Element Forces (lbf)</h4>';
    html += '<div class="max-h-40 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.layerElements.forEach(el => {
        const layer = getLayer(el.layerId);
        const layerName = layer ? layer.name : `L${el.layerId}`;
        html += `<li class="flex justify-between"><span>El ${el.id} (${layerName}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
    });
    html += '</ul></div></div>';

    // Beam Element Forces (Fastener Shank Transfer)
    html += '<div class="bg-green-50 p-3 rounded border border-green-200">';
    html += '<h4 class="font-semibold text-sm text-green-700 mb-2">Fastener Beam Forces (lbf)</h4>';
    html += '<div class="max-h-40 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.beamElements.forEach(el => {
        const fastener = getFastener(el.fastenerId);
        const fastenerLabel = fastener ? `Fastener ${el.fastenerId}` : `F${el.fastenerId}`;
        html += `<li class="flex justify-between"><span>Beam ${el.id} (${fastenerLabel}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
    });
    html += '</ul></div></div>';

    // Contact Spring Forces
    html += '<div class="bg-amber-50 p-3 rounded border border-amber-200">';
    html += '<h4 class="font-semibold text-sm text-amber-700 mb-2">Contact Spring Forces (lbf)</h4>';
    html += '<div class="max-h-32 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.contactSpringElements.forEach(el => {
        const layer = getLayer(el.layerId);
        const layerName = layer ? layer.name : `L${el.layerId}`;
        html += `<li class="flex justify-between"><span>CS ${el.id} (${layerName}, F${el.fastenerId}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
    });
    html += '</ul></div></div>';

    // Fastener Rotations
    html += '<div class="bg-purple-50 p-3 rounded border border-purple-200">';
    html += '<h4 class="font-semibold text-sm text-purple-700 mb-2">Fastener Rotations (rad)</h4>';
    html += '<div class="max-h-32 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.fastenerNodes.forEach(fNode => {
        const layer = getLayer(fNode.layerId);
        const layerName = layer ? layer.name : `L${fNode.layerId}`;
        const thetaDeg = (fNode.theta * 180 / Math.PI).toFixed(4);
        html += `<li class="flex justify-between"><span>F${fNode.fastenerId} @ ${layerName}:</span> <span class="font-mono">${fNode.theta.toExponential(3)} (${thetaDeg}°)</span></li>`;
    });
    html += '</ul></div></div>';

    html += '</div>';
    resultsSummaryDiv.innerHTML = html;
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    if (generateBtn) generateBtn.addEventListener('click', generateInitialModel);
    if (solveBtn) solveBtn.addEventListener('click', solve);
    if (updateElementBtn) updateElementBtn.addEventListener('click', updateElementProperties);
    if (deleteElementBtn) deleteElementBtn.addEventListener('click', handleDeleteElement);
    if (deselectBtn) deselectBtn.addEventListener('click', deselectElement);
    if (fixNodeBtn) fixNodeBtn.addEventListener('click', () => setBoundaryCondition(true));
    if (unfixNodeBtn) unfixNodeBtn.addEventListener('click', () => setBoundaryCondition(false));
    if (applyLoadBtn) applyLoadBtn.addEventListener('click', () => applyLoad(true));
    if (removeLoadBtn) removeLoadBtn.addEventListener('click', () => applyLoad(false));
    if (applyDispBtn) applyDispBtn.addEventListener('click', () => applyDisplacement(true));
    if (removeDispBtn) removeDispBtn.addEventListener('click', () => applyDisplacement(false));
    if (applyGlobalLayerPropsBtn) applyGlobalLayerPropsBtn.addEventListener('click', applyGlobalLayerProperties);
    if (applyGlobalFastenerPropsBtn) applyGlobalFastenerPropsBtn.addEventListener('click', applyGlobalFastenerProperties);
    if (renameLayerBtn) renameLayerBtn.addEventListener('click', renameLayer);

    if (rightEdgeConditionRadios) {
        rightEdgeConditionRadios.forEach(radio => {
            radio.addEventListener('change', function () {
                if (this.value === 'force') {
                    forceInputSection.classList.remove('hidden');
                    displacementInputSection.classList.add('hidden');
                } else { // 'displacement'
                    forceInputSection.classList.add('hidden');
                    displacementInputSection.classList.remove('hidden');
                }
                resultsSummaryDiv.innerHTML = '<p class="text-orange-600">Right edge condition type changed. Apply specific values and re-solve.</p>';
            });
        });
    }

    updateLayerSelectors();
    generateInitialModel();

    const initialCondition = document.querySelector('input[name="rightEdgeCondition"]:checked');
    if (initialCondition && initialCondition.value === 'force') {
        forceInputSection.classList.remove('hidden');
        displacementInputSection.classList.add('hidden');
    } else if (initialCondition) {
        forceInputSection.classList.add('hidden');
        displacementInputSection.classList.remove('hidden');
    }
});
