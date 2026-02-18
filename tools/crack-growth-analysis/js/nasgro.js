/**
 * nasgro.js — NASGRO crack growth rate equation
 * 
 * Implements the full NASGRO equation:
 *   da/dN = C · [(1-f)/(1-R) · ΔK]^n · [(1 - ΔKth/ΔK)^p / (1 - Kmax/Kc)^q]
 * 
 * Includes:
 *   - Newman crack closure function (f)
 *   - R-dependent threshold (ΔKth) with Cth+/Cth- fanning
 *   - Thickness-dependent Kc
 * 
 * Units: Imperial (ksi, in, ksi√in)
 */

const NasgroEquation = {

    /**
     * Newman crack closure function — crack opening ratio f = Kop/Kmax.
     * 
     * For R ≥ 0:  f = max(R, A0 + A1·R + A2·R² + A3·R³)
     * For -2 ≤ R < 0:  f = A0 + A1·R
     * 
     * @param {number} R       - Stress ratio (Smin/Smax)
     * @param {number} alpha   - Constraint factor (1=plane strain, 2=plane stress)
     * @param {number} Smax_S0 - Ratio of max stress to flow stress
     * @returns {number} f (crack opening ratio)
     */
    newmanClosure(R, alpha, Smax_S0) {
        const piTerm = Math.cos((Math.PI * Smax_S0) / 2);
        const A0 = (0.825 - 0.34 * alpha + 0.05 * alpha * alpha) *
            Math.pow(piTerm, 1.0 / alpha);
        const A1 = (0.415 - 0.071 * alpha) * Smax_S0;
        const A3 = 2.0 * A0 + A1 - 1.0;
        const A2 = 1.0 - A0 - A1 - A3;

        if (R >= 0) {
            const fPoly = A0 + A1 * R + A2 * R * R + A3 * R * R * R;
            return Math.max(R, fPoly);
        } else {
            // For R < 0, use linear relation f = A0 + A1·R (NASGRO §3, no lower bound)
            // A negative f means Kop < 0, i.e. the crack is always open — physically valid.
            return A0 + A1 * R;
        }
    },

    /**
     * R-dependent threshold stress intensity factor range.
     *
     * ΔKth = ΔK1 · [ (1-f) / (1-A0) ]^(1 + Cth·R)
     * where Cth = Cth+ for R ≥ 0, Cth- for R < 0
     *
     * Per NASGRO, the threshold closure function f and the A0 denominator term
     * use the threshold-specific constraint parameters (alpha_th, Smax_S0_th),
     * which may differ from the crack-growth parameters (alpha, Smax_S0).
     * Falls back to growth-rate parameters if threshold parameters are absent.
     *
     * @param {number} R    - Stress ratio
     * @param {object} mat  - Material properties
     * @returns {number} ΔKth [ksi√in]
     */
    thresholdDK(R, mat) {
        // Use threshold-specific closure parameters (NASGRO §3)
        const alpha_th   = mat.alpha_th   !== undefined ? mat.alpha_th   : mat.alpha;
        const Smax_S0_th = mat.Smax_S0_th !== undefined ? mat.Smax_S0_th : mat.Smax_S0;

        const f = this.newmanClosure(R, alpha_th, Smax_S0_th);

        // Compute A0 for the denominator using threshold parameters
        const piTerm = Math.cos((Math.PI * Smax_S0_th) / 2);
        const A0 = (0.825 - 0.34 * alpha_th + 0.05 * alpha_th * alpha_th) *
            Math.pow(piTerm, 1.0 / alpha_th);

        const Cth = (R >= 0) ? mat.Cth_plus : mat.Cth_minus;

        // Clamp R for threshold calculation to [-2, 0.7] range
        const R_clamped = Math.max(-2, Math.min(R, 0.7));

        const base = (1 - f) / (1 - A0);
        const exponent = 1.0 + Cth * R_clamped;

        return mat.DK1 * Math.pow(Math.max(base, 1e-10), exponent);
    },

    /**
     * Thickness-dependent critical fracture toughness (Kc).
     * 
     * Kc = K1c · (1 + Bk · exp(-(Ak·t/t0)²) )
     * t0 = 2.5 · (K1c / σys)²
     * 
     * @param {number} t   - Thickness [in]
     * @param {object} mat - Material properties
     * @returns {number} Kc [ksi√in]
     */
    calcKc(t, mat) {
        const t0 = 2.5 * Math.pow(mat.K1c / mat.Yield, 2);
        const exponent = -Math.pow((mat.Ak * t) / t0, 2);
        return mat.K1c * (1.0 + mat.Bk * Math.exp(exponent));
    },

    /**
     * NASGRO crack growth rate (da/dN).
     * 
     * da/dN = C · [ (1-f)/(1-R) · ΔK ]^n · [ (1 - ΔKth/ΔK)^p / (1 - Kmax/Kc)^q ]
     * 
     * @param {number} Kmax - Maximum stress intensity factor [ksi√in]
     * @param {number} R    - Stress ratio
     * @param {object} mat  - Material properties
     * @param {number} Kc   - Critical fracture toughness at this thickness [ksi√in]
     * @returns {{ dadN: number, dK: number, DKth: number, f: number }}
     *          Growth rate and intermediate values for logging
     */
    growthRate(Kmax, R, mat, Kc) {
        const dK = Kmax * (1 - R);     // ΔK = Kmax - Kmin = Kmax(1-R)
        const DKth = this.thresholdDK(R, mat);
        const f = this.newmanClosure(R, mat.alpha, mat.Smax_S0);

        // Effective ΔK term (closure-corrected)
        let effDK = ((1 - f) / (1 - R)) * dK;
        if (effDK < 0) effDK = 0;

        // Threshold term (Region I tail)
        if (dK <= DKth) {
            return { dadN: 0, dK, DKth, f };
        }
        let threshTerm = 1.0 - (DKth / dK);
        if (threshTerm < 0) threshTerm = 0;

        // Instability term (Region III tail)
        let fractureTerm = 1.0 - (Kmax / Kc);
        if (fractureTerm < 0.001) fractureTerm = 0.001; // Prevent division by zero

        const numerator = Math.pow(threshTerm, mat.p);
        const denominator = Math.pow(fractureTerm, mat.q);

        const dadN = mat.C * Math.pow(effDK, mat.n) * (numerator / denominator);

        return { dadN, dK, DKth, f };
    }
};
