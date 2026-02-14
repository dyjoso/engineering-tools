/**
 * tc23.js — TC23: Unequal Straight Through Cracks at an Offset Hole
 *
 * NASGRO Crack Case TC23 (Ref: NASGRO Reference Manual, Appendix C)
 *
 * Supports:
 *   - Central or offset hole (eccentricity e₀)
 *   - Equal or unequal crack lengths (c₁, c₂)
 *   - Dual-crack growth (each tip tracked independently)
 *
 * SIF Solution A (remote tension S₀ — compounding method):
 *   K_i = β_i^A · S₀ · √(π·c_i)
 *
 *   β_i^A = β_i^{A1} · β_i^{A2} · β_i^{A3}
 *
 *   A1: Unequal cracks at hole in infinite plate (Tweed & Rooke / NRC fit)
 *   A2: Finite-width correction for crack-to-edge interaction (φ₁/φ₂)
 *   A3: Finite-width correction for hole-to-edge interaction (φ₁/φ₂)
 *
 * Derived dimensions:
 *   B  = W/2 + e₀          (hole center to left plate edge)
 *   c₀ = (c₁ + D + c₂)/2   (half crack from tip-to-tip center)
 *   b  = B + (c₂ - c₁)/2   (flaw center to left plate edge)
 *
 * See: docs/technical-reference.md §3
 */

class TC23Geometry extends CrackGeometry {
    constructor() {
        super('TC23', 'TC23 — Through Cracks at Hole');

        // β_r polynomial coefficients (Bowie solution, two equal symmetric cracks)
        // β_r(ρ) = Σ R_k · ρ^k,  k = 0..6,  ρ = c/(c+R)
        this._Rk = [
            3.364500, -7.209304, 8.230965, -3.500286,
            -2.923363, 4.306705, -1.562110
        ];

        // β_u rational function coefficients (unequal crack correction)
        // D_0..D_14, see _betaU method for formula
        this._Dk = [
            1.00000000,   //  D0
            0.98654553,   //  D1
            0.03673931,   //  D2
            0.90111374,   //  D3
            -0.01711464,   //  D4
            2.26550938,   //  D5
            0.08639597,   //  D6
            3.52048868,   //  D7
            1.12869498,   //  D8
            0.05132827,   //  D9
            0.90257160,   // D10
            -0.01714307,   // D11
            2.34770606,   // D12
            0.08386375,   // D13
            3.52544398    // D14
        ];
    }

    /** This geometry tracks two independent crack tips. */
    isDualCrack() { return true; }

    // ══════════════════════════════════════════════════════════
    //  Solution A1 — Unequal cracks at hole in infinite plate
    // ══════════════════════════════════════════════════════════

    /**
     * β_r(ρ): Bowie solution for two equal symmetric cracks at a hole
     * in an infinite plate.  ρ = c/(c+R) = γ/(γ+1).
     */
    _betaR(rho) {
        let val = 0;
        for (let k = 0; k < this._Rk.length; k++) {
            val += this._Rk[k] * Math.pow(rho, k);
        }
        return val;
    }

    /**
     * β_u(γ_a, γ_b): Correction for unequal crack lengths.
     * Rational function fit from NRC of Canada [C58].
     *
     * For tip i:  γ_a = c_other/R,  γ_b = c_this/R
     * (the OTHER crack's γ is the first argument)
     */
    _betaU(gamma_a, gamma_b) {
        const D = this._Dk;
        const ya = gamma_a, yb = gamma_b;
        const ya2 = ya * ya, yb2 = yb * yb;

        const num = D[0] + D[1] * ya + D[2] * ya2
            + D[3] * yb + D[4] * yb2
            + D[5] * ya * yb + D[6] * ya2 * yb + D[7] * ya * yb2;

        const den = 1.0 + D[8] * ya + D[9] * ya2
            + D[10] * yb + D[11] * yb2
            + D[12] * ya * yb + D[13] * ya2 * yb + D[14] * ya * yb2;

        return num / den;
    }

    /**
     * Solution A1: β_i^{A1} for one crack tip.
     *
     * β_i^{A1} = β_r(ρ_i) · β_u(γ_other, γ_this) · √(2c₀ / (c_i + D))
     *
     * @param {number} cThis  - This tip's crack length
     * @param {number} cOther - Opposing tip's crack length
     * @param {number} R      - Hole radius (D/2)
     */
    _betaA1(cThis, cOther, R) {
        const D = 2 * R;
        const gamma_this = cThis / R;
        const gamma_other = cOther / R;
        const rho_this = gamma_this / (gamma_this + 1.0);

        const c0 = (cThis + D + cOther) / 2.0;   // half total flaw (tip-to-tip)

        const br = this._betaR(rho_this);
        const bu = this._betaU(gamma_other, gamma_this);  // other γ first!
        const scale = Math.sqrt(2.0 * c0 / (cThis + D));

        return br * bu * scale;
    }

    // ══════════════════════════════════════════════════════════
    //  Solutions A2 & A3 — Finite-width corrections (φ₁, φ₂)
    // ══════════════════════════════════════════════════════════

    /**
     * φ₁(μ,ω,W): Near-edge finite-width correction (Feddersen-like).
     * Used for the crack tip nearer to the plate edge.
     *
     *   λ₁ = πμ/(2ω)
     *   λ₂ = πμ/(2W − 2ω)
     *   λ_s = sin(πλ₂/(λ₁+λ₂))
     *   φ₁ = [λ_s + (1−λ_s)/4 · (1 + cos^{0.25}(λ₁))²] · √sec(λ₁)
     */
    _phi1(mu, omega, W) {
        if (mu <= 0) return 1.0;
        const lam1 = Math.PI * mu / (2.0 * omega);
        const lam2 = Math.PI * mu / (2.0 * W - 2.0 * omega);

        if (lam1 >= Math.PI / 2) return -1;  // geometry limit
        const sum = lam1 + lam2;
        const lam_s = sum > 0 ? Math.sin(Math.PI * lam2 / sum) : 1.0;

        const cosL1_025 = Math.pow(Math.cos(lam1), 0.25);
        const bracket = lam_s + (1.0 - lam_s) / 4.0 * Math.pow(1.0 + cosL1_025, 2);
        return bracket * Math.sqrt(1.0 / Math.cos(lam1));
    }

    /**
     * φ₂(μ,ω,W): Far-edge finite-width correction.
     * Used for the crack tip farther from the plate edge.
     *
     *   λ₁₂ = (4/7)λ₁ + (3/7)λ₂
     *   φ₂ = 1 + (√sec(λ₁₂) − 1) / (1 + 0.21·sin(8·arctan(((λ₁−λ₂)/(λ₁+λ₂))^0.9)))
     */
    _phi2(mu, omega, W) {
        if (mu <= 0) return 1.0;
        const lam1 = Math.PI * mu / (2.0 * omega);
        const lam2 = Math.PI * mu / (2.0 * W - 2.0 * omega);

        const lam12 = (4.0 / 7.0) * lam1 + (3.0 / 7.0) * lam2;
        if (lam12 >= Math.PI / 2) return -1;

        const secL12 = 1.0 / Math.cos(lam12);
        const sum = lam1 + lam2;
        let denom = 1.0;
        if (sum > 0) {
            const ratio = (lam1 - lam2) / sum;
            const absRatio = Math.abs(ratio);
            const atn = 8.0 * Math.atan(Math.pow(absRatio, 0.9));
            denom = 1.0 + 0.21 * Math.sin(atn);
        }

        return 1.0 + (Math.sqrt(secL12) - 1.0) / denom;
    }

    /**
     * Solution A2: Crack-to-edge finite-width correction for each tip.
     *
     * Uses c₀ (half total flaw) and b (flaw center to left edge).
     * Tip 1 (left) gets the near-edge factor when b ≤ W/2.
     *
     * @param {string} side - 'left' or 'right'
     */
    _betaA2(c0, b, W, side) {
        if (b <= W / 2.0) {
            // Flaw center nearer to left edge → tip 1 near, tip 2 far
            return side === 'left'
                ? this._phi1(c0, b, W)
                : this._phi2(c0, b, W);
        } else {
            // Flaw center nearer to right edge → tip 1 far, tip 2 near
            return side === 'left'
                ? this._phi2(c0, W - b, W)
                : this._phi1(c0, W - b, W);
        }
    }

    /**
     * Solution A3: Hole-to-edge finite-width correction for each tip.
     *
     * Uses R (hole radius) and B (hole center to left edge).
     * Same tip assignment as A2: the near-edge tip gets the
     * stronger (φ₁) correction.
     *
     * @param {string} side - 'left' or 'right'
     */
    _betaA3(R, B, W, side) {
        if (B <= W / 2.0) {
            // Hole nearer to left edge → tip 1 (left) is near-edge
            return side === 'left'
                ? this._phi1(R, B, W)
                : this._phi2(R, B, W);
        } else {
            // Hole nearer to right edge → tip 2 (right) is near-edge
            return side === 'left'
                ? this._phi2(R, W - B, W)
                : this._phi1(R, W - B, W);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  SENT Beta Factors — Post-link-up edge crack solutions
    // ══════════════════════════════════════════════════════════

    /**
     * β for a SENT specimen, fully restrained (clamped ends / bending suppressed).
     * Tada/Paris/Irwin polynomial — load applied at centerline, no rotation.
     *
     *   F(λ) = 1.122 − 0.561λ − 0.205λ² + 0.471λ³ − 0.190λ⁴
     *
     * Accuracy: 0.5% for any a/W.
     * This gives LOWER β than the unrestrained formula (bending is suppressed).
     *
     * @param {number} aOverW - Crack length / plate width ratio
     * @returns {number} β (dimensionless)
     */
    _betaSENT_restrained(aOverW) {
        const l = aOverW;
        return 1.122 - 0.561 * l - 0.205 * l * l
            + 0.471 * l * l * l - 0.190 * l * l * l * l;
    }

    /**
     * β for a SENT specimen, fully unrestrained (free rotation / pinned ends).
     * Tada/Paris/Irwin polynomial — uniform stress on ends, free rotation.
     *
     *   F(λ) = 1.122 − 0.231λ + 10.550λ² − 21.710λ³ + 30.382λ⁴
     *
     * Accuracy: 0.5% for a/W ≤ 0.6.
     * This gives HIGHER β than the restrained formula (bending adds to K).
     *
     * @param {number} aOverW - Crack length / plate width ratio
     * @returns {number} β (dimensionless)
     */
    _betaSENT_unrestrained(aOverW) {
        const l = aOverW;
        return 1.122 - 0.231 * l + 10.550 * l * l
            - 21.710 * l * l * l + 30.382 * l * l * l * l;
    }

    /**
     * Interpolated SENT beta with bending restraint parameter η.
     *
     *   η = 0 → fully unrestrained (pinned ends, maximum bending)
     *   η = 1 → fully restrained (clamped ends, bending suppressed)
     *
     *   β = β_unrestrained + η · (β_restrained − β_unrestrained)
     *
     * Since β_restrained < β_unrestrained, increasing η REDUCES β and K.
     *
     * @param {number} aOverW - a/W ratio
     * @param {number} eta    - Bending restraint factor [0, 1]
     * @returns {number} β (dimensionless)
     */
    _betaSENT(aOverW, eta) {
        const bU = this._betaSENT_unrestrained(aOverW);
        const bR = this._betaSENT_restrained(aOverW);
        return bU + eta * (bR - bU);
    }
    // ══════════════════════════════════════════════════════════
    //  Solution B2 — In-plane bending FEM table lookup
    // ══════════════════════════════════════════════════════════

    /**
     * β_i^{B2}: bending correction from the Φ₁ FEM table.
     *
     *   β₁^{B2} =  Φ₁(d₁, d₂)
     *   β₂^{B2} = −Φ₁(1 − d₂, 1 − d₁)
     *
     * @param {number} c0   - Half total flaw length
     * @param {number} b    - Flaw center to left plate edge
     * @param {number} W    - Plate width
     * @param {string} side - 'left' or 'right'
     * @returns {number}
     */
    _betaB2(c0, b, W, side) {
        const d1 = (b - c0) / W;
        const d2 = (b + c0) / W;
        if (side === 'left') {
            return interpPhi1(d1, d2);
        } else {
            return -interpPhi1(1 - d2, 1 - d1);
        }
    }

    // ══════════════════════════════════════════════════════════
    //  Solution C — Pin-load / Bearing stress
    // ══════════════════════════════════════════════════════════

    /**
     * C2:2 exponential correction for bearing radial pressure.
     *   β_i^{C2:2} = exp(0.15 · (ρ_i² − 1))
     * where ρ_i = c_i / (c_i + R)
     */
    _betaC2_2(c, R) {
        const rho = c / (c + R);
        return Math.exp(0.15 * (rho * rho - 1.0));
    }

    /**
     * C2:3 unequal crack correction for bearing.
     *   β₁^{C2:3} = (W/(πc₀)) · √((c₀ − ζ)/(c₀ + ζ))
     *   β₂^{C2:3} = (W/(πc₀)) · √((c₀ + ζ)/(c₀ − ζ))
     * where ζ = (c₁ − c₂)/2
     */
    _betaC2_3(c0, c1, c2, W, side) {
        const zeta = (c1 - c2) / 2.0;
        const prefix = W / (Math.PI * c0);
        const arg_num = c0 - zeta;
        const arg_den = c0 + zeta;
        if (arg_num <= 0 || arg_den <= 0) return 1.0;
        if (side === 'left') {
            return prefix * Math.sqrt(arg_num / arg_den);
        } else {
            return prefix * Math.sqrt(arg_den / arg_num);
        }
    }

    /**
     * C2:4 finite-width correction for bearing using λ/sin(λ) form.
     *
     * If b ≤ W/2:  β₁ = λ₁/sin(λ₁),   β₂ = λ₁₂/sin(λ₁₂)
     * If b > W/2:   β₁ = λ₁₂/sin(λ₁₂),  β₂ = λ₁/sin(λ₁)
     *
     * λ₁ = πc₀/(2ω),  λ₁₂ = (4/7)λ₁ + (3/7)λ₂
     */
    _betaC2_4(c0, b, W, side) {
        const omega = (side === 'left' && b <= W / 2) || (side === 'right' && b > W / 2)
            ? b : W - b;
        const eff_b = (b <= W / 2.0) ? b : W - b;

        const lam1 = Math.PI * c0 / (2.0 * eff_b);
        const lam2 = Math.PI * c0 / (2.0 * W - 2.0 * eff_b);
        const lam12 = (4.0 / 7.0) * lam1 + (3.0 / 7.0) * lam2;

        // x/sin(x) correction, guarded against sin→0
        const xOverSinX = (x) => {
            if (Math.abs(x) < 1e-10) return 1.0;
            const s = Math.sin(x);
            if (Math.abs(s) < 1e-15) return 1e6;
            return x / s;
        };

        if (b <= W / 2.0) {
            return (side === 'left') ? xOverSinX(lam1) : xOverSinX(lam12);
        } else {
            return (side === 'left') ? xOverSinX(lam12) : xOverSinX(lam1);
        }
    }

    /**
     * Full Solution B beta factor for in-plane bending.
     *
     *   β_i^B = β_i^{B1} · β_i^{B2}
     *
     * where B1 = A1 (Bowie factor) and B2 = Φ₁ table lookup.
     *
     * @param {number} c      - This tip's crack length
     * @param {object} params - Geometry parameters
     * @param {string} side   - 'left' or 'right'
     * @returns {number} β_B
     */
    getBetaB(c, params, side) {
        const R = params.D / 2;
        const W = params.W;
        const e0 = params.e0 || 0;
        const B = W / 2.0 + e0;

        let c1, c2;
        if (side === 'left') {
            c1 = c;
            c2 = params._c2 !== undefined ? params._c2 : (params.a0_2 || c);
        } else {
            c1 = params._c1 !== undefined ? params._c1 : (params.a0 || c);
            c2 = c;
        }

        const c0 = (c1 + params.D + c2) / 2.0;
        const b = B + (c2 - c1) / 2.0;
        const cThis = (side === 'left') ? c1 : c2;
        const cOther = (side === 'left') ? c2 : c1;

        const bB1 = this._betaA1(cThis, cOther, R);  // B1 = A1 (Bowie factor)
        const bB2 = this._betaB2(c0, b, W, side);     // Φ₁ table lookup

        return bB1 * bB2;
    }

    /**
     * Full Solution C beta factor for bearing/pin-load.
     *
     *   β_i^C = ½ · (β_i^{C1} + β_i^{C2} + β_i^{C3})
     *
     * @param {number} c      - This tip's crack length
     * @param {object} params - Geometry parameters
     * @param {string} side   - 'left' or 'right'
     * @returns {number} β_C, or 0 if Solution A fails
     */
    getBetaC(c, params, side) {
        const R = params.D / 2;
        const W = params.W;
        const e0 = params.e0 || 0;
        const B = W / 2.0 + e0;       // hole center to left edge
        const e = W / 2.0 - B;        // eccentricity from plate center (= -e0)

        let c1, c2;
        if (side === 'left') {
            c1 = c;
            c2 = params._c2 !== undefined ? params._c2 : (params.a0_2 || c);
        } else {
            c1 = params._c1 !== undefined ? params._c1 : (params.a0 || c);
            c2 = c;
        }

        const c0 = (c1 + params.D + c2) / 2.0;
        const b = B + (c2 - c1) / 2.0;
        const cThis = (side === 'left') ? c1 : c2;

        // ─── C1: Same as Solution A ───
        const betaA = this.getBeta(c, params, side);
        if (betaA < 0) return 0;
        const bC1 = betaA;

        // ─── C2: Radial compounding ───
        const bC2_1 = betaA;
        const bC2_2 = this._betaC2_2(cThis, R);
        const bC2_3 = this._betaC2_3(c0, c1, c2, W, side);
        const bC2_4 = this._betaC2_4(c0, b, W, side);
        const bC2 = bC2_1 * bC2_2 * bC2_3 * bC2_4;

        // ─── C3: Bending from bearing eccentricity ───
        // β_i^{C3} = (6e/W) · β_i^{B1} · β_i^{B2}
        // where β_i^{B1} = β_i^{A1} (Bowie factor)
        const cOther = (side === 'left') ? c2 : c1;
        const bA1 = this._betaA1(cThis, cOther, R);
        const bB2 = this._betaB2(c0, b, W, side);
        const bC3 = (6.0 * e / W) * bA1 * bB2;

        return 0.5 * (bC1 + bC2 + bC3);
    }

    /**
     * Combined SIF including tension (S₀), bending (S₂), and bearing (S₃).
     *
     *   K = (β^A · S₀ + β^B · S₂ + (D/W) · β^C · S̄₃) · √(πc)
     *
     * @param {number} c      - Crack length at this tip
     * @param {number} S0     - Remote tension stress
     * @param {number} S3     - Bearing stress = P/(Dt), clipped to ≥0
     * @param {object} params - Geometry parameters (may contain S2)
     * @param {string} side   - 'left' or 'right'
     * @returns {number} K, or -1 if geometry limit
     */
    getK_total(c, S0, S3, params, side) {
        const betaA = this.getBeta(c, params, side);
        if (betaA < 0) return -1;

        let K = betaA * S0;

        // Solution B: in-plane bending
        // Sign convention: S2 > 0 opens the RIGHT crack (RHS)
        // Since betaB is (+) for Left and (-) for Right:
        //   - Left:  K -= (+) * (+) = (-)  [Closes Left]
        //   - Right: K -= (-) * (+) = (+)  [Opens Right]
        const S2 = params.S2 || 0;
        if (S2 !== 0) {
            const betaB = this.getBetaB(c, params, side);
            K -= betaB * S2;
        }

        // Solution C: bearing/pin-load
        if (S3 > 0) {
            const betaC = this.getBetaC(c, params, side);
            const DoverW = params.D / params.W;
            K += DoverW * betaC * S3;
        }

        return K * Math.sqrt(Math.PI * c);
    }

    /**
     * Combined SIF for edge crack (SENT) with bearing.
     * After link-up, bearing stress acts as additional membrane tension
     * through the D/W · β^C factor on the remaining edge crack.
     * Falls back to pure SENT when S3 = 0.
     */
    getKEdge_total(aEdge, S0, S3, params) {
        const betaEdge = this.getBetaEdge(aEdge, params);
        if (betaEdge < 0) return -1;
        // In SENT phase (growing from Left edge), positive S2 (which opens Right)
        // acts as closing stress on Left. So subtract S2.
        const S2 = params.S2 || 0;
        const S_eff = S0 - S2 + (S3 > 0 ? (params.D / params.W) * S3 : 0);
        return S_eff * Math.sqrt(Math.PI * aEdge) * betaEdge;
    }
    // ══════════════════════════════════════════════════════════

    /**
     * Compute the total edge crack length after RHS link-up.
     * Measured from the right plate edge inward through the broken
     * ligament, hole, and surviving left crack.
     *
     *   a_edge = c₁ + D + (W/2 − e₀ − R)
     *
     * @param {number} c1     - Left crack length from hole edge [in]
     * @param {object} params - Geometry parameters
     * @returns {number} Edge crack length [in]
     */
    getEdgeCrackLength(c1, params) {
        const R = params.D / 2;
        const e0 = params.e0 || 0;
        const rightLigament = params.W / 2.0 - e0 - R;
        return c1 + params.D + rightLigament;
    }

    /**
     * Beta factor for the post-link-up edge crack.
     *
     * @param {number} aEdge  - Edge crack length [in]
     * @param {object} params - Geometry parameters (must include eta)
     * @returns {number} β, or -1 if geometry limit exceeded
     */
    getBetaEdge(aEdge, params) {
        if (aEdge <= 0) return -1;
        const aOverW = aEdge / params.W;
        if (aOverW >= 0.95) return -1;
        const eta = params.eta !== undefined ? params.eta : 0;
        return this._betaSENT(aOverW, eta);
    }

    /**
     * SIF for the post-link-up edge crack.
     *   K = σ · √(π·a_edge) · β_SENT
     */
    getKEdge(aEdge, sigma, params) {
        const beta = this.getBetaEdge(aEdge, params);
        if (beta < 0) return -1;
        return sigma * Math.sqrt(Math.PI * aEdge) * beta;
    }

    /**
     * Maximum valid edge crack length (post-link-up).
     */
    getMaxCrackEdge(params) {
        return 0.95 * params.W;
    }

    /**
     * Net-section stress for the post-link-up edge crack.
     *   σ_net = σ · W / (W − a_edge)
     */
    getNetSectionStressEdge(aEdge, sigma, params) {
        const netWidth = params.W - aEdge;
        if (netWidth <= 0) return Infinity;
        return sigma * params.W / netWidth;
    }

    // ══════════════════════════════════════════════════════════
    //  Public SIF interface (TC23 two-crack phase)
    // ══════════════════════════════════════════════════════════

    /**
     * Combined beta factor for a given crack tip (Solution A, S₀ loading).
     *
     *   β_i^A = β_i^{A1} · β_i^{A2} · β_i^{A3}
     *
     * @param {number} c       - This tip's crack length from hole edge [in]
     * @param {object} params  - Geometry parameters
     * @param {string} [side]  - 'left' or 'right' (default: 'right')
     * @returns {number} β, or -1 if geometry limit exceeded
     */
    getBeta(c, params, side) {
        if (c <= 0) return -1;
        const R = params.D / 2;
        const W = params.W;
        const e0 = params.e0 || 0;
        const B = W / 2.0 + e0;         // Hole center to left plate edge

        // Determine both crack lengths
        let c1, c2;
        if (side === 'left') {
            c1 = c;
            c2 = params._c2 !== undefined ? params._c2 : (params.a0_2 || c);
        } else {
            c1 = params._c1 !== undefined ? params._c1 : (params.a0 || c);
            c2 = c;
        }

        // Derived dimensions
        const c0 = (c1 + params.D + c2) / 2.0;  // half total flaw
        const b = B + (c2 - c1) / 2.0;          // flaw center to left edge

        // This tip vs other tip
        const cThis = (side === 'left') ? c1 : c2;
        const cOther = (side === 'left') ? c2 : c1;

        // A1: Infinite plate with hole
        const bA1 = this._betaA1(cThis, cOther, R);

        // A2: Crack-edge finite width
        const bA2 = this._betaA2(c0, b, W, side);
        if (bA2 < 0) return -1;

        // A3: Hole-edge finite width
        const bA3 = this._betaA3(R, B, W, side);
        if (bA3 < 0) return -1;

        return bA1 * bA2 * bA3;
    }

    /**
     * SIF for a given crack tip.
     *   K = σ · √(πc) · β
     */
    getK(c, sigma, params, side) {
        const beta = this.getBeta(c, params, side);
        if (beta < 0) return -1;
        return sigma * Math.sqrt(Math.PI * c) * beta;
    }

    /**
     * Maximum valid crack length for a given side.
     */
    getMaxCrack(params, side) {
        const r = params.D / 2;
        const e0 = params.e0 || 0;
        if (side === 'left') {
            // Left ligament: from left plate edge to left hole edge
            return 0.95 * (params.W / 2 + e0 - r);
        }
        // Right ligament: from right hole edge to right plate edge
        return 0.95 * (params.W / 2 - e0 - r);
    }

    /**
     * Net-section stress using total flaw width.
     * Both cracks + hole reduce the load-bearing cross-section.
     *   σ_net = σ · W / (W − D − c₁ − c₂)
     */
    getNetSectionStress(c, sigma, params, side) {
        let c1, c2;
        if (side === 'left') {
            c1 = c;
            c2 = params._c2 !== undefined ? params._c2 : (params.a0_2 || c);
        } else {
            c1 = params._c1 !== undefined ? params._c1 : (params.a0 || c);
            c2 = c;
        }
        const netWidth = params.W - params.D - c1 - c2;
        if (netWidth <= 0) return Infinity;
        return sigma * params.W / netWidth;
    }

    /**
     * Input field definitions for the UI.
     */
    getInputFields() {
        return [
            { id: 'W', label: 'Plate Width, W', unit: 'in', default: 10.0, step: 0.1, min: 0.01 },
            { id: 't', label: 'Thickness, t', unit: 'in', default: 0.063, step: 0.001, min: 0.001 },
            { id: 'D', label: 'Hole Diameter, D', unit: 'in', default: 0.25, step: 0.01, min: 0.01 },
            { id: 'e0', label: 'Hole Offset, e₀', unit: 'in', default: 0, step: 0.05, min: 0 },
            { id: 'a0', label: 'Left Crack, c₁₀', unit: 'in', default: 0.05, step: 0.005, min: 0.001 },
            { id: 'a0_2', label: 'Right Crack, c₂₀', unit: 'in', default: 0.05, step: 0.005, min: 0.001 },
            { id: 'eta', label: 'Bending Restraint, η (0=free, 1=fixed)', unit: '—', default: 0, step: 0.1, min: 0, max: 1 },
            { id: 'S2', label: 'Bending Stress, S₂', unit: 'ksi', default: 0, step: 1 },
            { id: 'S3', label: 'Bearing Stress, S₃ = P/(Dt)', unit: 'ksi', default: 0, step: 1, min: 0 }
        ];
    }

    /**
     * Draw a schematic of the TC23 geometry with offset and unequal cracks.
     */
    drawDiagram(ctx, params, c, canvasW, canvasH) {
        let c1, c2;
        if (typeof c === 'object' && c !== null) {
            c1 = c.c1;
            c2 = c.c2;
        } else {
            c1 = c;
            c2 = params.a0_2 || c;
        }

        ctx.clearRect(0, 0, canvasW, canvasH);

        const pad = 40;
        const plateW = canvasW - 2 * pad;
        const plateH = canvasH - 2 * pad - 20;
        const plateCx = canvasW / 2;
        const cy = canvasH / 2;
        const x0 = pad;
        const y0 = pad + 10;

        const W = params.W || 10;
        const D = params.D || 0.25;
        const r = D / 2;
        const e0 = params.e0 || 0;

        const scale = plateW / W;
        const holeCx = plateCx + e0 * scale;

        // ── Draw plate outline ──
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.rect(x0, y0, plateW, plateH);
        ctx.fill();
        ctx.stroke();

        // ── Draw hole ──
        const holeRadPx = Math.max(r * scale, 4);
        ctx.fillStyle = '#0f172a';
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(holeCx, cy, holeRadPx, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();

        // ── Draw cracks ──
        const maxAvailLeft = holeCx - holeRadPx - x0;
        const maxAvailRight = (x0 + plateW) - holeCx - holeRadPx;

        const c1MaxInch = W / 2 + e0 - r;  // left ligament (hole at W/2+e₀)
        const c2MaxInch = W / 2 - e0 - r;  // right ligament
        const c1Px = Math.min(c1 / Math.max(c1MaxInch, 0.01), 0.95) * maxAvailLeft;
        const c2Px = Math.min(c2 / Math.max(c2MaxInch, 0.01), 0.95) * maxAvailRight;

        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(holeCx - holeRadPx, cy);
        ctx.lineTo(holeCx - holeRadPx - c1Px, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(holeCx + holeRadPx, cy);
        ctx.lineTo(holeCx + holeRadPx + c2Px, cy);
        ctx.stroke();

        // Crack tips
        ctx.fillStyle = '#ef4444';
        [holeCx - holeRadPx - c1Px, holeCx + holeRadPx + c2Px].forEach(tipX => {
            ctx.beginPath();
            ctx.arc(tipX, cy, 3.5, 0, 2 * Math.PI);
            ctx.fill();
        });

        // ── Dimension: c₁ ──
        const dimY1 = cy + 22;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(holeCx - holeRadPx, cy + 5);
        ctx.lineTo(holeCx - holeRadPx, dimY1 + 5);
        ctx.moveTo(holeCx - holeRadPx - c1Px, cy + 5);
        ctx.lineTo(holeCx - holeRadPx - c1Px, dimY1 + 5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(holeCx - holeRadPx, dimY1);
        ctx.lineTo(holeCx - holeRadPx - c1Px, dimY1);
        ctx.stroke();
        drawArrowhead(ctx, holeCx - holeRadPx, dimY1, 'left', '#2563eb');
        drawArrowhead(ctx, holeCx - holeRadPx - c1Px, dimY1, 'right', '#2563eb');
        ctx.fillStyle = '#2563eb';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('c₁', holeCx - holeRadPx - c1Px / 2, dimY1 + 13);

        // ── Dimension: c₂ ──
        ctx.strokeStyle = '#8b5cf6';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(holeCx + holeRadPx, cy + 5);
        ctx.lineTo(holeCx + holeRadPx, dimY1 + 5);
        ctx.moveTo(holeCx + holeRadPx + c2Px, cy + 5);
        ctx.lineTo(holeCx + holeRadPx + c2Px, dimY1 + 5);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(holeCx + holeRadPx, dimY1);
        ctx.lineTo(holeCx + holeRadPx + c2Px, dimY1);
        ctx.stroke();
        drawArrowhead(ctx, holeCx + holeRadPx, dimY1, 'right', '#8b5cf6');
        drawArrowhead(ctx, holeCx + holeRadPx + c2Px, dimY1, 'left', '#8b5cf6');
        ctx.fillStyle = '#8b5cf6';
        ctx.fillText('c₂', holeCx + holeRadPx + c2Px / 2, dimY1 + 13);

        // ── Dimension: D ──
        const dDimY = cy - holeRadPx - 12;
        ctx.strokeStyle = '#f59e0b';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(holeCx - holeRadPx, dDimY);
        ctx.lineTo(holeCx + holeRadPx, dDimY);
        ctx.stroke();
        drawArrowhead(ctx, holeCx - holeRadPx, dDimY, 'right', '#f59e0b');
        drawArrowhead(ctx, holeCx + holeRadPx, dDimY, 'left', '#f59e0b');
        ctx.fillStyle = '#f59e0b';
        ctx.font = '11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('D', holeCx, dDimY - 5);

        // ── Dimension: e₀ ──
        if (e0 > 0.001) {
            const eDimY = dDimY - 18;
            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath();
            ctx.moveTo(plateCx, y0 + 5);
            ctx.lineTo(plateCx, y0 + plateH - 5);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(plateCx, eDimY);
            ctx.lineTo(holeCx, eDimY);
            ctx.stroke();
            drawArrowhead(ctx, plateCx, eDimY, 'right', '#06b6d4');
            drawArrowhead(ctx, holeCx, eDimY, 'left', '#06b6d4');
            ctx.fillStyle = '#06b6d4';
            ctx.fillText('e₀', (plateCx + holeCx) / 2, eDimY - 5);
        }

        // ── Dimension: W ──
        const wDimY = y0 + plateH + 18;
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, wDimY);
        ctx.lineTo(x0 + plateW, wDimY);
        ctx.stroke();
        drawArrowhead(ctx, x0, wDimY, 'right', '#475569');
        drawArrowhead(ctx, x0 + plateW, wDimY, 'left', '#475569');
        ctx.fillStyle = '#475569';
        ctx.font = '12px Inter, sans-serif';
        ctx.fillText('W', plateCx, wDimY + 14);

        // ── Stress arrows ──
        ctx.fillStyle = '#059669';
        ctx.strokeStyle = '#059669';
        ctx.lineWidth = 1.5;
        const arrowCount = 5;
        for (let i = 0; i < arrowCount; i++) {
            const ax = x0 + plateW * (i + 0.5) / arrowCount;
            drawStressArrow(ctx, ax, y0 - 2, 'down');
            drawStressArrow(ctx, ax, y0 + plateH + 2, 'up');
        }

        ctx.fillStyle = '#059669';
        ctx.font = 'italic 13px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('σ (S0)', x0 + plateW + 5, y0 + 5);
    }
}

// Register TC23
registerGeometry(new TC23Geometry());
