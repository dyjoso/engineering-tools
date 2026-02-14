/**
 * materials.js — NASGRO material property definitions
 * 
 * 30 aluminium + steel + titanium alloys from NASGRO database.
 * Units: Imperial (ksi, in, ksi√in)
 *
 * Field reference (per NASGRO material input):
 *   UTS, Yield      Tensile strengths [ksi]
 *   K1e             Plane-stress fracture toughness [ksi√in]
 *   K1c             Plane-strain fracture toughness [ksi√in]
 *   Ak, Bk          Kc thickness-fit parameters
 *   a0_intr         Intrinsic crack length for threshold [in]
 *   Kth_ratio       ΔKth(short) / ΔKth(long)
 *   C, n, p, q      NASGRO equation constants (da/dN)
 *   DK1             ΔK threshold at R → 1 [ksi√in]
 *   Cth_plus        Threshold curve-fit coeff (R ≥ 0)
 *   Cth_minus       Threshold curve-fit coeff (R < 0)
 *   alpha           Newman constraint factor
 *   Smax_S0         Smax / σ₀ ratio
 *   alpha_th        Threshold constraint factor
 *   Smax_S0_th      Threshold Smax / σ₀ ratio
 */

const MATERIALS = {
    '2024-T3-Clad-Bare-LT': {
        name: '2024-T3, Clad & Bare, L-T, LA & HHA',
        UTS: 66.0, Yield: 53.0, K1e: 42.0, K1c: 30.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 8.0e-9, n: 3.20, p: 0.25, q: 1.00,
        DK1: 1.22, Cth_plus: 1.21, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T3-Clad-Bare-TL': {
        name: '2024-T3, Clad & Bare, T-L, LA & HHA',
        UTS: 65.0, Yield: 48.0, K1e: 37.0, K1c: 27.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.3e-8, n: 3.00, p: 0.25, q: 1.00,
        DK1: 1.00, Cth_plus: 1.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T351-Plt-Sht-LT': {
        name: '2024-T351, Plt & Sht, L-T, LA & HHA',
        UTS: 68.0, Yield: 54.0, K1e: 48.0, K1c: 34.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 4.0e-9, n: 3.60, p: 0.50, q: 1.00,
        DK1: 0.80, Cth_plus: 2.20, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T351-Plt-Sht-TL': {
        name: '2024-T351, Plt & Sht, T-L, LA & HHA',
        UTS: 68.0, Yield: 52.0, K1e: 39.0, K1c: 28.0, Ak: 1.0, Bk: 0.75,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.8e-8, n: 3.00, p: 0.50, q: 1.00,
        DK1: 0.74, Cth_plus: 2.20, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T3511-Extr-LT': {
        name: '2024-T3511, Extr, L-T, LA & HHA',
        UTS: 77.0, Yield: 55.0, K1e: 48.0, K1c: 35.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 4.0e-9, n: 3.50, p: 0.50, q: 1.00,
        DK1: 1.00, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T42-Plt-Sht-LT': {
        name: '2024-T42, Plt & Sht, L-T, LA',
        UTS: 68.5, Yield: 43.0, K1e: 44.0, K1c: 32.0, Ak: 1.0, Bk: 0.75,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 8.0e-9, n: 3.10, p: 0.40, q: 0.50,
        DK1: 1.28, Cth_plus: 0.88, Cth_minus: 0.56,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2024-T42-Plt-Sht-TL': {
        name: '2024-T42, Plt & Sht, T-L, LA',
        UTS: 68.0, Yield: 42.0, K1e: 40.0, K1c: 29.0, Ak: 1.0, Bk: 0.95,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.4e-8, n: 2.70, p: 0.80, q: 0.40,
        DK1: 1.20, Cth_plus: 1.60, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2224-T3511-Ext-LT': {
        name: '2224-T3511, Ext, L-T, LA or 50% HA',
        UTS: 80.0, Yield: 60.0, K1e: 42.0, K1c: 30.0, Ak: 0.75, Bk: 1.75,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 9.5e-9, n: 2.80, p: 0.50, q: 1.80,
        DK1: 1.09, Cth_plus: 0.88, Cth_minus: 0.00,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2324-T39-Plt-Sht-LT': {
        name: '2324-T39, Plt & Sht, L-T, LA & HHA',
        UTS: 72.0, Yield: 65.0, K1e: 55.0, K1c: 39.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 6.0e-9, n: 3.20, p: 0.25, q: 1.00,
        DK1: 0.74, Cth_plus: 2.20, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '2524-T3-Clad-Plt-Sht': {
        name: '2524-T3, Clad Plt & Sht, L-T/T-L, DA',
        UTS: 60.0, Yield: 40.0, K1e: 32.0, K1c: 23.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.5e-9, n: 3.00, p: 0.50, q: 1.00,
        DK1: 1.50, Cth_plus: 0.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T6-Clad-Sht': {
        name: '7075-T6, Clad Sht, L-T/T-L, LA',
        UTS: 76.0, Yield: 67.0, K1e: 27.0, K1c: 21.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.6e-8, n: 3.00, p: 0.50, q: 1.00,
        DK1: 0.75, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T6-Plt-Sht-LT': {
        name: '7075-T6, Plt & Sht, L-T, LA',
        UTS: 85.0, Yield: 75.0, K1e: 37.0, K1c: 25.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 7.0e-8, n: 2.40, p: 1.00, q: 1.00,
        DK1: 0.90, Cth_plus: 1.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T6-Plt-Sht-TL': {
        name: '7075-T6, Plt & Sht, T-L, LA',
        UTS: 85.0, Yield: 75.0, K1e: 37.0, K1c: 25.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 7.0e-8, n: 2.40, p: 1.00, q: 1.00,
        DK1: 0.90, Cth_plus: 1.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T651-Plt-Sht-LT': {
        name: '7075-T651 Plt & Sht, L-T, LA',
        UTS: 85.0, Yield: 75.0, K1e: 38.0, K1c: 28.0, Ak: 0.75, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 3.0e-8, n: 2.80, p: 0.50, q: 1.00,
        DK1: 0.70, Cth_plus: 1.30, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T73-Forging-LT': {
        name: '7075-T73, Forging, L-T, LA',
        UTS: 73.0, Yield: 63.0, K1e: 40.0, K1c: 30.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 6.0e-9, n: 3.77, p: 0.50, q: 0.50,
        DK1: 0.70, Cth_plus: 3.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T6511-Extr-LT': {
        name: '7075-T6511 Extrusion, L-T, LA / HHA',
        UTS: 87.0, Yield: 80.0, K1e: 38.0, K1c: 28.0, Ak: 0.75, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 3.0e-8, n: 2.80, p: 0.50, q: 1.00,
        DK1: 0.60, Cth_plus: 2.10, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T7351-Plt-LT': {
        name: '7075-T7351, Plt, L-T, LA / DA',
        UTS: 73.0, Yield: 63.0, K1e: 44.0, K1c: 32.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.2e-8, n: 2.90, p: 0.50, q: 0.50,
        DK1: 0.70, Cth_plus: 2.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T7351-Plt-TL': {
        name: '7075-T7351, Plt, T-L, LA',
        UTS: 73.0, Yield: 63.0, K1e: 36.0, K1c: 25.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.5e-8, n: 3.30, p: 0.75, q: 0.75,
        DK1: 0.71, Cth_plus: 2.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T73511-Ext-TL': {
        name: '7075-T73511, Ext, T-L, LA',
        UTS: 77.0, Yield: 67.0, K1e: 50.0, K1c: 40.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.0e-8, n: 3.00, p: 0.50, q: 0.50,
        DK1: 0.85, Cth_plus: 2.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T76-Sht-LT': {
        name: '7075-T76, Sht, L-T, LA / DA',
        UTS: 75.0, Yield: 68.0, K1e: 41.0, K1c: 30.0, Ak: 1.0, Bk: 2.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.5e-8, n: 2.80, p: 0.50, q: 0.50,
        DK1: 0.75, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7075-T76-Sht-TL': {
        name: '7075-T76, Sht, T-L, HHA',
        UTS: 75.0, Yield: 68.0, K1e: 34.0, K1c: 25.0, Ak: 1.0, Bk: 2.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 5.0e-8, n: 2.80, p: 0.50, q: 0.50,
        DK1: 0.75, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7050-T7451-Plt-LT': {
        name: '7050-T7451, Plt, L-T, LA',
        UTS: 78.0, Yield: 68.0, K1e: 38.0, K1c: 27.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 4.3e-8, n: 2.50, p: 1.00, q: 1.00,
        DK1: 0.80, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7050-T651-Plt-LT': {
        name: '7050-T651, Plt, L-T, LA',
        UTS: 79.0, Yield: 70.0, K1e: 43.0, K1c: 33.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 1.7e-8, n: 3.00, p: 0.50, q: 0.50,
        DK1: 0.65, Cth_plus: 1.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7050-T6511-Ext-LT': {
        name: '7050-T6511, Ext, L-T, LA',
        UTS: 87.0, Yield: 80.0, K1e: 43.0, K1c: 33.0, Ak: 1.0, Bk: 1.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.6e-8, n: 2.75, p: 0.50, q: 0.50,
        DK1: 0.75, Cth_plus: 1.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7150-T651-Plt-LT': {
        name: '7150-T651, Plt, L-T, LA',
        UTS: 70.0, Yield: 58.0, K1e: 37.0, K1c: 27.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.5e-8, n: 3.00, p: 1.00, q: 1.00,
        DK1: 0.75, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7150-T7751-Plt-LT': {
        name: '7150-T7751, Plt, L-T, LA',
        UTS: 87.0, Yield: 81.0, K1e: 37.0, K1c: 27.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.0e-8, n: 3.00, p: 0.25, q: 0.25,
        DK1: 0.70, Cth_plus: 2.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7178-T7651-Plt': {
        name: '7178-T7651, Plt, L-T & T-L, LA',
        UTS: 80.0, Yield: 71.0, K1e: 34.0, K1c: 26.0, Ak: 1.0, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 5.0e-8, n: 2.50, p: 0.50, q: 0.50,
        DK1: 0.70, Cth_plus: 1.70, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7475-T651-Plt-LT': {
        name: '7475-T651, Plt, L-T, LA / HHA',
        UTS: 82.0, Yield: 74.0, K1e: 49.0, K1c: 35.0, Ak: 1.0, Bk: 2.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 7.0e-8, n: 2.80, p: 0.50, q: 1.00,
        DK1: 0.75, Cth_plus: 3.00, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '7010-T7451-Plt-LT': {
        name: '7010-T7451, Plt, L-T, LA',
        UTS: 73.0, Yield: 61.0, K1e: 38.0, K1c: 28.0, Ak: 1.0, Bk: 0.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.5e-8, n: 2.70, p: 0.50, q: 1.00,
        DK1: 0.75, Cth_plus: 2.50, Cth_minus: 0.10,
        alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    '15-5PH-H900-Plt-Sht': {
        name: '15-5 PH H900 Plt & Sht, C-R, LA',
        UTS: 190.0, Yield: 170.0, K1e: 65.0, K1c: 50.0, Ak: 0.75, Bk: 0.50,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 7.8e-11, n: 4.00, p: 0.25, q: 0.25,
        DK1: 1.97, Cth_plus: 1.36, Cth_minus: 0.10,
        alpha: 2.5, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    },
    'Ti-6Al-4V-MA-Plt-LT': {
        name: 'Ti-6Al-4V MA, Plt, L-T, LA',
        UTS: 146.0, Yield: 138.0, K1e: 65.0, K1c: 50.0, Ak: 1.00, Bk: 1.00,
        a0_intr: 0.0015, Kth_ratio: 0.2,
        C: 2.5e-9, n: 3.00, p: 0.50, q: 0.75,
        DK1: 2.10, Cth_plus: 0.00, Cth_minus: 0.10,
        alpha: 2.5, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
    }
};

/**
 * Get a deep copy of a material by key.
 * @param {string} key - Material identifier
 * @returns {object} Material property object
 */
function getMaterial(key) {
    if (!MATERIALS[key]) {
        throw new Error(`Unknown material: ${key}`);
    }
    return JSON.parse(JSON.stringify(MATERIALS[key]));
}

/**
 * Get list of available material keys.
 * @returns {string[]}
 */
function getMaterialKeys() {
    return Object.keys(MATERIALS);
}

/**
 * Build a material object from individual UI values.
 * @param {object} values - Key-value pairs matching material property names
 * @returns {object} Material property object
 */
function buildMaterialFromInputs(values) {
    return {
        name: values.name || 'Custom',
        UTS: parseFloat(values.UTS),
        Yield: parseFloat(values.Yield),
        K1e: parseFloat(values.K1e),
        K1c: parseFloat(values.K1c),
        Ak: parseFloat(values.Ak),
        Bk: parseFloat(values.Bk),
        a0_intr: parseFloat(values.a0_intr),
        Kth_ratio: parseFloat(values.Kth_ratio),
        C: parseFloat(values.C),
        n: parseFloat(values.n),
        p: parseFloat(values.p),
        q: parseFloat(values.q),
        DK1: parseFloat(values.DK1),
        Cth_plus: parseFloat(values.Cth_plus),
        Cth_minus: parseFloat(values.Cth_minus),
        alpha: parseFloat(values.alpha),
        Smax_S0: parseFloat(values.Smax_S0),
        alpha_th: parseFloat(values.alpha_th),
        Smax_S0_th: parseFloat(values.Smax_S0_th)
    };
}
