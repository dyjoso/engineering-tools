// --- Material Definitions ---
const MATERIALS = {
    "Aluminum": { E: 10.5e6, nu: 0.33 }, // psi, Poisson's Ratio
    "Titanium": { E: 16.5e6, nu: 0.31 }, // psi, Poisson's Ratio
    "Steel": { E: 29.5e6, nu: 0.30 }  // psi, Poisson's Ratio
};

// Tate & Rosenfeld bearing compliance factors (fastener, plate)
const FASTENER_COMPLIANCE_FACTOR = 0.375;
const PLATE_COMPLIANCE_FACTOR = 0.9;

// --- Global Variables ---
let model = {
    nodes: [],                    // Layer nodes: { id, x, y, u, F, isFixed, prescribedU, layer, nodeColIndex, fastenerIndex }
    fastenerNodes: [],            // Fastener shadow nodes: { id, x, y, u, theta, correspondingLayerNodeId, layerId, fastenerId }
    layers: [],
    fasteners: [],
    layerElements: [],
    beamElements: [],             // Timoshenko beam elements connecting fastener nodes vertically
    contactSpringElements: [],    // Shear springs connecting layer node to fastener node
    fastenerElements: [],         // Direct shear springs (Tate & Rosenfeld) for simple modeling
    numFasteners: 0,
    defaultSegmentLength: 1.0,    // inches
    fastenerMaterialName: "Steel", // Default fastener material
    fastenerModelingMode: "beam"   // 'beam' (Timoshenko + Residual) or 'spring' (Direct T&R)
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

    // Beam Elements
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
                // Node is at left end of element - Tension pulls it to the RIGHT (+F)
                sumForces += le.force || 0;
                contributions.push(`LE${le.id}(left): ${DEBUG.fmt(le.force || 0)}`);
            }
            if (le.node2Id === node.id) {
                // Node is at right end of element - Tension pulls it to the LEFT (-F)
                sumForces -= le.force || 0;
                contributions.push(`LE${le.id}(right): ${DEBUG.fmt(-(le.force || 0))}`);
            }
        });

        // Contact springs connected to this layer node
        model.contactSpringElements.forEach(cs => {
            if (cs.layerNodeId === node.id) {
                // Force on layer node from contact spring = k*(u_f - u_L) = +F_contact
                sumForces += cs.force || 0;
                contributions.push(`CS${cs.id}: ${DEBUG.fmt(cs.force || 0)}`);
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
                // Force on fastener node = -k*(u_f - u_L) = -F_contact
                sumForces += cs.force || 0;
                contributions.push(`CS${cs.id}: ${DEBUG.fmt(-(cs.force || 0))}`);
            }
        });

        // Beam elements connected to this fastener node
        model.beamElements.forEach(be => {
            if (be.node1Id === fNode.id) {
                // This node is be.node1 (top of segment in local order, but node1Id in model)
                // el.force is the shear V1 at node1. So add it.
                sumForces += be.force || 0;
                contributions.push(`BE${be.id}(n1): ${DEBUG.fmt(be.force || 0)}`);
            }
            if (be.node2Id === fNode.id) {
                // This node is be.node2 (bottom of segment)
                // Force is -V1.
                sumForces -= be.force || 0;
                contributions.push(`BE${be.id}(n2): ${DEBUG.fmt(-(be.force || 0))}`);
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
    console.log(`   Total Reaction (at fixed nodes): ${DEBUG.fmt(-totalReaction)} lbf`);
    console.log(`   Imbalance: ${DEBUG.fmt(totalAppliedLoad - totalReaction)} lbf`);

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
const fastenerModelingModeRadios = document.querySelectorAll('input[name="fastenerModelingMode"]');


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
    msgBox.className = `fixed bottom-4 right-4 max-w-sm z-50 transition-all duration-300 transform translate-y-0 opacity-100 ${isError ? 'error' : 'success'}`;
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

function getBeamElement(id) {
    return model.beamElements.find(el => el.id === id);
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

    const fastenerMaterialProps = MATERIALS[fastener.materialName];
    if (!fastenerMaterialProps) {
        console.warn(`Invalid fastener material selected: ${fastener.materialName}`);
        return 0;
    }
    const Ef = fastenerMaterialProps.E;
    const nu_f = fastenerMaterialProps.nu;

    if (E1 <= 0 || E2 <= 0 || Ef <= 0 || d <= 0 || nu_f === undefined) {
        console.warn(`Zero or negative property encountered for Fastener Element ${fastenerElement.id}`);
        return 0;
    }

    // Tate & Rosenfeld Flexibility Calculation
    const flexibility = calculateTateRosenfeldFlexibility(t1, t2, E1, E2, d, Ef, nu_f);

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
    const term1 = safeTerm(FASTENER_COMPLIANCE_FACTOR / (Ef * t1));  // Fastener bearing in layer 1
    const term2 = safeTerm(FASTENER_COMPLIANCE_FACTOR / (Ef * t2));  // Fastener bearing in layer 2
    const term3 = safeTerm(PLATE_COMPLIANCE_FACTOR / (E1 * t1));     // Plate bearing in layer 1
    const term4 = safeTerm(PLATE_COMPLIANCE_FACTOR / (E2 * t2));     // Plate bearing in layer 2
    const term5_coeff_denom = 9 * Ef * Math.PI * d ** 2;
    const term5_coeff = term5_coeff_denom !== 0 ? 32 / term5_coeff_denom : 0;
    const term5 = safeTerm(term5_coeff * (1 + nu_f) * (t1 + t2));  // Shear deformation
    const term6_coeff_denom = 5 * Ef * Math.PI * d ** 4;
    const term6_coeff = term6_coeff_denom !== 0 ? 8 / term6_coeff_denom : 0;
    const term6 = safeTerm(term6_coeff * (t1 ** 3 + 5 * t1 ** 2 * t2 + 5 * t1 * t2 ** 2 + t2 ** 3)); // Bending

    return term1 + term2 + term3 + term4 + term5 + term6;
}

/**
 * Shear correction factor for a solid circular section (Cowper, 1966)
 * @param {number} nu_f - Fastener Poisson's ratio
 * @returns {number} kappa (0.886 for nu = 0.31)
 */
function circularShearCoefficient(nu_f) {
    return 6 * (1 + nu_f) / (7 + 6 * nu_f);
}

/**
 * Layer thickness and modulus seen by a fastener at a layer node:
 * the average of the layer elements either side of the node (one element at a layer end).
 * @param {number} layerNodeId
 * @returns {{t: number, E: number}|null}
 */
function layerPropsAtNode(layerNodeId) {
    const els = model.layerElements.filter(el => el.node1Id === layerNodeId || el.node2Id === layerNodeId);
    if (els.length === 0) return null;
    const t = els.reduce((s, el) => s + el.t, 0) / els.length;
    const E = els.reduce((s, el) => s + (MATERIALS[el.materialName] ? MATERIALS[el.materialName].E : 0), 0) / els.length;
    return { t, E };
}

/**
 * Bearing (contact) spring between a layer node and its fastener node.
 * Flexibility = Cf/(Ef t) + Cp/(E t), i.e. the fastener and plate bearing terms of Tate & Rosenfeld
 * for this layer alone; shank shear and bending come from the beam elements.
 * @param {Object} contactSpring
 * @returns {number} stiffness (lbf/in), 0 if the spring has no valid layer
 */
function calculateBearingStiffness(contactSpring) {
    const fastener = getFastener(contactSpring.fastenerId);
    const props = layerPropsAtNode(contactSpring.layerNodeId);
    if (!fastener || !props || props.t <= 0 || props.E <= 0) return 0;
    const Ef = MATERIALS[fastener.materialName].E;
    const C = FASTENER_COMPLIANCE_FACTOR / (Ef * props.t) + PLATE_COMPLIANCE_FACTOR / (props.E * props.t);
    contactSpring.t = props.t;
    return 1 / C;
}

/**
 * Head / collar end fixity of a fastener column.
 * The shank continues half a layer thickness past the outermost layer mid-plane to the head (or collar)
 * face, where its rotation is clamped. That stub carries no shear, so it acts as a rotational spring
 * k = Ef I / (t/2) on the end fastener node.
 * @returns {number} rotational stiffness (lbf·in/rad)
 */
function calculateEndRotationalStiffness(fastenerNode) {
    const fastener = getFastener(fastenerNode.fastenerId);
    const props = layerPropsAtNode(fastenerNode.correspondingLayerNodeId);
    if (!fastener || !props || props.t <= 0) return 0;
    const Ef = MATERIALS[fastener.materialName].E;
    const I = Math.PI * Math.pow(fastener.diameter, 4) / 64;
    return Ef * I / (props.t / 2);
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

    // Layer thickness at each end (average of the layer elements either side of the node)
    const props1 = layerPropsAtNode(layerNode1.id);
    const props2 = layerPropsAtNode(layerNode2.id);

    if (!props1 || !props2) {
        console.warn(`Could not find layer elements for beam element ${beamElement.id}`);
        return null;
    }

    const t1 = props1.t;
    const t2 = props2.t;
    const d = fastener.diameter;

    const fastenerMaterialProps = MATERIALS[fastener.materialName];
    if (!fastenerMaterialProps) {
        console.warn(`Invalid fastener material: ${fastener.materialName}`);
        return null;
    }

    const Ef = fastenerMaterialProps.E;
    const nu_f = fastenerMaterialProps.nu;

    // Beam length = distance between layer mid-planes
    const L = (t1 + t2) / 2;

    // Beam properties
    const I = Math.PI * Math.pow(d, 4) / 64;
    const A = Math.PI * Math.pow(d, 2) / 4;
    const kappa = circularShearCoefficient(nu_f);
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
    beamElement.props = { d, Ef, nu_f, I, A, kappa, Gf, Phi, t1, t2 };

    console.log(`DEBUG: Beam Element ${beamElement.id} L=${L.toFixed(4)} in, k[0,0]=${k[0][0].toExponential(3)}`);

    return { matrix: k, Ef, I, L, Phi, t1, t2 };
}

/**
 * Head and tail fastener nodes of a column: the outermost nodes joined by a beam element.
 * (Fastener nodes left without a beam after a deletion are ignored.)
 */
function getFastenerColumnEnds(fastenerId) {
    const ids = new Set();
    model.beamElements.forEach(be => {
        if (be.fastenerId === fastenerId) { ids.add(be.node1Id); ids.add(be.node2Id); }
    });
    const nodes = model.fastenerNodes.filter(fn => ids.has(fn.id)).sort((a, b) => a.layerId - b.layerId);
    if (nodes.length === 0) return null;
    return { head: nodes[0], tail: nodes[nodes.length - 1] };
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
        model.columnLengths = [];
        model.sfOverrides = {};   // keyed by layer node id, which a new model reuses
        undoStack.length = 0;
        updateUndoButton();

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

        // Get modeling mode from UI
        const modeRadio = document.querySelector('input[name="fastenerModelingMode"]:checked');
        model.fastenerModelingMode = modeRadio ? modeRadio.value : 'beam';
        console.log(`Modeling fasteners using: ${model.fastenerModelingMode}`);


        for (let i = 0; i < model.numLayers; i++) {
            model.layers.push({
                id: i,
                name: `Layer_${i}`
            });
        }
        for (let i = 0; i < model.numFasteners; i++) {
            model.fasteners.push({ id: i, diameter: globalDiameter_in, materialName: globalFastenerMatName });
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

        // --- Fastener Components ---
        let fastenerNodeId = 0;
        let beamElementId = 0;
        let contactSpringId = 0;
        let fastenerElementId = 0;

        for (let j = 0; j < model.numFasteners; j++) {
            const nodeColIndex = j + 1; // Fastener columns are 1, 2, ... numFasteners

            if (model.fastenerModelingMode === 'beam') {
                // BEAM MODEL: Create fastener nodes, beam elements, and contact springs
                const fastenerNodesInColumn = [];
                for (let i = 0; i < model.numLayers; i++) {
                    const layerNode = model.nodes.find(n => n.layer === i && n.nodeColIndex === nodeColIndex);
                    if (!layerNode) continue;

                    const fNode = {
                        id: fastenerNodeId++,
                        x: layerNode.x,
                        y: layerNode.y,
                        u: 0,
                        theta: 0,
                        correspondingLayerNodeId: layerNode.id,
                        layerId: i,
                        fastenerId: j
                    };
                    model.fastenerNodes.push(fNode);
                    fastenerNodesInColumn.push(fNode);

                    model.contactSpringElements.push({
                        id: contactSpringId++,
                        layerNodeId: layerNode.id,
                        fastenerNodeId: fNode.id,
                        fastenerId: j,
                        layerId: i,
                        stiffness: 0,
                        force: 0
                    });
                }

                for (let i = 0; i < fastenerNodesInColumn.length - 1; i++) {
                    const fNode1 = fastenerNodesInColumn[i];
                    const fNode2 = fastenerNodesInColumn[i + 1];
                    model.beamElements.push({
                        id: beamElementId++,
                        node1Id: fNode1.id,
                        node2Id: fNode2.id,
                        fastenerId: j,
                        stiffnessMatrix: null,
                        length: 0,
                        force: 0
                    });
                }
            } else {
                // SPRING MODEL: Create direct shear springs between layer nodes
                const layerNodesInColumn = [];
                for (let i = 0; i < model.numLayers; i++) {
                    const layerNode = model.nodes.find(n => n.layer === i && n.nodeColIndex === nodeColIndex);
                    if (layerNode) layerNodesInColumn.push(layerNode);
                }

                for (let i = 0; i < layerNodesInColumn.length - 1; i++) {
                    const node1 = layerNodesInColumn[i];
                    const node2 = layerNodesInColumn[i + 1];
                    model.fastenerElements.push({
                        id: fastenerElementId++,
                        node1Id: node1.id,
                        node2Id: node2.id,
                        fastenerId: j,
                        stiffness: 0,
                        force: 0
                    });
                }
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



    } catch (error) {
        showMessage(`Error generating model: ${error.message}`);
        console.error("Model Generation Error:", error);
        resultsSummaryDiv.innerHTML = `<p class="text-red-600">Model generation failed: ${error.message}</p>`;
        model.nodes = []; model.fastenerNodes = []; model.layers = []; model.fasteners = [];
        model.layerElements = []; model.beamElements = []; model.contactSpringElements = []; model.rotationalSpringElements = [];
        updateVisualization(); updateLayerSelectors(); updateDisplays();
    }
}

/**
 * Pitch of each column gap (node column j to j+1). Kept on the model so a gap keeps its
 * length when every element in it has been deleted.
 */
function getColumnLengths() {
    const numGaps = model.numFasteners + 1;
    if (!Array.isArray(model.columnLengths)) model.columnLengths = [];
    for (let j = 0; j < numGaps; j++) {
        if (!(model.columnLengths[j] > 0)) {
            const element = model.layerElements.find(el => getNode(el.node1Id)?.nodeColIndex === j && el.length > 0);
            model.columnLengths[j] = element ? element.length : model.defaultSegmentLength;
        }
    }
    model.columnLengths.length = numGaps;
    return model.columnLengths;
}

// --- Visualization ---
// Main view shows either element loads (after a solve) or the SF_norm value at each hole
let vizShowSf = false;

function setVizShowSf(on) {
    vizShowSf = on;
    if (on) readSfSettingsFromSidebar();
    const btn = document.getElementById('viz-sf-toggle');
    btn.textContent = on ? 'Show Loads' : 'Show SF_norm';
    btn.classList.toggle('btn-primary', on);
    btn.classList.toggle('btn-secondary', !on);
    updateVisualization(!on && model.layerElements.some(el => el.force !== 0));
}

/** SF_norm label at each hole (layer node), up and to the left of the node, clear of the fastener line. */
function drawSfNormLabels() {
    let result;
    try {
        result = computeSeverityFactors();
    } catch (error) {
        const msg = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        msg.setAttribute('x', SVG_PADDING);
        msg.setAttribute('y', SVG_PADDING / 3);
        msg.setAttribute('class', 'sf-viz-label');
        msg.style.textAnchor = 'start';
        msg.textContent = 'SF_norm: solve the model first';
        visualizationSVG.appendChild(msg);
        return;
    }
    result.rows.forEach(r => {
        const node = getNode(r.layerNodeId);
        if (!node) return;
        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('x', node.x - 4);
        label.setAttribute('y', node.y - 10);
        label.setAttribute('class', 'sf-viz-label' + (r.sfNormRank === 1 ? ' sf-viz-max' : ''));
        label.textContent = r.sfNorm.toFixed(2);
        const tip = document.createElementNS('http://www.w3.org/2000/svg', 'title');
        tip.textContent = `SF_norm ${r.sfNorm.toFixed(3)} (rank ${r.sfNormRank}), SF ${r.ssf.toFixed(3)}, R/P ${r.rp.toFixed(3)}`;
        label.appendChild(tip);
        visualizationSVG.appendChild(label);
    });
    const ref = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    ref.setAttribute('x', SVG_PADDING);
    ref.setAttribute('y', SVG_PADDING / 3);
    ref.setAttribute('class', 'sf-viz-label');
    ref.style.textAnchor = 'start';
    ref.textContent = `SF_norm (reference: max gross stress ${result.maxGross.toFixed(0)} psi)`;
    visualizationSVG.appendChild(ref);
}

/** Pinned support at a restrained node: triangle with its apex on the node, ground line and hatching to the left. */
function drawPinnedSupport(node) {
    const ns = 'http://www.w3.org/2000/svg';
    const h = 9, w = 13;   // half-height and depth of the triangle
    const gx = node.x - w;
    const g = document.createElementNS(ns, 'g');
    g.setAttribute('class', 'pinned-support');
    const tri = document.createElementNS(ns, 'polygon');
    tri.setAttribute('points', `${node.x},${node.y} ${gx},${node.y - h} ${gx},${node.y + h}`);
    g.appendChild(tri);
    const ground = document.createElementNS(ns, 'line');
    ground.setAttribute('x1', gx - 3); ground.setAttribute('y1', node.y - h - 3);
    ground.setAttribute('x2', gx - 3); ground.setAttribute('y2', node.y + h + 3);
    g.appendChild(ground);
    for (let y = node.y - h; y <= node.y + h + 3; y += 5) {
        const hatch = document.createElementNS(ns, 'line');
        hatch.setAttribute('x1', gx - 3); hatch.setAttribute('y1', y);
        hatch.setAttribute('x2', gx - 8); hatch.setAttribute('y2', y - 5);
        g.appendChild(hatch);
    }
    visualizationSVG.appendChild(g);
}

function updateVisualization(showForces = false) {
    if (vizShowSf) showForces = false;
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

    // Node x comes from the column pitches, shared by all layers, so a layer with deleted
    // elements still lines up with the others
    const colLengths = getColumnLengths();
    const maxModelLength = colLengths.reduce((s, L) => s + L, 0) || model.defaultSegmentLength * colLengths.length;

    const targetSvgWidth = 800;
    const availableDrawingWidth = targetSvgWidth - 2 * SVG_PADDING;
    const scaleFactor = availableDrawingWidth / maxModelLength;

    const colX = [SVG_PADDING];
    colLengths.forEach((L, j) => colX.push(colX[j] + L * scaleFactor));
    model.nodes.forEach(n => { n.x = colX[n.nodeColIndex]; });

    const maxX = Math.max(...model.nodes.map(n => n.x), 0);
    const vbWidth = maxX + SVG_PADDING;
    const vbHeight = (model.numLayers > 1 ? (model.numLayers - 1) * LAYER_SPACING : LAYER_SPACING) + 2 * SVG_PADDING;
    // Extra room on the left for layer names beside pinned supports
    const vbLeft = model.nodes.some(n => n.isFixed) ? 20 : 0;
    visualizationSVG.setAttribute('viewBox', `${-vbLeft} 0 ${vbWidth + vbLeft} ${vbHeight}`);

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

    // Fastener nodes are drawn on their layer nodes, so the beam runs straight through the hole
    // (the bearing springs between them are not drawn)
    model.fastenerNodes.forEach(fNode => {
        const layerNode = getNode(fNode.correspondingLayerNodeId);
        if (layerNode) {
            fNode.x = layerNode.x;
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

    // Draw direct fastener elements (shear springs) if in spring mode
    if (model.fastenerModelingMode === 'spring') {
        model.fastenerElements.forEach(el => {
            const node1 = getNode(el.node1Id);
            const node2 = getNode(el.node2Id);
            if (!node1 || !node2) return;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', node1.x); line.setAttribute('y1', node1.y);
            line.setAttribute('x2', node2.x); line.setAttribute('y2', node2.y);
            line.setAttribute('class', 'fastener-element');
            line.style.strokeDasharray = 'none'; // Solid line for shear springs
            line.style.stroke = '#6366f1';      // Indigo color
            line.style.strokeWidth = '2';
            visualizationSVG.appendChild(line);

            const clickTargetLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            clickTargetLine.setAttribute('x1', node1.x); clickTargetLine.setAttribute('y1', node1.y);
            clickTargetLine.setAttribute('x2', node2.x); clickTargetLine.setAttribute('y2', node2.y);
            clickTargetLine.setAttribute('class', 'click-target');
            clickTargetLine.dataset.elementType = 'fastenerElement';
            clickTargetLine.dataset.elementId = el.id;
            clickTargetLine.addEventListener('click', handleElementSelect);
            visualizationSVG.appendChild(clickTargetLine);

            if (selectedElement && selectedElement.type === 'fastenerElement' && selectedElement.id === el.id) {
                line.classList.add('selected');
                line.style.stroke = '#f59e0b'; // Highlight selected spring
                line.style.strokeWidth = '4';
            }

            if (showForces && el.force !== undefined && !isNaN(el.force)) {
                const forceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                forceLabel.setAttribute('x', (node1.x + node2.x) / 2 + 10);
                forceLabel.setAttribute('y', (node1.y + node2.y) / 2);
                forceLabel.setAttribute('class', 'force-label');
                forceLabel.style.textAnchor = 'start';
                forceLabel.textContent = `${el.force.toFixed(1)} lbf`;
                visualizationSVG.appendChild(forceLabel);
            }
        });
    }

    const actualRightmostNodeX = Math.max(...model.nodes.map(n => n.x));

    // Loose nodes (no plate element, no fastener spring) are not drawn
    const attachedNodeIds = new Set();
    model.layerElements.forEach(el => { attachedNodeIds.add(el.node1Id); attachedNodeIds.add(el.node2Id); });
    if (model.fastenerModelingMode === 'spring') {
        model.fastenerElements.forEach(el => { attachedNodeIds.add(el.node1Id); attachedNodeIds.add(el.node2Id); });
    }

    model.nodes.forEach(node => {
        if (!attachedNodeIds.has(node.id)) return;
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', node.x); circle.setAttribute('cy', node.y);
        circle.setAttribute('class', 'node');
        circle.setAttribute('fill', 'blue');
        circle.setAttribute('r', '5');
        circle.dataset.nodeId = node.id;

        circle.removeAttribute('style');
        circle.removeAttribute('stroke');
        circle.removeAttribute('stroke-width');

        if (node.isFixed) drawPinnedSupport(node);
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
            const supported = nodesInLayer.some(n => n.isFixed && n.nodeColIndex === leftmostNodeInLayer.nodeColIndex);
            label.setAttribute('x', SVG_PADDING - (supported ? 28 : 10));
            label.setAttribute('y', leftmostNodeInLayer.y);
            label.setAttribute('class', 'layer-name-label');
            label.textContent = layer.name;
            visualizationSVG.appendChild(label);
        }
    });

    if (vizShowSf) drawSfNormLabels();
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
                    <div class='opacity-75 text-[10px] mt-0.5'>Length change applies to column.</div>
                    </div>`;
                break;

            case 'fastenerElement':
                element = getFastenerElement(selectedElement.id);
                if (!element) throw new Error(`Fastener Element ${selectedElement.id} not found.`);
                fastener = getFastener(element.fastenerId);
                if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                editorTitle.textContent = `Edit Fastener ${element.id} (Col ${element.fastenerId})`;

                let fastenerMaterialOptions = '';
                Object.keys(MATERIALS).forEach(matName => {
                    fastenerMaterialOptions += `<option value='${matName}' ${fastener.materialName === matName ? 'selected' : ''}>${matName}</option>`;
                });

                editorContent.innerHTML = `
                    <div>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Material</label>
                    <select id='edit-fastener-material' class='input-field text-sm py-1'>${fastenerMaterialOptions}</select>
                    </div>
                    <div class='mt-2'>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Diameter (in)</label>
                    <input type='number' id='edit-fastener-diameter' value='${fastener.diameter}' min='0.01' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    <div class='mt-2 p-2 bg-yellow-100 rounded text-xs text-yellow-800'>
                    <p>k = ${(element.stiffness / 1000).toFixed(2)} kip/in</p>
                    <button onclick='deleteFastenerColumn(${element.fastenerId})' class='btn-danger w-full text-[10px] mt-2 py-0.5'>Delete Entire Fastener</button>
                    </div>`;
                break;

            case 'beamElement':
                element = getBeamElement(selectedElement.id);
                if (!element) throw new Error(`Beam Element ${selectedElement.id} not found.`);
                fastener = getFastener(element.fastenerId);
                if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                editorTitle.textContent = `Edit Beam segment ${element.id} (Fastener ${element.fastenerId})`;

                let beamMaterialOptions = '';
                Object.keys(MATERIALS).forEach(matName => {
                    beamMaterialOptions += `<option value='${matName}' ${fastener.materialName === matName ? 'selected' : ''}>${matName}</option>`;
                });

                editorContent.innerHTML = `
                    <div>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Material</label>
                    <select id='edit-fastener-material' class='input-field text-sm py-1'>${beamMaterialOptions}</select>
                    </div>
                    <div class='mt-2'>
                    <label class='block text-xs font-medium text-gray-700 mb-1'>Diameter (in)</label>
                    <input type='number' id='edit-fastener-diameter' value='${fastener.diameter}' min='0.01' step='0.01' class='input-field text-sm py-1'>
                    </div>
                    <div class='mt-2 p-2 bg-yellow-100 rounded text-xs text-yellow-800'>
                    <p>V = ${element.force.toFixed(2)} lbf</p>
                    <button onclick='deleteFastenerColumn(${element.fastenerId})' class='btn-danger w-full text-[10px] mt-2 py-0.5'>Delete Entire Fastener</button>
                    </div>`;
                break;

            case 'contactSpringElement':
                element = model.contactSpringElements.find(el => el.id === selectedElement.id);
                if (!element) throw new Error(`Contact Spring ${selectedElement.id} not found.`);
                fastener = getFastener(element.fastenerId);
                layer = getLayer(element.layerId);

                editorTitle.textContent = `Edit Contact Spring ${element.id} (${layer?.name}, F${element.fastenerId})`;
                editorContent.innerHTML = `
                    <div class='text-xs text-gray-600'>
                        <p>This spring connects Layer <b>${layer?.name}</b> to Fastener <b>${element.fastenerId}</b>.</p>
                        <p class='mt-1'>Deleting this connection will disconnect the fastener from this layer at this location.</p>
                    </div>
                    <div class='mt-2 p-2 bg-yellow-100 rounded text-xs text-yellow-800'>
                        <p>F = ${element.force.toFixed(2)} lbf</p>
                        <button onclick='deleteFastenerColumn(${element.fastenerId})' class='btn-danger w-full text-[10px] mt-2 py-0.5'>Delete Entire Fastener</button>
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
    const before = JSON.stringify(model);
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

                getColumnLengths()[colIdx] = newLength_in;

                if (lengthChangedInThisColumn) {
                    propsChanged = true;
                    console.log(`Updated length for column ${colIdx} to ${newLength_in}.`);
                }

                break;
            }
            case 'fastenerElement': {
                const element = getFastenerElement(selectedElement.id); if (!element) throw new Error(`Fastener Element ${selectedElement.id} not found.`);
                const fastener = getFastener(element.fastenerId); if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                const newMaterialName = document.getElementById('edit-fastener-material').value;
                const newD_in = parseFloat(document.getElementById('edit-fastener-diameter').value);
                if (isNaN(newD_in) || newD_in <= 0 || !MATERIALS[newMaterialName]) {
                    throw new Error("Invalid input value for properties.");
                }

                if (fastener.diameter !== newD_in || fastener.materialName !== newMaterialName) {
                    fastener.diameter = newD_in;
                    fastener.materialName = newMaterialName;
                    propsChanged = true;
                    console.log(`Updated Fastener Column ${fastener.id} props.`);
                }
                break;
            }
            case 'beamElement': {
                const element = getBeamElement(selectedElement.id); if (!element) throw new Error(`Beam Element ${selectedElement.id} not found.`);
                const fastener = getFastener(element.fastenerId); if (!fastener) throw new Error(`Fastener ${element.fastenerId} not found.`);

                const newMaterialName = document.getElementById('edit-fastener-material').value;
                const newD_in = parseFloat(document.getElementById('edit-fastener-diameter').value);
                if (isNaN(newD_in) || newD_in <= 0 || !MATERIALS[newMaterialName]) {
                    throw new Error("Invalid input value for properties.");
                }

                if (fastener.diameter !== newD_in || fastener.materialName !== newMaterialName) {
                    fastener.diameter = newD_in;
                    fastener.materialName = newMaterialName;
                    propsChanged = true;
                    console.log(`Updated Fastener Column ${fastener.id} props.`);
                }
                break;
            }
            case 'contactSpringElement': {
                showMessage("Contact spring properties are derived from layer and fastener. No individual properties to update.", false);
                break;
            }
            default:
                throw new Error(`Unknown element type: ${selectedElement.type}`);
        }

        if (propsChanged) {
            pushUndo(`edit ${selectedElement.type} ${selectedElement.id}`, before);
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
    console.log("DEBUG: Starting orphan node and element cleanup...");

    let changed = false;
    let iteration = 0;
    const maxIterations = 5; // Prevent infinite loops just in case

    do {
        changed = false;
        iteration++;
        console.log(`DEBUG: Cleanup iteration ${iteration}`);

        // 1. Identify connected nodes
        const connectedLayerNodeIds = new Set();
        const connectedFastenerNodeIds = new Set();

        model.layerElements.forEach(el => {
            connectedLayerNodeIds.add(el.node1Id);
            connectedLayerNodeIds.add(el.node2Id);
        });

        model.fastenerElements.forEach(el => {
            connectedLayerNodeIds.add(el.node1Id);
            connectedLayerNodeIds.add(el.node2Id);
        });

        model.beamElements.forEach(el => {
            connectedFastenerNodeIds.add(el.node1Id);
            connectedFastenerNodeIds.add(el.node2Id);
        });

        model.contactSpringElements.forEach(el => {
            connectedLayerNodeIds.add(el.layerNodeId);
            connectedFastenerNodeIds.add(el.fastenerNodeId);
        });

        // 2. Remove orphaned fastener nodes
        const originalFastenerNodeCount = model.fastenerNodes.length;
        model.fastenerNodes = model.fastenerNodes.filter(fn => connectedFastenerNodeIds.has(fn.id));
        if (model.fastenerNodes.length < originalFastenerNodeCount) {
            console.log(`DEBUG: Removed ${originalFastenerNodeCount - model.fastenerNodes.length} orphaned fastener nodes.`);
            changed = true;
        }

        // 3. Remove orphaned layer nodes
        const originalLayerNodeCount = model.nodes.length;
        model.nodes = model.nodes.filter(n => connectedLayerNodeIds.has(n.id));
        if (model.nodes.length < originalLayerNodeCount) {
            console.log(`DEBUG: Removed ${originalLayerNodeCount - model.nodes.length} orphaned layer nodes.`);
            changed = true;
        }

        // 4. Remove elements referencing deleted fastener nodes
        const activeFastenerNodeIds = new Set(model.fastenerNodes.map(fn => fn.id));

        const originalBeamCount = model.beamElements.length;
        model.beamElements = model.beamElements.filter(el =>
            activeFastenerNodeIds.has(el.node1Id) && activeFastenerNodeIds.has(el.node2Id)
        );
        if (model.beamElements.length < originalBeamCount) {
            console.log(`DEBUG: Removed ${originalBeamCount - model.beamElements.length} beam elements due to missing nodes.`);
            changed = true;
        }

        const originalContactCount = model.contactSpringElements.length;
        model.contactSpringElements = model.contactSpringElements.filter(el =>
            activeFastenerNodeIds.has(el.fastenerNodeId)
        );
        if (model.contactSpringElements.length < originalContactCount) {
            console.log(`DEBUG: Removed ${originalContactCount - model.contactSpringElements.length} contact springs due to missing nodes.`);
            changed = true;
        }

    } while (changed && iteration < maxIterations);

    updateVisualization();
    updateDisplays();
    updateLayerSelectors();
    return iteration > 1; // Return true if we did more than one pass or found changes
}

// --- Undo ---
// Snapshots of the model taken before each edit; deletes no longer ask for confirmation.
const undoStack = [];
const MAX_UNDO = 50;

function pushUndo(label, state = JSON.stringify(model)) {
    undoStack.push({ label, state });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    updateUndoButton();
}

function undo() {
    const entry = undoStack.pop();
    if (!entry) return;
    Object.assign(model, JSON.parse(entry.state));
    populateSfSidebar();
    deselectElement();
    updateVisualization();
    updateDisplays();
    updateLayerSelectors();
    updateUndoButton();
    resultsSummaryDiv.innerHTML = `<p class="text-orange-600">Undid: ${entry.label}. Please re-solve.</p>`;
    showMessage(`Undid: ${entry.label}`, false);
}

function updateUndoButton() {
    const btn = document.getElementById('undo-btn');
    if (!btn) return;
    const last = undoStack[undoStack.length - 1];
    btn.disabled = !last;
    btn.title = last ? `Undo ${last.label} (Ctrl+Z)` : 'Nothing to undo';
}

// --- Save / Load ---
const MODEL_FILE_FORMAT = 'load-transfer-model';

function saveModel() {
    const file = { format: MODEL_FILE_FORMAT, version: 1, saved: new Date().toISOString(), model };
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `load-transfer-model-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    showMessage('Model saved.', false);
}

function loadModelFile(fileObj) {
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const file = JSON.parse(reader.result);
            const loaded = file && file.format === MODEL_FILE_FORMAT ? file.model : null;
            if (!loaded || !Array.isArray(loaded.nodes) || !Array.isArray(loaded.layerElements) || !Array.isArray(loaded.layers)) {
                throw new Error('not a model saved from this tool');
            }
            pushUndo('load model');
            Object.assign(model, { sfSettings: undefined, sfOverrides: {} }, loaded);

            numLayersInput.value = model.numLayers;
            numFastenersInput.value = model.numFasteners;
            layerLengthInput.value = model.defaultSegmentLength;
            const modeRadio = document.querySelector(`input[name="fastenerModelingMode"][value="${model.fastenerModelingMode}"]`);
            if (modeRadio) modeRadio.checked = true;
            populateSfSidebar();

            deselectElement();
            updateVisualization();
            updateDisplays();
            updateLayerSelectors();
            resultsSummaryDiv.innerHTML = `<p class="text-orange-600">Loaded ${fileObj.name}. Solve to see results.</p>`;
            showMessage(`Loaded ${fileObj.name}.`, false);
        } catch (error) {
            showMessage(`Could not load ${fileObj.name}: ${error.message}`);
            console.error('Load error:', error);
        }
    };
    reader.readAsText(fileObj);
}

/**
 * Delete all elements associated with a fastener ID
 */
function deleteFastenerColumn(fastenerId) {
    pushUndo(`delete fastener ${fastenerId}`);

    console.log(`DEBUG: Deleting all elements for Fastener ${fastenerId}`);

    model.beamElements = model.beamElements.filter(el => el.fastenerId !== fastenerId);
    model.contactSpringElements = model.contactSpringElements.filter(el => el.fastenerId !== fastenerId);
    model.fastenerElements = model.fastenerElements.filter(el => el.fastenerId !== fastenerId);

    cleanupOrphanedNodes();
    deselectElement();
    showMessage(`Fastener col ${fastenerId} deleted.`, false);
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

    pushUndo(`delete ${type} ${id}`);

    console.log(`DEBUG: Proceeding with deletion logic for ${type} ${id}`);
    try {
        let index = -1;
        let deleted = false;
        let arrayToModify = null;

        if (type === 'layerElement') {
            arrayToModify = model.layerElements;
        } else if (type === 'fastenerElement') {
            arrayToModify = model.fastenerElements;
        } else if (type === 'beamElement') {
            arrayToModify = model.beamElements;
        } else if (type === 'contactSpringElement') {
            arrayToModify = model.contactSpringElements;
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
    const before = JSON.stringify(model);
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
            pushUndo('apply layer properties to all', before);
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
    const before = JSON.stringify(model);
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
            if (fastener.diameter !== globalDiameter_in || fastener.materialName !== globalFastenerMatName) {
                fastener.diameter = globalDiameter_in;
                fastener.materialName = globalFastenerMatName;
                propsChanged = true;
            }
        });

        if (propsChanged) {
            pushUndo('apply fastener properties to all', before);
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

            // 0. Reset previous solution state
            model.nodes.forEach(n => n.u = 0);
            model.fastenerNodes.forEach(fn => { fn.u = 0; fn.theta = 0; });
            model.layerElements.forEach(el => { el.force = 0; el.stiffness = 0; });
            model.beamElements.forEach(el => { el.force = 0; el.stiffnessMatrix = null; });
            model.contactSpringElements.forEach(el => { el.force = 0; el.stiffness = 0; });
            model.fastenerElements.forEach(el => { el.force = 0; el.stiffness = 0; });

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

            // 3b/c. Fastener Modeling
            if (model.fastenerModelingMode === 'beam') {
                // BEAM MODEL: Timoshenko beams (shank shear + bending) + bearing contact springs
                model.beamElements.forEach(el => {
                    const dof1 = fastenerNodeDofMap.get(el.node1Id);
                    const dof2 = fastenerNodeDofMap.get(el.node2Id);
                    if (!dof1 || !dof2) throw new Error(`DOF not found for Beam Element ${el.id}.`);

                    // A. Beam Stiffness
                    const beamResult = calculateBeamElementStiffnessMatrix(el);
                    if (beamResult && beamResult.matrix) {
                        const kMatrix = beamResult.matrix;
                        const dofs = [dof1.u_dof, dof1.theta_dof, dof2.u_dof, dof2.theta_dof];
                        for (let r = 0; r < 4; r++) {
                            for (let c = 0; c < 4; c++) {
                                addToK(dofs[r], dofs[c], kMatrix[r][c]);
                            }
                        }
                    }
                });

                // B. Bearing contact springs - one per layer the fastener passes through
                const beamNodeIds = new Set();
                model.beamElements.forEach(el => { beamNodeIds.add(el.node1Id); beamNodeIds.add(el.node2Id); });
                model.contactSpringElements.forEach(cs => {
                    if (!beamNodeIds.has(cs.fastenerNodeId)) return; // fastener does not pass through this layer
                    const fDof = fastenerNodeDofMap.get(cs.fastenerNodeId);
                    const lDof = layerNodeDofMap.get(cs.layerNodeId);
                    if (!fDof || !lDof) return;
                    const k = calculateBearingStiffness(cs);
                    cs.stiffness = k;
                    const i = lDof.u_dof;
                    const j = fDof.u_dof;
                    addToK(i, i, k);
                    addToK(j, j, k);
                    addToK(i, j, -k);
                    addToK(j, i, -k);
                });

                // C. Head / collar end fixity (rotational springs at the column's end nodes)
                model.endRotationalSprings = [];
                for (let j = 0; j < model.numFasteners; j++) {
                    const ends = getFastenerColumnEnds(j);
                    if (!ends) continue;
                    [['head', ends.head], ['tail', ends.tail]].forEach(([end, fNode]) => {
                        const k = calculateEndRotationalStiffness(fNode);
                        const dof = fastenerNodeDofMap.get(fNode.id);
                        if (!dof || k <= 0) return;
                        addToK(dof.theta_dof, dof.theta_dof, k);
                        model.endRotationalSprings.push({ fastenerId: j, end, fastenerNodeId: fNode.id, layerId: fNode.layerId, stiffness: k });
                    });
                }
            } else {
                // SPRING MODEL: Direct Tate & Rosenfeld Shear Springs
                model.fastenerElements.forEach(el => {
                    const dof1 = layerNodeDofMap.get(el.node1Id);
                    const dof2 = layerNodeDofMap.get(el.node2Id);
                    if (!dof1 || !dof2) throw new Error(`DOF not found for Fastener Element ${el.id}.`);

                    const k = calculateFastenerElementStiffness(el);
                    el.stiffness = k;

                    const i = dof1.u_dof;
                    const j = dof2.u_dof;
                    addToK(i, i, k);
                    addToK(j, j, k);
                    addToK(i, j, -k);
                    addToK(j, i, -k);
                });
            }

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

            // 5. Apply Boundary Conditions
            console.log("Applying Boundary Conditions...");
            let max_diag = 0;
            for (let i = 0; i < N_solve; i++) {
                const diagVal = math.subset(K_global, math.index(i, i));
                if (typeof diagVal === 'number' && isFinite(diagVal)) {
                    max_diag = Math.max(max_diag, Math.abs(diagVal));
                }
            }
            const penaltyStiffness = max_diag > 1e-9 ? max_diag * 1e8 : 1e8;

            // 5a. Physical Constraints (Layers)
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

            // 5b. Unconnected DOFs (e.g. fastener nodes in a layer the fastener no longer passes
            // through, or layer nodes with no elements) carry no stiffness - pin them so K stays non-singular
            for (let i = 0; i < N_solve; i++) {
                const diagVal = math.subset(K_global, math.index(i, i));
                if (!diagVal) addToK(i, i, penaltyStiffness);
            }

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
                    el.force = 0;
                }
            });

            model.contactSpringElements.forEach(el => {
                const layerNode = getNode(el.layerNodeId);
                const fastenerNode = getFastenerNode(el.fastenerNodeId);
                if (layerNode && fastenerNode) {
                    el.force = el.stiffness * (fastenerNode.u - layerNode.u);
                } else {
                    el.force = 0;
                }
            });

            // Fastener forces
            if (model.fastenerModelingMode === 'beam') {
                model.beamElements.forEach(el => {
                    const fNode1 = getFastenerNode(el.node1Id);
                    const fNode2 = getFastenerNode(el.node2Id);
                    if (fNode1 && fNode2 && el.stiffnessMatrix) {
                        const u = [fNode1.u, fNode1.theta, fNode2.u, fNode2.theta];
                        const kRow = el.stiffnessMatrix[0];
                        let V = 0;
                        for (let i = 0; i < 4; i++) {
                            V += kRow[i] * u[i];
                        }
                        el.force = V;
                    } else {
                        el.force = 0;
                    }
                });
            } else {
                model.fastenerElements.forEach(el => {
                    const n1 = getNode(el.node1Id);
                    const n2 = getNode(el.node2Id);
                    if (n1 && n2) {
                        el.force = el.stiffness * (n2.u - n1.u);
                    } else {
                        el.force = 0;
                    }
                });
            }

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

    // Fastener Forces / Rotations based on mode
    if (model.fastenerModelingMode === 'beam') {
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
    } else {
        // Direct Shear Spring Forces
        html += '<div class="bg-indigo-50 p-3 rounded border border-indigo-200">';
        html += '<h4 class="font-semibold text-sm text-indigo-700 mb-2">Fastener Shear Spring Forces (lbf)</h4>';
        html += '<div class="max-h-40 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
        model.fastenerElements.forEach(el => {
            const fastener = getFastener(el.fastenerId);
            const fastenerLabel = fastener ? `Fastener ${el.fastenerId}` : `F${el.fastenerId}`;
            html += `<li class="flex justify-between"><span>Spring ${el.id} (${fastenerLabel}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
        });
        html += '</ul></div></div>';
    }

    html += '</div>';
    resultsSummaryDiv.innerHTML = html;
}

// --- Severity Factors (SF) ---
// Non-dimensional severity factor (SF), independent of load level:
//   SF = alpha*beta*gamma * { e2 * [ GSF*K_TG*B*(P_bypass/P_total) + theta*K_TB*(R/P)*W/(n d) ] + BT*K_Tbend }
// with R/P = dP/P_total, P_total = bypass + transfer, B = biaxial correction.
// Framework, K_TB and e2 nomogram: Boeing D6-29942 (JOSEF II). K_TG, K_Tbend: Peterson.
// Factor values calibrated October 2026 against independent reference analyses of the S1 wing splice (<2%).

const SF_FASTENER_TYPES = {          // beta (lock bolts = D6-29942 Table E.3.2)
    'Open Hole': 1.00,
    'Rivet': 0.62,
    'Hi-Lok': 0.72,
    'CSK Lock Bolt': 0.83,
    'Protruding Head Lock Bolt': 0.79,
    'Close Tolerance Lock Bolt': 0.76,
    'User Defined': null
};
const SF_HOLE_TYPES = {              // alpha
    'Standard Drilled Hole': 1.00,
    'Reamed - TX Fit': 0.92,
    'Class I Fit': 1.00,
    'Class II Fit': 1.10,
    'Interference Fit': 0.872
};
const SF_COLD_WORK_FACTOR = 0.88;    // D6-29942 Table E.3.3
// Edge margin factor vs E/D, quadratic through 1.0 -> 1.565, 1.5 -> 1.164, 2.0 -> 1.0 (0 = default 2.0)
const sfEdgeFactor = ed => {
    const x = ed > 0 ? Math.min(Math.max(ed, 1.0), 2.0) : 2.0;
    return 3.078 - 1.987 * x + 0.474 * x * x;
};
// Biaxial correction on the bypass term, B = 1 - 0.3 * lambda (calibrated at lambda = 0.5)
const SF_BIAX_COEFF = 0.3;
// theta vs t/d: single shear follows the D6-29942 curve to t/d = 0.4754, then runs nearly linear;
// double shear is one cubic. Matches the reference results where the JOSEF II tables
// (which rise to 2.02 at t/d 0.9) over-predict the SF by ~7% at t/d 0.74.
const sfThetaSingle = x => x <= 0.4754
    ? 1 + 0.0833 * x + 0.4272 * x * x + 0.8501 * x ** 3
    : 0.7521 + 1.0148 * x + 0.0039 * x * x + 0.0697 * x ** 3;
const sfThetaDouble = x => 1 - 0.0006 * x + 0.1069 * x * x + 0.0671 * x ** 3;
// Countersink depth factor vs Tcsk/T (D6-29942 Figure E.3.1; 0.5 -> 1.10, 1.0 -> 2.0)
const SF_CSK_CURVE = [[0, 1.0], [0.2, 1.0], [0.4, 1.03], [0.5, 1.10], [0.6, 1.20], [0.7, 1.33], [0.8, 1.50], [0.9, 1.72], [1.0, 2.0]];
// e2 load-transfer correction (D6-29942 Fig. E.3.2, digitised from a clean redraw of the nomogram):
//   e2 = 1 + G(theta) * H(theta, d/W) * R/P,   H = 2E
// The nomogram's c-lines are e2 - 1 = H * R/P with c = bearing / bypass = R/(P - R), i.e. R/P = c/(1 + c).
// E = e2 - 1 read at c = 1 (R/P = 0.5), so H = 2E.
// G(theta) = 1.078 * (1 - 0.198 (theta - 1)) scales the chart; calibrated against the reference results
// (17 holes, d/W 0.125-0.40, theta 1.01-1.54), which rise less steeply with theta than the chart.
const SF_E2_SCALE = 1.078;
const SF_E2_THETA_SLOPE = 0.198;
const sfE2Factor = theta => SF_E2_SCALE * (1 - SF_E2_THETA_SLOPE * (theta - 1));
const SF_E2_DW = [0.125, 0.15, 0.175, 0.21, 0.25, 0.275, 0.35, 0.395];
const SF_E2_THETA = [1.0, 1.2, 1.4, 1.8];
const SF_E2_E = [
    [1.0489, 0.7876, 0.5926, 0.4122, 0.2944, 0.2540, 0.1435, 0.0810],
    [1.3360, 1.0342, 0.8060, 0.5889, 0.4490, 0.3975, 0.2650, 0.1840],
    [1.6415, 1.2955, 1.0453, 0.8097, 0.6330, 0.5852, 0.4269, 0.3312],
    [2.2120, 1.7814, 1.4280, 1.1225, 0.9054, 0.8281, 0.6514, 0.5447]
];

const SF_DEFAULTS = {
    fastenerType: 'Hi-Lok', userBeta: 1.0, holeType: 'Reamed - TX Fit', coldWorked: false, shear: 'auto',
    cskRatio: 0, edgeMargin: 0, btRatio: 0, biaxRatio: 0, grossStressFactor: 1.0
};
const SF_GLOBAL_DEFAULTS = { ...SF_DEFAULTS, nFasteners: 1 };

function interpTable(xs, ys, x) {
    if (x <= xs[0]) return ys[0];
    for (let i = 1; i < xs.length; i++) {
        if (x <= xs[i]) return ys[i - 1] + (ys[i] - ys[i - 1]) * (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    }
    return ys[ys.length - 1];
}

function sfTheta(tOverD, shear) {
    const x = Math.max(tOverD, 0);
    return shear === 'double' ? sfThetaDouble(x) : sfThetaSingle(x);
}

function sfE2(theta, dOverW, rp) {
    if (!(rp > 0)) return 1;
    // d/W held to the chart (0.125-0.395); theta below 1.0 held, above 1.8 extended along the 1.4-1.8 trend
    const x = Math.min(Math.max(dOverW, SF_E2_DW[0]), SF_E2_DW[SF_E2_DW.length - 1]);
    const th = Math.max(theta, SF_E2_THETA[0]);
    const rows = SF_E2_E.map(row => interpTable(SF_E2_DW, row, x));
    const n = SF_E2_THETA.length;
    const e = th <= SF_E2_THETA[n - 1] ? interpTable(SF_E2_THETA, rows, th)
        : rows[n - 1] + (rows[n - 1] - rows[n - 2]) * (th - SF_E2_THETA[n - 1]) / (SF_E2_THETA[n - 1] - SF_E2_THETA[n - 2]);
    return 1 + sfE2Factor(th) * 2 * e * Math.min(rp, 1);
}

// Gross-area open-hole factor for a row of holes at pitch W (Peterson, infinite row, uniaxial tension):
// K_t,net = 3[1.002 - 1.016 x + 0.253 x^2], x = d/W (0..0.7); K_TG = K_t,net / (1 - x)
function sfKtg(dOverW) {
    const x = Math.min(Math.max(dOverW, 0), 0.7);
    return 3 * (1.002 - 1.016 * x + 0.253 * x * x) / (1 - x);
}

// Bearing (load-transfer) factor on sigma = P/(d t): the JOSEF II program fit (Boeing D6-29942),
// K_TB = exp(2.08 x^2 + 0.75 x), x = d/W
function sfKtb(dOverW) {
    const x = Math.min(Math.max(dOverW, 0), 0.75);
    return Math.exp(2.08 * x * x + 0.75 * x);
}

// Gross-area bending factor, row of holes, cylindrical bending about the x-axis (Peterson Chart 4.84), x = d/W 0..0.7
function sfKtBend(dOverW) {
    const x = Math.min(Math.max(dOverW, 0), 0.7);
    return (1.849 - 1.741 * x + 0.875 * x * x + 0.081 * x ** 3) / (1 - x);
}

function getSfSettings() {
    model.sfSettings = { ...SF_GLOBAL_DEFAULTS, ...(model.sfSettings || {}) };
    if (!model.sfOverrides) model.sfOverrides = {};
    return model.sfSettings;
}

function sfSettingsForHole(layerNodeId) {
    const g = getSfSettings();
    const s = { ...SF_DEFAULTS };
    Object.keys(SF_DEFAULTS).forEach(k => { s[k] = g[k]; });
    return { ...s, ...(model.sfOverrides[layerNodeId] || {}) };
}

function sfAlphaBetaGamma(s) {
    const beta = s.fastenerType === 'User Defined' ? s.userBeta : SF_FASTENER_TYPES[s.fastenerType];
    const alpha = SF_HOLE_TYPES[s.holeType];
    const csk = interpTable(SF_CSK_CURVE.map(p => p[0]), SF_CSK_CURVE.map(p => p[1]), s.cskRatio || 0);
    const cold = s.coldWorked ? SF_COLD_WORK_FACTOR : 1;
    const edge = sfEdgeFactor(s.edgeMargin);
    return { alpha, beta, csk, cold, edge, total: alpha * beta * csk * cold * edge };
}

/** Holes = layer nodes a fastener passes through, with the fastener id and auto shear mode. */
function sfHoles() {
    const holes = [];
    if (model.fastenerModelingMode === 'beam') {
        const beamNodeIds = new Set();
        model.beamElements.forEach(el => { beamNodeIds.add(el.node1Id); beamNodeIds.add(el.node2Id); });
        model.contactSpringElements.forEach(cs => {
            if (!beamNodeIds.has(cs.fastenerNodeId)) return;
            const ends = getFastenerColumnEnds(cs.fastenerId);
            const isEnd = ends && (ends.head.id === cs.fastenerNodeId || ends.tail.id === cs.fastenerNodeId);
            holes.push({ layerNodeId: cs.layerNodeId, fastenerId: cs.fastenerId, autoShear: isEnd ? 'single' : 'double' });
        });
    } else {
        const seen = new Map();
        model.fastenerElements.forEach(el => {
            [el.node1Id, el.node2Id].forEach(nid => {
                const h = seen.get(nid) || { layerNodeId: nid, fastenerId: el.fastenerId, count: 0 };
                h.count++;
                seen.set(nid, h);
            });
        });
        seen.forEach(h => holes.push({ layerNodeId: h.layerNodeId, fastenerId: h.fastenerId, autoShear: h.count > 1 ? 'double' : 'single' }));
    }
    return holes;
}

function computeSeverityFactors() {
    const g = getSfSettings();
    if (!model.layerElements.some(el => el.force !== 0)) throw new Error('No solved loads - solve the model first.');
    const rows = [];
    sfHoles().forEach(h => {
        const node = getNode(h.layerNodeId);
        const fastener = getFastener(h.fastenerId);
        if (!node || !fastener || node.isFixed) return;   // SF does not exist at restrained nodes
        const props = layerPropsAtNode(node.id);
        if (!props) return;
        const left = model.layerElements.find(el => el.node2Id === node.id);
        const right = model.layerElements.find(el => el.node1Id === node.id);
        const fL = left ? left.force : 0, fR = right ? right.force : 0;
        const adj = [left, right].filter(Boolean);
        const W = adj.reduce((s, el) => s + el.W, 0) / adj.length;
        const t = props.t, d = fastener.diameter;
        const dP = Math.abs(fR - fL);
        // total load at the hole = bypass + transfer (the larger adjacent load); bypass = what carries on past it
        const pTotal = Math.max(Math.abs(fL), Math.abs(fR));
        if (!(pTotal > 0)) return;
        const pBypass = Math.max(pTotal - dP, 0);
        const rp = dP / pTotal;
        const s = sfSettingsForHole(node.id);
        const shear = s.shear === 'auto' ? h.autoShear : s.shear;
        const theta = sfTheta(t / d, shear);
        const dW = d / W;
        const biax = 1 - SF_BIAX_COEFF * (s.biaxRatio || 0);
        const ktg = sfKtg(dW);
        const ktb = sfKtb(dW);
        const ktBend = sfKtBend(dW);
        const e2 = sfE2(theta, dW, rp);
        const ab = sfAlphaBetaGamma(s);
        const n = g.nFasteners > 0 ? g.nFasteners : 1;
        const kBypass = (s.grossStressFactor ?? 1) * ktg * biax * (pBypass / pTotal);
        const kTransfer = theta * ktb * rp * W / (n * d);
        const kBending = (s.btRatio || 0) * ktBend;
        const k = e2 * (kBypass + kTransfer) + kBending;
        const ssf = ab.total * k;
        // gross stress at the hole, the stress the non-dimensional K is referenced to
        const sGross = pTotal / (W * t);
        rows.push({
            layerNodeId: node.id, layerId: node.layer, fastenerId: h.fastenerId, shear, overridden: !!model.sfOverrides[node.id],
            t, d, W, pBypass, pTotal, dP, rp, theta, ktg, ktb, ktBend, e2, k,
            ab, kBypass, kTransfer, kBending, ssf, sGross, settings: s
        });
    });
    // SF_norm = SF x gross stress / max gross stress in any element, so the peak stress anywhere in the
    // configuration is SF_norm x (max gross stress)
    const maxGross = Math.max(...model.layerElements.map(el => Math.abs(el.force) / (el.W * el.t)), 0);
    rows.forEach(r => { r.sfNorm = maxGross > 0 ? r.ssf * r.sGross / maxGross : 0; });
    const maxSsf = Math.max(...rows.map(r => r.ssf), 0);
    const rank = key => rows.slice().sort((a, b) => b[key] - a[key]).forEach((r, i) => { r[key + 'Rank'] = i + 1; });
    rank('ssf');
    rank('sfNorm');
    return { rows, maxSsf, maxGross };
}

function readSfSettingsFromSidebar() {
    const g = getSfSettings();
    const num = (id, fallback) => { const v = parseFloat(document.getElementById(id).value); return isFinite(v) ? v : fallback; };
    g.fastenerType = document.getElementById('sf-fastener-type').value;
    g.userBeta = num('sf-user-beta', 1);
    g.holeType = document.getElementById('sf-hole-type').value;
    g.shear = document.getElementById('sf-shear').value;
    g.coldWorked = document.getElementById('sf-cold-worked').checked;
    g.cskRatio = num('sf-csk', 0);
    g.edgeMargin = num('sf-edge', 2);
    g.btRatio = num('sf-bt', 0);
    g.biaxRatio = num('sf-biax', 0);
    g.grossStressFactor = num('sf-gsf', 1);
    g.nFasteners = Math.max(1, Math.round(num('sf-n', 1)));
}

function populateSfSidebar() {
    const g = getSfSettings();
    const fill = (id, options) => {
        const sel = document.getElementById(id);
        if (sel && !sel.options.length) Object.keys(options).forEach(k => sel.add(new Option(k, k)));
    };
    fill('sf-fastener-type', SF_FASTENER_TYPES);
    fill('sf-hole-type', SF_HOLE_TYPES);
    document.getElementById('sf-fastener-type').value = g.fastenerType;
    document.getElementById('sf-user-beta').value = g.userBeta;
    document.getElementById('sf-user-beta-row').classList.toggle('hidden', g.fastenerType !== 'User Defined');
    document.getElementById('sf-hole-type').value = g.holeType;
    document.getElementById('sf-shear').value = g.shear;
    document.getElementById('sf-cold-worked').checked = g.coldWorked;
    document.getElementById('sf-csk').value = g.cskRatio;
    document.getElementById('sf-edge').value = g.edgeMargin;
    document.getElementById('sf-bt').value = g.btRatio;
    document.getElementById('sf-biax').value = g.biaxRatio;
    document.getElementById('sf-gsf').value = g.grossStressFactor;
    document.getElementById('sf-n').value = g.nFasteners;
}

let sfSelectedNodeId = null;
let sfLastText = '';

function renderSeverityFactors() {
    const content = document.getElementById('sf-content-table');
    let result;
    try {
        result = computeSeverityFactors();
    } catch (error) {
        content.innerHTML = `<p class="text-red-600">${error.message}</p>`;
        sfLastText = '';
        return;
    }
    const layerName = id => { const l = getLayer(id); return l ? l.name : `L${id}`; };
    const f = (v, dp) => isFinite(v) ? v.toFixed(dp) : '-';
    const headers = ['Node', 'Layer', 'Fastener', 'Shear', 't', 'd', 'W', 'Bypass (lbf)', 'Total (lbf)', 'dP (lbf)', 'R/P', 'theta', 'K_TG', 'K_TB',
        'e2', 'K', 'ab*g', 'SF', 'SF rank', 'Gross (psi)', 'SF_norm', 'SF_norm rank'];
    const rowsData = result.rows.map(r => [r.layerNodeId, layerName(r.layerId), r.fastenerId, r.shear + (r.overridden ? ' *' : ''),
        f(r.t, 4), f(r.d, 4), f(r.W, 3), f(r.pBypass, 2), f(r.pTotal, 2), f(r.dP, 2), f(r.rp, 3), f(r.theta, 3), f(r.ktg, 3), f(r.ktb, 3),
        f(r.e2, 3), f(r.k, 3), f(r.ab.total, 3), f(r.ssf, 3), r.ssfRank, f(r.sGross, 0), f(r.sfNorm, 3), r.sfNormRank]);

    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let html = `<p class="mb-2 text-gray-600">SF = &alpha;&beta;&gamma; &middot; {e<sub>2</sub>[K<sub>TG</sub>&middot;bypass/total + &theta;K<sub>TB</sub>(R/P)(W/d)] + BT&middot;K<sub>T,bend</sub>}, relative to the gross stress at the hole (total load / W t); independent of load level.
        R/P = dP / (bypass + dP). <b>SF_norm</b> = SF &times; gross stress / max gross stress in any element (<b>${f(result.maxGross, 0)} psi</b>):
        the peak stress at any hole is SF_norm &times; ${f(result.maxGross, 0)} psi, so SF_norm ranks every hole against one reference.
        Click a row to change that hole's settings; <b>*</b> = hole has its own settings.
        <span class="bg-rose-100 font-bold px-1">Highest SF</span> <span class="bg-amber-100 font-bold px-1">Highest SF_norm</span></p>`;
    html += '<table class="w-full border-collapse font-mono"><thead><tr>';
    headers.forEach(h => { html += `<th class="border border-gray-200 bg-gray-50 px-2 py-1 text-left">${esc(h)}</th>`; });
    html += '</tr></thead><tbody>';
    result.rows.forEach((r, i) => {
        const sel = r.layerNodeId === sfSelectedNodeId;
        const cls = sel ? 'bg-indigo-100' : r.sfNormRank === 1 ? 'bg-amber-100 font-bold'
            : r.ssfRank === 1 ? 'bg-rose-100 font-bold' : 'hover:bg-gray-50';
        html += `<tr class="cursor-pointer ${cls}" data-node="${r.layerNodeId}">` +
            rowsData[i].map(c => `<td class="border border-gray-200 px-2 py-0.5">${esc(c)}</td>`).join('') + '</tr>';
    });
    html += '</tbody></table>';
    content.innerHTML = html;
    if (vizShowSf) updateVisualization();
    content.querySelectorAll('tr[data-node]').forEach(tr => tr.addEventListener('click', () => {
        sfSelectedNodeId = parseInt(tr.dataset.node, 10);
        renderSfHoleEditor();
        renderSeverityFactors();
    }));

    // Fixed-width text
    const cells = [headers, ...rowsData].map(r => r.map(String));
    const widths = headers.map((_, i) => Math.max(...cells.map(r => r[i].length)));
    sfLastText = `SEVERITY FACTORS  (SF_norm reference = max gross stress ${f(result.maxGross, 0)} psi)\n\n` +
        cells.map((r, ri) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd() +
            (ri === 0 ? '\n' + widths.map(w => '-'.repeat(w)).join('  ') : '')).join('\n') + '\n';
}

function renderSfHoleEditor() {
    const box = document.getElementById('sf-hole-editor');
    if (sfSelectedNodeId === null || !getNode(sfSelectedNodeId)) { box.classList.add('hidden'); return; }
    const s = sfSettingsForHole(sfSelectedNodeId);
    const node = getNode(sfSelectedNodeId);
    const opts = (obj, cur) => Object.keys(obj).map(k => `<option ${k === cur ? 'selected' : ''}>${k}</option>`).join('');
    const field = (label, html) => `<label class="flex flex-col gap-0.5"><span class="text-gray-500">${label}</span>${html}</label>`;
    const numIn = (id, v, step) => `<input type="number" id="${id}" value="${v}" step="${step}" class="input-field text-xs w-24">`;
    box.innerHTML = `<div class="flex flex-wrap items-end gap-3">
        <div class="font-semibold text-rose-700">Hole at node ${node.id} (${getLayer(node.layer)?.name || ''})</div>
        ${field('Fastener type', `<select id="sfh-fastener" class="input-field text-xs">${opts(SF_FASTENER_TYPES, s.fastenerType)}</select>`)}
        ${field('User &beta;', numIn('sfh-user-beta', s.userBeta, 0.01))}
        ${field('Hole type', `<select id="sfh-hole" class="input-field text-xs">${opts(SF_HOLE_TYPES, s.holeType)}</select>`)}
        ${field('Shear', `<select id="sfh-shear" class="input-field text-xs">${['auto', 'single', 'double'].map(v => `<option ${v === s.shear ? 'selected' : ''}>${v}</option>`).join('')}</select>`)}
        ${field('Cold worked', `<input type="checkbox" id="sfh-cold" ${s.coldWorked ? 'checked' : ''}>`)}
        ${field('CSK Tcsk/T', numIn('sfh-csk', s.cskRatio, 0.05))}
        ${field('E/D', numIn('sfh-edge', s.edgeMargin, 0.1))}
        ${field('BT ratio', numIn('sfh-bt', s.btRatio, 0.05))}
        ${field('Biaxial', numIn('sfh-biax', s.biaxRatio, 0.05))}
        ${field('Gross stress factor', numIn('sfh-gsf', s.grossStressFactor, 0.05))}
        <button id="sfh-apply" class="btn-primary text-xs px-3">Apply to this hole</button>
        <button id="sfh-reset" class="btn-secondary text-xs px-3">Use defaults</button>
        <button id="sfh-close" class="btn-secondary text-xs px-3">Close</button>
    </div>`;
    box.classList.remove('hidden');
    const val = id => document.getElementById(id);
    val('sfh-apply').addEventListener('click', () => {
        pushUndo(`severity factor settings at node ${sfSelectedNodeId}`);
        const num = (id, fb) => { const v = parseFloat(val(id).value); return isFinite(v) ? v : fb; };
        model.sfOverrides[sfSelectedNodeId] = {
            fastenerType: val('sfh-fastener').value, userBeta: num('sfh-user-beta', 1), holeType: val('sfh-hole').value,
            shear: val('sfh-shear').value, coldWorked: val('sfh-cold').checked, cskRatio: num('sfh-csk', 0),
            edgeMargin: num('sfh-edge', 2), btRatio: num('sfh-bt', 0), biaxRatio: num('sfh-biax', 0), grossStressFactor: num('sfh-gsf', 1)
        };
        renderSeverityFactors();
    });
    val('sfh-reset').addEventListener('click', () => {
        if (model.sfOverrides[sfSelectedNodeId]) pushUndo(`reset severity factor settings at node ${sfSelectedNodeId}`);
        delete model.sfOverrides[sfSelectedNodeId];
        renderSfHoleEditor();
        renderSeverityFactors();
    });
    val('sfh-close').addEventListener('click', () => { sfSelectedNodeId = null; box.classList.add('hidden'); renderSeverityFactors(); });
}

function openSeverityFactors() {
    readSfSettingsFromSidebar();
    sfSelectedNodeId = null;
    renderSfHoleEditor();
    renderSeverityFactors();
    document.getElementById('sf-overlay').classList.remove('hidden');
}

// --- Model Summary ---

/**
 * Every element of the model with the properties and stiffnesses the solver uses
 * (and forces, once solved). Returns { html, text }; the text form is a fixed-width report.
 */
function buildModelSummary() {
    const sections = [];
    const num = (v, dp) => (v === null || v === undefined || !isFinite(v)) ? '-' : Number(v).toFixed(dp);
    const sci = v => (v === null || v === undefined || !isFinite(v)) ? '-' : Number(v).toExponential(4);
    const layerName = id => { const l = getLayer(id); return l ? l.name : `L${id}`; };
    const solved = model.layerElements.some(el => el.force !== 0);
    const isBeam = model.fastenerModelingMode === 'beam';

    sections.push({
        title: 'Solution Parameters',
        headers: ['Parameter', 'Value'],
        rows: [
            ['Fastener modelling', isBeam ? 'Timoshenko beam + bearing springs' : 'Tate & Rosenfeld shear springs'],
            ['Fastener compliance factor Cf', FASTENER_COMPLIANCE_FACTOR],
            ['Plate compliance factor Cp', PLATE_COMPLIANCE_FACTOR],
            ...(isBeam ? [
                ['Bearing spring', 'k = 1 / (Cf/(Ef t) + Cp/(E t))'],
                ['Beam length', '(t1 + t2)/2 between layer mid-planes'],
                ['Shear coefficient', 'kappa = 6(1+nu)/(7+6nu)'],
                ['End fixity', 'shank to head/collar face, rotation clamped there: k_rot = Ef I/(t/2)'],
                ['Layer t, E at a node', 'average of the layer elements either side'],
            ] : []),
            ['Solved', solved ? 'yes' : 'no'],
        ]
    });

    sections.push({
        title: 'Materials',
        headers: ['Material', 'E (psi)', 'nu'],
        rows: Object.entries(MATERIALS).map(([name, p]) => [name, num(p.E, 0), num(p.nu, 3)])
    });

    sections.push({
        title: 'Layer Elements',
        headers: ['El', 'Layer', 'Node1', 'Node2', 'Material', 'E (psi)', 't (in)', 'W (in)', 'L (in)', 'k=EA/L (lbf/in)', 'Force (lbf)', 'Stress (psi)'],
        rows: model.layerElements.map(el => {
            const E = MATERIALS[el.materialName] ? MATERIALS[el.materialName].E : NaN;
            const k = calculateLayerElementStiffness(el);
            return [el.id, layerName(el.layerId), el.node1Id, el.node2Id, el.materialName, num(E, 0), num(el.t, 4), num(el.W, 4),
                num(el.length, 4), sci(k), solved ? num(el.force, 3) : '-', solved ? num(el.force / (el.W * el.t), 1) : '-'];
        })
    });

    sections.push({
        title: 'Fasteners',
        headers: ['Fastener', 'Diameter (in)', 'Material', 'Ef (psi)', 'nu', 'Head layer', 'Tail layer'],
        rows: model.fasteners.map(f => {
            const m = MATERIALS[f.materialName] || {};
            const ends = isBeam ? getFastenerColumnEnds(f.id) : null;
            const springs = model.fastenerElements.filter(el => el.fastenerId === f.id);
            const layersOf = springs.flatMap(el => [getNode(el.node1Id), getNode(el.node2Id)]).filter(Boolean).map(n => n.layer);
            const head = ends ? ends.head.layerId : (layersOf.length ? Math.min(...layersOf) : null);
            const tail = ends ? ends.tail.layerId : (layersOf.length ? Math.max(...layersOf) : null);
            return [f.id, num(f.diameter, 4), f.materialName, num(m.E, 0), num(m.nu, 3),
                head === null ? '-' : layerName(head), tail === null ? '-' : layerName(tail)];
        })
    });

    if (isBeam) {
        const beamNodeIds = new Set();
        model.beamElements.forEach(el => { beamNodeIds.add(el.node1Id); beamNodeIds.add(el.node2Id); });

        sections.push({
            title: 'Bearing (Contact) Springs',
            headers: ['CS', 'Fastener', 'Layer', 'Layer node', 'Fastener node', 't used (in)', 'E used (psi)', 'k (lbf/in)', 'Force (lbf)'],
            rows: model.contactSpringElements.map(cs => {
                const active = beamNodeIds.has(cs.fastenerNodeId);
                const props = layerPropsAtNode(cs.layerNodeId);
                const k = active ? calculateBearingStiffness(cs) : 0;
                return [cs.id, cs.fastenerId, layerName(cs.layerId), cs.layerNodeId, cs.fastenerNodeId,
                    props ? num(props.t, 4) : '-', props ? num(props.E, 0) : '-',
                    active ? sci(k) : 'inactive', solved && active ? num(cs.force, 3) : '-'];
            })
        });

        sections.push({
            title: 'Fastener Beam Elements (Timoshenko)',
            headers: ['Beam', 'Fastener', 'From layer', 'To layer', 't1 (in)', 't2 (in)', 'L (in)', 'd (in)', 'I (in^4)', 'kappa', 'Phi', '12EI/(L^3(1+Phi)) (lbf/in)', 'Shear (lbf)'],
            rows: model.beamElements.map(el => {
                const r = calculateBeamElementStiffnessMatrix(el);
                const n1 = getFastenerNode(el.node1Id), n2 = getFastenerNode(el.node2Id);
                const p = el.props || {};
                return [el.id, el.fastenerId, n1 ? layerName(n1.layerId) : '-', n2 ? layerName(n2.layerId) : '-',
                    num(p.t1, 4), num(p.t2, 4), num(el.length, 4), num(p.d, 4), sci(p.I), num(p.kappa, 4), num(p.Phi, 4),
                    r ? sci(r.matrix[0][0]) : '-', solved ? num(el.force, 3) : '-'];
            })
        });

        sections.push({
            title: 'End Fixity (Head / Collar Rotational Springs)',
            headers: ['Fastener', 'End', 'Layer', 'Fastener node', 't (in)', 'k_rot (lbf.in/rad)', 'Rotation (rad)'],
            rows: model.fasteners.flatMap(f => {
                const ends = getFastenerColumnEnds(f.id);
                if (!ends) return [];
                return [['head', ends.head], ['tail', ends.tail]].map(([end, fn]) => {
                    const props = layerPropsAtNode(fn.correspondingLayerNodeId);
                    return [f.id, end, layerName(fn.layerId), fn.id, props ? num(props.t, 4) : '-',
                        sci(calculateEndRotationalStiffness(fn)), solved ? sci(fn.theta) : '-'];
                });
            })
        });
    } else {
        sections.push({
            title: 'Fastener Shear Springs (Tate & Rosenfeld)',
            headers: ['Spring', 'Fastener', 'Node1', 'Node2', 'Layer1', 'Layer2', 'k (lbf/in)', 'Force (lbf)'],
            rows: model.fastenerElements.map(el => {
                const n1 = getNode(el.node1Id), n2 = getNode(el.node2Id);
                return [el.id, el.fastenerId, el.node1Id, el.node2Id, n1 ? layerName(n1.layer) : '-', n2 ? layerName(n2.layer) : '-',
                    sci(calculateFastenerElementStiffness(el)), solved ? num(el.force, 3) : '-'];
            })
        });
    }

    sections.push({
        title: 'Layer Nodes, Boundary Conditions and Loads',
        headers: ['Node', 'Layer', 'Column', 'Condition', 'Applied', 'Displacement (in)'],
        rows: model.nodes.map(n => {
            let cond = '-', applied = '-';
            if (n.isFixed) cond = 'Fixed';
            else if (n.prescribedU !== null) { cond = 'Prescribed u'; applied = `${n.prescribedU} in`; }
            else if (n.F !== 0) { cond = 'Force'; applied = `${n.F} lbf`; }
            return [n.id, layerName(n.layer), n.nodeColIndex, cond, applied, solved ? sci(n.u) : '-'];
        })
    });

    // HTML
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    let html = '';
    sections.forEach(sec => {
        html += `<h3 class="font-bold text-gray-700 mt-4 mb-1">${esc(sec.title)}</h3>`;
        html += '<table class="w-full border-collapse font-mono"><thead><tr>';
        sec.headers.forEach(h => { html += `<th class="border border-gray-200 bg-gray-50 px-2 py-1 text-left">${esc(h)}</th>`; });
        html += '</tr></thead><tbody>';
        sec.rows.forEach(r => {
            html += '<tr>' + r.map(c => `<td class="border border-gray-200 px-2 py-0.5">${esc(c)}</td>`).join('') + '</tr>';
        });
        html += '</tbody></table>';
    });

    // Fixed-width text
    let text = `LOAD TRANSFER MODEL SUMMARY  (${new Date().toISOString().slice(0, 19).replace('T', ' ')})\n`;
    sections.forEach(sec => {
        const cells = [sec.headers, ...sec.rows].map(r => r.map(c => String(c)));
        const widths = sec.headers.map((_, i) => Math.max(...cells.map(r => (r[i] || '').length)));
        text += `\n${sec.title.toUpperCase()}\n`;
        cells.forEach((r, ri) => {
            text += r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd() + '\n';
            if (ri === 0) text += widths.map(w => '-'.repeat(w)).join('  ') + '\n';
        });
    });

    return { html, text };
}

function openModelSummary() {
    const overlay = document.getElementById('model-summary-overlay');
    const content = document.getElementById('model-summary-content');
    try {
        const summary = buildModelSummary();
        content.innerHTML = summary.html;
        overlay.dataset.text = summary.text;
    } catch (error) {
        console.error('Model summary error:', error);
        content.innerHTML = `<p class="text-red-600">Could not build the model summary: ${error.message}</p>`;
        overlay.dataset.text = '';
    }
    overlay.classList.remove('hidden');
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', () => {
    const summaryOverlay = document.getElementById('model-summary-overlay');
    document.getElementById('model-summary-btn').addEventListener('click', openModelSummary);
    document.getElementById('undo-btn').addEventListener('click', undo);
    populateSfSidebar();
    document.getElementById('sf-calc-btn').addEventListener('click', openSeverityFactors);
    document.getElementById('viz-sf-toggle').addEventListener('click', () => setVizShowSf(!vizShowSf));
    // sidebar SF defaults feed the SF_norm labels straight away
    document.getElementById('sf-content').addEventListener('change', () => {
        readSfSettingsFromSidebar();
        if (vizShowSf) updateVisualization();
    });
    document.getElementById('sf-close-btn').addEventListener('click', () => document.getElementById('sf-overlay').classList.add('hidden'));
    document.getElementById('sf-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(sfLastText)
            .then(() => showMessage('Severity factors copied to clipboard.', false))
            .catch(() => showMessage('Copy failed.'));
    });
    document.getElementById('sf-fastener-type').addEventListener('change', e =>
        document.getElementById('sf-user-beta-row').classList.toggle('hidden', e.target.value !== 'User Defined'));
    const loadInput = document.getElementById('load-model-input');
    document.getElementById('save-model-btn').addEventListener('click', saveModel);
    document.getElementById('load-model-btn').addEventListener('click', () => loadInput.click());
    loadInput.addEventListener('change', () => {
        if (loadInput.files[0]) loadModelFile(loadInput.files[0]);
        loadInput.value = '';
    });
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' &&
            !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
            e.preventDefault();
            undo();
        }
    });
    document.getElementById('model-summary-close-btn').addEventListener('click', () => summaryOverlay.classList.add('hidden'));
    document.getElementById('model-summary-copy-btn').addEventListener('click', () => {
        navigator.clipboard.writeText(summaryOverlay.dataset.text || '')
            .then(() => showMessage('Model summary copied to clipboard.', false))
            .catch(() => showMessage('Copy failed - use Download .txt instead.'));
    });
    document.getElementById('model-summary-download-btn').addEventListener('click', () => {
        const blob = new Blob([summaryOverlay.dataset.text || ''], { type: 'text/plain' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'load-transfer-model-summary.txt';
        a.click();
        URL.revokeObjectURL(a.href);
    });

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

    if (fastenerModelingModeRadios) {
        fastenerModelingModeRadios.forEach(radio => {
            radio.addEventListener('change', function () {
                model.fastenerModelingMode = this.value;
                console.log("Fastener modeling mode changed to:", model.fastenerModelingMode);
                generateInitialModel(); // Regenerate model to adjust topology
                resultsSummaryDiv.innerHTML = `<p class="text-orange-600">Fastener modeling mode changed to ${this.value.toUpperCase()}. Model regenerated. Please re-solve.</p>`;
            });
        });
    }

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
