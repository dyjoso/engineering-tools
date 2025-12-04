// --- Material Definitions ---
const MATERIALS = {
    "Aluminum": { E: 10.5e6, nu: 0.33 }, // psi, Poisson's Ratio
    "Titanium": { E: 16.5e6, nu: 0.31 }, // psi, Poisson's Ratio
    "Steel": { E: 29.5e6, nu: 0.30 }  // psi, Poisson's Ratio
};

// --- Global Variables ---
let model = {
    nodes: [],
    layers: [],
    fasteners: [],
    layerElements: [],
    fastenerElements: [],
    numLayers: 0,
    numFasteners: 0,
    defaultSegmentLength: 4.0, // inches
    fastenerMaterialName: "Steel", // Default fastener material
};
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
        model.layers = [];
        model.fasteners = [];
        model.layerElements = [];
        model.fastenerElements = [];

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

        let fastenerElementId = 0;
        for (let j = 0; j < model.numFasteners; j++) {
            for (let i = 0; i < model.numLayers - 1; i++) {
                const nodeColIndex = j + 1;
                const node1Id = i * numNodeCols + nodeColIndex;
                const node2Id = (i + 1) * numNodeCols + nodeColIndex;
                model.fastenerElements.push({
                    id: fastenerElementId++,
                    node1Id: node1Id,
                    node2Id: node2Id,
                    fastenerId: j,
                    stiffness: 0,
                    force: 0
                });
            }
        }

        console.log("Model generated:", model);
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
        model.nodes = []; model.layers = []; model.fasteners = []; model.layerElements = []; model.fastenerElements = [];
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

    model.fastenerElements.forEach(el => {
        const node1 = getNode(el.node1Id);
        const node2 = getNode(el.node2Id);
        if (!node1 || !node2) { console.warn(`Nodes not found for Fastener El ${el.id}`); return; }

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', node1.x); line.setAttribute('y1', node1.y);
        line.setAttribute('x2', node2.x); line.setAttribute('y2', node2.y);
        line.setAttribute('class', 'fastener-element');
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
        }

        if (showForces && el.force !== undefined && !isNaN(el.force)) {
            const forceLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            forceLabel.setAttribute('x', node1.x + 5); forceLabel.setAttribute('y', (node1.y + node2.y) / 2);
            forceLabel.setAttribute('class', 'force-label');
            forceLabel.textContent = `${el.force.toFixed(1)} lbf`;
            visualizationSVG.appendChild(forceLabel);
        }
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
    console.log("Starting solver...");
    resultsSummaryDiv.innerHTML = '<p>Solving...</p>';
    updateVisualization(false);

    // Delay to allow UI to update
    setTimeout(() => {
        try {
            if (model.nodes.length === 0) throw new Error("No nodes in model to solve.");

            // 1. Assign Degrees of Freedom (DOF)
            let dofCounter = 0;
            const nodeIdToIndexMap = new Map();
            model.nodes.forEach(node => {
                nodeIdToIndexMap.set(node.id, dofCounter++);
            });
            const N_solve = dofCounter;
            console.log(`System DOF: ${N_solve}`);

            // 2. Initialize Global Stiffness Matrix (K) and Force Vector (F)
            // Using math.js sparse matrices for efficiency
            let K_global = math.zeros(N_solve, N_solve, 'sparse');
            let F_global = math.zeros(N_solve);

            // 3. Assemble Stiffness Matrix
            console.log("Assembling Global Stiffness Matrix K...");

            model.layerElements.forEach(el => {
                const i_idx = nodeIdToIndexMap.get(el.node1Id);
                const j_idx = nodeIdToIndexMap.get(el.node2Id);
                const k = calculateLayerElementStiffness(el);
                el.stiffness = k;

                if (i_idx === undefined || j_idx === undefined) {
                    throw new Error(`Node index not found for Layer Element ${el.id}.`);
                }
                if (isNaN(k) || !isFinite(k)) {
                    throw new Error(`Invalid stiffness calculated for Layer Element ${el.id} (k=${k}). Check properties.`);
                }

                const currentKi = math.subset(K_global, math.index(i_idx, i_idx));
                const currentKj = math.subset(K_global, math.index(j_idx, j_idx));
                const currentKij = math.subset(K_global, math.index(i_idx, j_idx));
                const currentKji = math.subset(K_global, math.index(j_idx, i_idx));

                K_global = math.subset(K_global, math.index(i_idx, i_idx), math.add(currentKi === undefined ? 0 : currentKi, k));
                K_global = math.subset(K_global, math.index(j_idx, j_idx), math.add(currentKj === undefined ? 0 : currentKj, k));
                K_global = math.subset(K_global, math.index(i_idx, j_idx), math.subtract(currentKij === undefined ? 0 : currentKij, k));
                K_global = math.subset(K_global, math.index(j_idx, i_idx), math.subtract(currentKji === undefined ? 0 : currentKji, k));
            });

            model.fastenerElements.forEach(el => {
                const i_idx = nodeIdToIndexMap.get(el.node1Id);
                const j_idx = nodeIdToIndexMap.get(el.node2Id);
                const k = calculateFastenerElementStiffness(el);
                el.stiffness = k;

                if (i_idx === undefined || j_idx === undefined) {
                    throw new Error(`Node index not found for Fastener Element ${el.id}.`);
                }
                if (isNaN(k) || k <= 0 || !isFinite(k)) {
                    throw new Error(`Invalid stiffness calculated for Fastener Element ${el.id} (k=${k}). Check properties.`);
                }

                const currentKi = math.subset(K_global, math.index(i_idx, i_idx));
                const currentKj = math.subset(K_global, math.index(j_idx, j_idx));
                const currentKij = math.subset(K_global, math.index(i_idx, j_idx));
                const currentKji = math.subset(K_global, math.index(j_idx, i_idx));

                K_global = math.subset(K_global, math.index(i_idx, i_idx), math.add(currentKi === undefined ? 0 : currentKi, k));
                K_global = math.subset(K_global, math.index(j_idx, j_idx), math.add(currentKj === undefined ? 0 : currentKj, k));
                K_global = math.subset(K_global, math.index(i_idx, j_idx), math.subtract(currentKij === undefined ? 0 : currentKij, k));
                K_global = math.subset(K_global, math.index(j_idx, i_idx), math.subtract(currentKji === undefined ? 0 : currentKji, k));
            });

            console.log("Assembling Global Force Vector F (lbf)...");
            model.nodes.forEach(node => {
                if (node.F !== 0 && node.prescribedU === null) {
                    const node_idx = nodeIdToIndexMap.get(node.id);
                    if (node_idx === undefined) {
                        throw new Error(`Node index not found in map for Force application at Node ${node.id}.`);
                    }
                    const currentF = math.subset(F_global, math.index(node_idx));
                    F_global = math.subset(F_global, math.index(node_idx), math.add(currentF === undefined ? 0 : currentF, node.F));
                }
            });

            console.log("Applying Boundary Conditions (Penalty Method)...");
            let max_diag = 0;
            for (let i = 0; i < N_solve; i++) {
                const diagVal = math.subset(K_global, math.index(i, i));
                if (typeof diagVal === 'number' && isFinite(diagVal)) {
                    max_diag = Math.max(max_diag, Math.abs(diagVal));
                } else if (diagVal !== undefined) {
                    console.warn(`Non-numeric or infinite diagonal value found at K[${i},${i}]:`, diagVal);
                }
            }
            const penaltyStiffness = max_diag > 1e-9 ? max_diag * 1e8 : 1e8;
            if (!isFinite(penaltyStiffness)) {
                throw new Error("Calculated invalid penalty stiffness (Infinite or NaN). Check K matrix diagonals.");
            }
            console.log("Penalty Stiffness:", penaltyStiffness.toExponential(3));

            let constrainedIndicesInfo = [];
            model.nodes.forEach(node => {
                let applyPenalty = false;
                let prescribedDisp = 0;
                const node_idx = nodeIdToIndexMap.get(node.id);

                if (node_idx === undefined) {
                    throw new Error(`Node index not found in map during BC application at Node ${node.id}.`);
                }

                if (node.isFixed) {
                    applyPenalty = true;
                    prescribedDisp = 0;
                    constrainedIndicesInfo.push({ id: node.id, index: node_idx, type: 'Fixed' });
                } else if (node.prescribedU !== null) {
                    applyPenalty = true;
                    prescribedDisp = node.prescribedU;
                    if (isNaN(prescribedDisp) || !isFinite(prescribedDisp)) {
                        throw new Error(`Invalid prescribed displacement value (${prescribedDisp}) for Node ${node.id}.`);
                    }
                    constrainedIndicesInfo.push({ id: node.id, index: node_idx, type: 'Disp', value: prescribedDisp });
                }

                if (applyPenalty) {
                    const currentKValue = math.subset(K_global, math.index(node_idx, node_idx));
                    const newKValue = math.add(currentKValue === undefined ? 0 : currentKValue, penaltyStiffness);
                    K_global = math.subset(K_global, math.index(node_idx, node_idx), newKValue);

                    const currentFValue = math.subset(F_global, math.index(node_idx));
                    const penaltyForce = penaltyStiffness * prescribedDisp;
                    const newFValue = math.add(currentFValue === undefined ? 0 : currentFValue, penaltyForce);
                    F_global = math.subset(F_global, math.index(node_idx), newFValue);
                }
            });
            if (constrainedIndicesInfo.length === 0) {
                throw new Error("Solver Error: No boundary conditions were identified for application on remaining nodes.");
            }
            console.log("Applied BCs to nodes (ID/Index):", constrainedIndicesInfo);


            console.log("Solving KU=F using LU decomposition...");
            const F_col_vector = math.reshape(F_global, [N_solve, 1]);
            const U_solution_matrix = math.lusolve(K_global, F_col_vector);
            console.log("Solver finished.");

            model.nodes.forEach((node) => {
                const node_idx = nodeIdToIndexMap.get(node.id);
                if (node_idx !== undefined) {
                    const displacement = U_solution_matrix.get([node_idx, 0]);
                    if (isNaN(displacement) || !isFinite(displacement)) {
                        console.warn(`Invalid displacement calculated for node ${node.id} (index ${node_idx}). Setting to 0.`);
                        node.u = 0;
                    } else {
                        node.u = displacement;
                    }
                } else {
                    console.warn(`Node ${node.id} not found in index map during post-processing.`);
                    node.u = 0;
                }
            });

            model.layerElements.forEach(el => {
                const n1 = getNode(el.node1Id);
                const n2 = getNode(el.node2Id);
                if (n1 && n2) {
                    el.force = el.stiffness * (n2.u - n1.u);
                    if (isNaN(el.force) || !isFinite(el.force)) {
                        console.warn(`NaN/Infinite force calculated for Layer El ${el.id}.`);
                        el.force = NaN;
                    }
                } else {
                    console.warn(`Nodes ${el.node1Id} or ${el.node2Id} not found for Layer El ${el.id} during force calculation.`);
                    el.force = NaN;
                }
            });

            model.fastenerElements.forEach(el => {
                const n1 = getNode(el.node1Id);
                const n2 = getNode(el.node2Id);
                if (n1 && n2) {
                    el.force = el.stiffness * (n2.u - n1.u);
                    if (isNaN(el.force) || !isFinite(el.force)) {
                        console.warn(`NaN/Infinite force calculated for Fastener El ${el.id}.`);
                        el.force = NaN;
                    }
                } else {
                    console.warn(`Nodes ${el.node1Id} or ${el.node2Id} not found for Fastener El ${el.id} during force calculation.`);
                    el.force = NaN;
                }
            });

            displayResults();
            updateVisualization(true);
            showMessage("Solution successful!", false);

        } catch (error) {
            let errorMessage = error.message;
            if (error.data && error.data.category === 'tooFewArgs' && error.data.fn === 'add') {
                errorMessage = `math.add error during BC application (likely sparse matrix issue): ${error.message}`;
            }
            showMessage(`Solver Error: ${errorMessage}`);
            console.error("Solver Error Details:", error);
            resultsSummaryDiv.innerHTML = `<p class="text-red-600">Solver failed: ${errorMessage}. Check console for details.</p>`;
            model.nodes.forEach(node => node.u = 0);
            model.layerElements.forEach(el => el.force = 0);
            model.fastenerElements.forEach(el => el.force = 0);
            updateVisualization(false);
        }
    }, 100);
}

// --- Results Display ---
function displayResults() {
    let html = '<div class="space-y-4">';

    html += '<div class="bg-gray-50 p-3 rounded border border-gray-200">';
    html += '<h4 class="font-semibold text-sm text-gray-700 mb-2">Layer Element Forces (lbf)</h4>';
    html += '<div class="max-h-40 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.layerElements.forEach(el => {
        const layer = getLayer(el.layerId);
        const layerName = layer ? layer.name : `L${el.layerId}`;
        html += `<li class="flex justify-between"><span>El ${el.id} (${layerName}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
    });
    html += '</ul></div></div>';

    html += '<div class="bg-gray-50 p-3 rounded border border-gray-200">';
    html += '<h4 class="font-semibold text-sm text-gray-700 mb-2">Fastener Element Forces (lbf)</h4>';
    html += '<div class="max-h-40 overflow-y-auto custom-scrollbar pr-2"><ul class="text-xs space-y-1">';
    model.fastenerElements.forEach(el => {
        html += `<li class="flex justify-between"><span>El ${el.id} (Col ${el.fastenerId}):</span> <span class="font-mono">${isNaN(el.force) ? 'NaN' : el.force.toFixed(2)}</span></li>`;
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
