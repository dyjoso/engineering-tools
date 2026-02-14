/**
 * base.js — Base class for crack geometry definitions
 * 
 * All geometry cases (TC01, TC23, etc.) extend this class and implement
 * the required methods. This allows the UI and engine to work with any
 * registered geometry without knowing its internals.
 */

class CrackGeometry {
    /**
     * @param {string} id    - Unique identifier (e.g. 'TC01')
     * @param {string} label - Display name (e.g. 'Through Crack at Center of Plate')
     */
    constructor(id, label) {
        this.id = id;
        this.label = label;
    }

    /**
     * Return the geometry correction factor β for the current crack size.
     * @param {number} a      - Half-crack length [in]
     * @param {object} params - Geometry parameters (W, t, etc.)
     * @returns {number} β (dimensionless), or -1 if geometry limit exceeded
     */
    getBeta(a, params) {
        throw new Error('getBeta() must be implemented by subclass');
    }

    /**
     * Calculate the Mode I stress intensity factor.
     * Default: K = σ · √(πa) · β
     * Override in subclass if the SIF formula differs (e.g. hole geometries).
     * @param {number} a      - Half-crack length [in]
     * @param {number} sigma  - Applied remote stress [ksi]
     * @param {object} params - Geometry parameters
     * @returns {number} K [ksi√in], or -1 if invalid
     */
    getK(a, sigma, params) {
        const beta = this.getBeta(a, params);
        if (beta < 0) return -1;
        return sigma * Math.sqrt(Math.PI * a) * beta;
    }

    /**
     * Maximum valid half-crack length for this geometry.
     * @param {object} params - Geometry parameters
     * @returns {number} Maximum a [in]
     */
    getMaxCrack(params) {
        throw new Error('getMaxCrack() must be implemented by subclass');
    }

    /**
     * Net-section stress for failure check.
     * Default: σ_net = σ · W / (W - 2a)  (center crack in plate)
     * Override for other geometries.
     * @param {number} a      - Half-crack length [in]
     * @param {number} sigma  - Applied remote stress [ksi]
     * @param {object} params - Geometry parameters
     * @returns {number} Net-section stress [ksi]
     */
    getNetSectionStress(a, sigma, params) {
        const W = params.W;
        return sigma * W / (W - 2 * a);
    }

    /**
     * Return an array of input field definitions for this geometry.
     * Each field: { id, label, unit, default, step, min }
     * Used by the UI to dynamically build the geometry input section.
     * @returns {Array<object>}
     */
    getInputFields() {
        throw new Error('getInputFields() must be implemented by subclass');
    }

    /**
     * Draw a schematic diagram of the geometry on a canvas 2D context.
     * @param {CanvasRenderingContext2D} ctx
     * @param {object} params - Geometry parameters
     * @param {number} a      - Current half-crack length
     * @param {number} width  - Canvas width
     * @param {number} height - Canvas height
     */
    drawDiagram(ctx, params, a, width, height) {
        // Default: clear canvas with a placeholder message
        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#64748b';
        ctx.font = '14px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No diagram available', width / 2, height / 2);
    }

    /**
     * Whether this geometry tracks two independent crack tips.
     * Override to return true for dual-crack geometries (e.g. TC23 with offset/unequal).
     * @returns {boolean}
     */
    isDualCrack() {
        return false;
    }
}

// Geometry registry — add new geometries here
const GEOMETRY_REGISTRY = {};

/**
 * Register a geometry class instance.
 * @param {CrackGeometry} geom
 */
function registerGeometry(geom) {
    GEOMETRY_REGISTRY[geom.id] = geom;
}

/**
 * Get a registered geometry by ID.
 * @param {string} id
 * @returns {CrackGeometry}
 */
function getGeometry(id) {
    if (!GEOMETRY_REGISTRY[id]) {
        throw new Error(`Unknown geometry: ${id}`);
    }
    return GEOMETRY_REGISTRY[id];
}

/**
 * Get all registered geometry IDs and labels.
 * @returns {Array<{id: string, label: string}>}
 */
function getGeometryList() {
    return Object.values(GEOMETRY_REGISTRY).map(g => ({
        id: g.id,
        label: g.label
    }));
}
