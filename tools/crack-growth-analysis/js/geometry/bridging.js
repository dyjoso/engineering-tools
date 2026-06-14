/**
 * bridging.js — Fastener crack-bridging by displacement compatibility
 *
 * Implements the industry-standard Swift displacement-compatibility method
 * for a cracked sheet (the stringer) attached to an intact background
 * infinite sheet (the fuselage skin) by a single vertical line of discrete
 * fasteners passing through the critical hole.
 *
 * Physics: as the crack opens under remote stress, the fasteners above and
 * below the crack plane transfer load into the intact skin, restraining the
 * crack-opening displacement and reducing the stress intensity factor.
 *
 * Formulation (plane stress, symmetric about the crack plane):
 *
 *   [ f·I + G_str + G_sk ] · F  =  V₀ · σ
 *
 *   f        — fastener flexibility (modified Tate & Rosenfeld) [in/kip]
 *   F_j      — bridging force in fastener pair j (one above, one below) [kip]
 *   V₀(y_j)  — crack-induced opening displacement of the stringer at the
 *              fastener location under remote σ (Westergaard field)
 *   G_str    — reduction of stringer displacement at fastener i per unit
 *              restraining pair at fastener j, in the CRACKED sheet:
 *              Kelvin point-force field + crack-release correction obtained
 *              exactly through the Betti/Rice weight-function identity
 *                v_corr(i,j) = −(t₁/E₁)·∫₀^a [K₊ᵢK₊ⱼ + K₋ᵢK₋ⱼ] da′
 *   G_sk     — stretch of the intact infinite skin at fastener i per unit
 *              (reacted) pair at fastener j (Kelvin field)
 *
 * The tip SIF is then reduced by the bridging forces:
 *
 *   K_tip = K_unbridged + Σ_j F_j · K_tip,j      (K_tip,j < 0)
 *   R_tip = K_tip / K_unbridged   →   β_bridged = β_TC23 · R_tip
 *
 * where K_tip,j is the exact center-crack Green's function for a symmetric
 * point-force pair, evaluated by Bueckner superposition:
 *   K± = (1/√(πa)) ∫ σ_yy^{pair}(x,0) · (a±x)/√(a²−x²) dx
 * with σ_yy^{pair} from the exact Muskhelishvili point-force (Kelvin)
 * solution for an infinite plate.
 *
 * Verified limits (see tests/run-tests.mjs):
 *   - pair height b → 0:  K → −P/(t√(πa))  (central wedge-force result)
 *   - V₀ closed form  ≡  Betti K-integral route (independent cross-check)
 *   - influence matrix symmetry (Betti reciprocity)
 *   - zero skin/fastener stiffness → R = 1 (reverts to plain TC23)
 *
 * Units: ksi, in, kip throughout. Plane stress.
 */

const Bridging = (() => {

    // ══════════════════════════════════════════════════════════
    //  Complex arithmetic helpers ({re, im} objects)
    // ══════════════════════════════════════════════════════════

    const C = (re, im = 0) => ({ re, im });
    const cadd = (a, b) => C(a.re + b.re, a.im + b.im);
    const csub = (a, b) => C(a.re - b.re, a.im - b.im);
    const cmul = (a, b) => C(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
    const cdiv = (a, b) => {
        const d = b.re * b.re + b.im * b.im;
        return C((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
    };
    const cscale = (a, s) => C(a.re * s, a.im * s);
    const conj = (a) => C(a.re, -a.im);
    const csqrt = (a) => {
        const r = Math.hypot(a.re, a.im);
        const s = Math.sqrt((r + a.re) / 2);
        let t = Math.sqrt(Math.max((r - a.re) / 2, 0));
        if (a.im < 0) t = -t;
        return C(s, t);
    };
    const clog = (a) => C(Math.log(Math.hypot(a.re, a.im)), Math.atan2(a.im, a.re));

    /** √(z²−a²) with branch cut on [−a, a], asymptotic to z at infinity. */
    const sqrtZ2mA2 = (z, a) => cmul(csqrt(csub(z, C(a))), csqrt(cadd(z, C(a))));

    // ══════════════════════════════════════════════════════════
    //  Kelvin point-force fields (Muskhelishvili potentials)
    // ══════════════════════════════════════════════════════════
    //  Force (fx, fy) per unit thickness at z₀ in an infinite plate.
    //    φ(z) = A·ln(z−z₀),                A = −(fx+ify)/(2π(1+κ))
    //    ψ(z) = B·ln(z−z₀) − z̄₀·A/(z−z₀), B = −κ·conj(A)
    //  Stresses:      σxx+σyy = 4 Re φ′,  σyy−σxx+2iσxy = 2(z̄φ″+ψ′)
    //  Displacements: 2G(u+iv) = κφ − z·conj(φ′) − conj(ψ)
    //  Plane stress:  κ = (3−ν)/(1+ν)

    /** σ_yy at field point (x, y) due to force (fx, fy)/thickness at (x0, y0). */
    function kelvinSigYY(x, y, x0, y0, fx, fy, kappa) {
        const z = C(x, y), z0 = C(x0, y0);
        const A = cscale(C(fx, fy), -1 / (2 * Math.PI * (1 + kappa)));
        const dz = csub(z, z0);
        const dz2 = cmul(dz, dz);
        const phi1 = cdiv(A, dz);                               // φ′
        const phi2 = cscale(cdiv(A, dz2), -1);                  // φ″
        const B = cscale(conj(A), -kappa);
        const psi1 = cadd(cdiv(B, dz), cmul(conj(z0), cdiv(A, dz2))); // ψ′
        const t2 = cadd(cmul(conj(z), phi2), psi1);
        return 2 * phi1.re + t2.re;
    }

    /** σ_xx at field point (x, y) due to force (fx, fy)/thickness at (x0, y0). */
    function kelvinSigXX(x, y, x0, y0, fx, fy, kappa) {
        const z = C(x, y), z0 = C(x0, y0);
        const A = cscale(C(fx, fy), -1 / (2 * Math.PI * (1 + kappa)));
        const dz = csub(z, z0);
        const dz2 = cmul(dz, dz);
        const phi1 = cdiv(A, dz);
        const phi2 = cscale(cdiv(A, dz2), -1);
        const B = cscale(conj(A), -kappa);
        const psi1 = cadd(cdiv(B, dz), cmul(conj(z0), cdiv(A, dz2)));
        const t2 = cadd(cmul(conj(z), phi2), psi1);
        return 2 * phi1.re - t2.re;
    }

    /** v-displacement at field point due to force (fx, fy)/thickness at (x0, y0). */
    function kelvinV(xf, yf, x0, y0, fx, fy, kappa, Gmod) {
        const z = C(xf, yf), z0 = C(x0, y0);
        const A = cscale(C(fx, fy), -1 / (2 * Math.PI * (1 + kappa)));
        const dz = csub(z, z0);
        const lnz = clog(dz);
        const phi = cmul(A, lnz);
        const phi1 = cdiv(A, dz);
        const B = cscale(conj(A), -kappa);
        const psi = csub(cmul(B, lnz), cmul(conj(z0), cdiv(A, dz)));
        const w = csub(csub(cscale(phi, kappa), cmul(z, conj(phi1))), conj(psi));
        return w.im / (2 * Gmod);
    }

    /**
     * v-displacement with a finite-radius cutoff for the self-term: if the
     * field point lies within r0 of the source, average v over a circle of
     * radius r0 around the source (the local deformation inside r0 is
     * already represented by the empirical fastener flexibility).
     */
    function kelvinVCutoff(xf, yf, x0, y0, fx, fy, kappa, Gmod, r0) {
        if (Math.hypot(xf - x0, yf - y0) >= r0) {
            return kelvinV(xf, yf, x0, y0, fx, fy, kappa, Gmod);
        }
        let v = 0;
        const nAng = 8;
        for (let k = 0; k < nAng; k++) {
            const th = (k + 0.5) * 2 * Math.PI / nAng;
            v += kelvinV(x0 + r0 * Math.cos(th), y0 + r0 * Math.sin(th),
                x0, y0, fx, fy, kappa, Gmod);
        }
        return v / nAng;
    }

    // ══════════════════════════════════════════════════════════
    //  Westergaard crack-opening field (remote tension)
    // ══════════════════════════════════════════════════════════

    /**
     * Crack-induced extra v-displacement at (x, y ≥ 0) for a center crack
     * |x| ≤ a in an infinite plate under remote tension σ = 1 (plane stress).
     *
     *   V₀ = (1/E)·[ 2·Im(√(z²−a²) − z) − (1+ν)·y·(Re(z/√(z²−a²)) − 1) ]
     *
     * Checks: V₀(0, 0) = 2a/E (half-COD at center); V₀ → 0 as y → ∞.
     */
    function westergaardV0(x, y, a, E, nu) {
        const z = C(x, y);
        const s = sqrtZ2mA2(z, a);
        const Z = cdiv(z, s);   // z/√(z²−a²)
        return (1 / E) * (2 * (s.im - z.im) - (1 + nu) * y * (Z.re - 1));
    }

    // ══════════════════════════════════════════════════════════
    //  Modified Tate & Rosenfeld fastener flexibility
    // ══════════════════════════════════════════════════════════

    /**
     * Modified Tate & Rosenfeld single-shear fastener flexibility [in/kip].
     *
     *   f = 0.375/(Ef·t₁) + 0.375/(Ef·t₂)        (fastener bearing on holes)
     *     + 0.9/(E₁·t₁)   + 0.9/(E₂·t₂)          (sheet hole compliance)
     *     + 32(1+νf)(t₁+t₂)/(9·Ef·π·d²)          (fastener shear)
     *     + 8(t₁³+5t₁²t₂+5t₁t₂²+t₂³)/(5·Ef·π·d⁴) (fastener bending)
     *
     * @param {number} d   - Fastener diameter [in]
     * @param {number} t1  - Sheet 1 thickness (stringer) [in]
     * @param {number} E1  - Sheet 1 modulus [ksi]
     * @param {number} t2  - Sheet 2 thickness (skin) [in]
     * @param {number} E2  - Sheet 2 modulus [ksi]
     * @param {number} Ef  - Fastener modulus [ksi]
     * @param {number} nuf - Fastener Poisson ratio
     * @returns {number} flexibility f [in/kip]
     */
    function modTateRosenfeld(d, t1, E1, t2, E2, Ef, nuf) {
        const bearing = 0.375 / (Ef * t1) + 0.375 / (Ef * t2)
            + 0.9 / (E1 * t1) + 0.9 / (E2 * t2);
        const shear = 32 * (1 + nuf) * (t1 + t2) / (9 * Ef * Math.PI * d * d);
        const t13 = t1 * t1 * t1, t23 = t2 * t2 * t2;
        const bending = 8 * (t13 + 5 * t1 * t1 * t2 + 5 * t1 * t2 * t2 + t23)
            / (5 * Ef * Math.PI * Math.pow(d, 4));
        return bearing + shear + bending;
    }

    // ══════════════════════════════════════════════════════════
    //  Crack Green's functions for a restraining fastener pair
    // ══════════════════════════════════════════════════════════

    /**
     * σ_yy on the crack line (y = 0) due to a RESTRAINING pair of unit total
     * force (1 kip): (0, −1/t) at (x0, +b) and (0, +1/t) at (x0, −b),
     * summed over all source x-positions in x0list (real + optional image).
     */
    function pairSigYY(x, x0list, b, t, kappa) {
        let p = 0;
        for (const x0 of x0list) {
            p += kelvinSigYY(x, 0, x0, b, 0, -1 / t, kappa)
                + kelvinSigYY(x, 0, x0, -b, 0, 1 / t, kappa);
        }
        return p;
    }

    /**
     * Mode-I SIFs at both tips of a center crack of half-length aP due to a
     * unit restraining pair, by Bueckner superposition with the center-crack
     * weight functions (Gauss–Chebyshev quadrature):
     *
     *   K± = (1/√(π·aP)) ∫ σ_yy(x)·(aP ± x)/√(aP²−x²) dx
     *
     * Returns {Kp (tip at +aP), Km (tip at −aP)} [ksi√in per kip].
     */
    function pairKs(aP, x0list, b, t, kappa, n) {
        let Kp = 0, Km = 0;
        for (let q = 1; q <= n; q++) {
            const th = (2 * q - 1) * Math.PI / (2 * n);
            const x = aP * Math.cos(th);
            const p = pairSigYY(x, x0list, b, t, kappa);
            Kp += p * (aP + x);
            Km += p * (aP - x);
        }
        const cnorm = (Math.PI / n) / Math.sqrt(Math.PI * aP);
        return { Kp: Kp * cnorm, Km: Km * cnorm };
    }

    // ══════════════════════════════════════════════════════════
    //  Model assembly
    // ══════════════════════════════════════════════════════════

    /**
     * Build the a-independent part of the bridging model: per-fastener SIF
     * Green's functions K±_j(a′) on a master crack-length grid, cumulative
     * Betti compliance integrals S_ij(a′), and the Kelvin displacement
     * influence matrices for stringer and skin.
     *
     * @param {object} cfg
     *   aMax   - largest half-crack the model must cover [in]
     *   x0     - x-offset of the fastener line from the crack center [in]
     *   mirror - include image sources at −x0 (SENT free-edge half model)
     *   pitch  - vertical fastener spacing [in]
     *   nFast  - number of fastener pairs (each side of the crack plane)
     *   t1,E1,nu1 - cracked sheet (stringer)
     *   t2,E2,nu2 - background infinite sheet (skin)
     *   f      - fastener flexibility [in/kip]
     *   d      - fastener diameter [in] (Kelvin self-term cutoff = d/2)
     *   M      - master grid size (default 240)
     */
    function buildModel(cfg) {
        const kap1 = (3 - cfg.nu1) / (1 + cfg.nu1);
        const kap2 = (3 - cfg.nu2) / (1 + cfg.nu2);
        const G1 = cfg.E1 / (2 * (1 + cfg.nu1));
        const G2 = cfg.E2 / (2 * (1 + cfg.nu2));
        const N = cfg.nFast;
        const M = cfg.M || 240;
        const r0 = cfg.d / 2;

        const y = [];
        for (let j = 1; j <= N; j++) y.push(j * cfg.pitch);

        const x0list = cfg.mirror && Math.abs(cfg.x0) > 1e-12
            ? [cfg.x0, -cfg.x0] : [cfg.x0];

        // Master grid of half-crack lengths (index 0 → a′ = 0, K = 0)
        const aGrid = new Float64Array(M + 1);
        for (let m = 0; m <= M; m++) aGrid[m] = m * cfg.aMax / M;

        // K±_j(a′) per kip of fastener pair force
        const Kp = [], Km = [];
        for (let j = 0; j < N; j++) {
            const kp = new Float64Array(M + 1);
            const km = new Float64Array(M + 1);
            for (let m = 1; m <= M; m++) {
                const aP = aGrid[m];
                // resolve the σ_yy spike (width ~ y_j) near x0 on the crack line
                const n = Math.min(256, Math.max(64, Math.ceil(12 * aP / cfg.pitch)));
                const ks = pairKs(aP, x0list, y[j], cfg.t1, kap1, n);
                kp[m] = ks.Kp;
                km[m] = ks.Km;
            }
            Kp.push(kp); Km.push(km);
        }

        // Cumulative Betti compliance integrals
        //   S_ij(a) = ∫₀^a [K₊ᵢK₊ⱼ + K₋ᵢK₋ⱼ] da′    (symmetric in i,j)
        const da = cfg.aMax / M;
        const S = [];
        for (let i = 0; i < N; i++) {
            S.push([]);
            for (let j = 0; j <= i; j++) {
                const s = new Float64Array(M + 1);
                for (let m = 1; m <= M; m++) {
                    const g0 = Kp[i][m - 1] * Kp[j][m - 1] + Km[i][m - 1] * Km[j][m - 1];
                    const g1 = Kp[i][m] * Kp[j][m] + Km[i][m] * Km[j][m];
                    s[m] = s[m - 1] + 0.5 * (g0 + g1) * da;
                }
                S[i].push(s);
            }
        }

        // Kelvin displacement influence (a-independent).
        // vStrK[i][j]: v at the real fastener point (x0, y_i) in the STRINGER
        // due to a unit restraining pair at fastener j (negative — material is
        // dragged toward the crack plane).
        // vSkK[i][j]: same field evaluated with SKIN properties for the
        // restraining-pair sign; the skin actually receives the OPPOSITE
        // (opening) pair, handled by sign in solveAt.
        const vStrK = [], vSkK = [];
        for (let i = 0; i < N; i++) {
            vStrK.push(new Float64Array(N));
            vSkK.push(new Float64Array(N));
            for (let j = 0; j < N; j++) {
                let vs = 0, vk = 0;
                for (const x0 of x0list) {
                    vs += kelvinVCutoff(cfg.x0, y[i], x0, y[j], 0, -1 / cfg.t1, kap1, G1, r0)
                        + kelvinVCutoff(cfg.x0, y[i], x0, -y[j], 0, 1 / cfg.t1, kap1, G1, r0);
                }
                // Skin: real sources only (the intact skin has no free edge)
                vk += kelvinVCutoff(cfg.x0, y[i], cfg.x0, y[j], 0, -1 / cfg.t2, kap2, G2, r0)
                    + kelvinVCutoff(cfg.x0, y[i], cfg.x0, -y[j], 0, 1 / cfg.t2, kap2, G2, r0);
                vStrK[i][j] = vs;
                vSkK[i][j] = vk;
            }
        }

        return { cfg, y, aGrid, Kp, Km, S, vStrK, vSkK, M };
    }

    /** Linear interpolation on the master grid. */
    function interpGrid(model, arr, a) {
        const M = model.M;
        const h = model.cfg.aMax / M;
        if (a <= 0) return 0;
        if (a >= model.cfg.aMax) return arr[M];
        const u = a / h;
        const m = Math.min(M - 1, Math.floor(u));
        const w = u - m;
        return arr[m] * (1 - w) + arr[m + 1] * w;
    }

    /**
     * Solve the displacement-compatibility system at half-crack length a.
     *
     * @param {number} [dEps=0] - Far-field strain mismatch between the cracked
     *   sheet and the skin per unit remote stress: Δε/σ = 1/E₁ − ε_skin,y/σ.
     *   For a biaxially stressed skin (proportional loading, stresses given at
     *   peak stringer stress σ̂): Δε/σ = 1/E₁ − (σ_L − ν₂σ_H)/(E₂·σ̂).
     *   The mismatch adds a relative slip dEps·y_i measured from the crack
     *   plane (symmetric datum), increasing fastener load transfer when the
     *   skin strains less than the stringer (e.g., Poisson contraction from
     *   hoop tension).
     *
     * @returns {object} {
     *   R      - bridging restraint ratio at the +a tip (>1 = load attraction),
     *   Rm     - restraint ratio at the −a tip,
     *   F      - fastener pair forces per unit remote stress [kip/ksi],
     *   y      - fastener y-positions [in]
     * }
     */
    function solveAt(model, a, dEps = 0) {
        const { cfg, y, M } = model;
        const N = y.length;
        if (a <= 1e-9 || N === 0) return { R: 1, Rm: 1, F: new Float64Array(N), y, Ptot: 0 };

        // Assemble A·F = rhs
        const A = [];
        const rhs = new Float64Array(N);
        for (let i = 0; i < N; i++) {
            A.push(new Float64Array(N));
            for (let j = 0; j < N; j++) {
                const Sij = i >= j ? model.S[i][j] : model.S[j][i];
                const Gstr = -model.vStrK[i][j] + (cfg.t1 / cfg.E1) * interpGrid(model, Sij, a);
                const Gsk = -model.vSkK[i][j];
                A[i][j] = Gstr + Gsk + (i === j ? cfg.f : 0);
            }
            rhs[i] = westergaardV0(cfg.x0, y[i], a, cfg.E1, cfg.nu1) + dEps * y[i];
        }

        const F = gaussSolve(A, rhs);
        if (!F) return { R: 1, Rm: 1, F: new Float64Array(N), y, Ptot: 0 };

        // Tip SIF reduction per unit remote stress (weight-function route;
        // retained as a diagnostic — the geometry uses the bypass route, below)
        let dKp = 0, dKm = 0;
        // Total load (per unit remote stress) transferred out of the cracked
        // sheet into the skin on one side of the crack = the load that bypasses
        // the crack section. Each F[j] is the force in the upper fastener of
        // pair j (the lower fastener returns it below the crack), so the
        // one-sided bypassed load is Σ_j F[j].
        let Ptot = 0;
        for (let j = 0; j < N; j++) {
            dKp += F[j] * interpGrid(model, model.Kp[j], a);
            dKm += F[j] * interpGrid(model, model.Km[j], a);
            Ptot += F[j];
        }
        const K0 = Math.sqrt(Math.PI * a);   // unbridged center-crack K per unit σ
        // R may exceed 1 when the skin strains more than the stringer and
        // pumps load into it (load attraction); pure crack-bridging gives R ≤ 1.
        const clampR = (r) => Math.min(2, Math.max(0.05, r));
        return {
            R: clampR(1 + dKp / K0),
            Rm: clampR(1 + dKm / K0),
            F, y, Ptot
        };
    }

    /** Dense Gaussian elimination with partial pivoting (small N). */
    function gaussSolve(A, b) {
        const n = b.length;
        const M = A.map((row, i) => {
            const r = Array.from(row); r.push(b[i]); return r;
        });
        for (let k = 0; k < n; k++) {
            let piv = k;
            for (let i = k + 1; i < n; i++) {
                if (Math.abs(M[i][k]) > Math.abs(M[piv][k])) piv = i;
            }
            if (Math.abs(M[piv][k]) < 1e-30) return null;
            [M[k], M[piv]] = [M[piv], M[k]];
            for (let i = k + 1; i < n; i++) {
                const fac = M[i][k] / M[k][k];
                for (let j = k; j <= n; j++) M[i][j] -= fac * M[k][j];
            }
        }
        const x = new Float64Array(n);
        for (let i = n - 1; i >= 0; i--) {
            let s = M[i][n];
            for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
            x[i] = s / M[i][i];
        }
        return x;
    }

    return {
        modTateRosenfeld,
        buildModel,
        solveAt,
        // exposed for verification tests
        _internals: {
            kelvinSigYY, kelvinSigXX, kelvinV, kelvinVCutoff, westergaardV0,
            pairSigYY, pairKs, gaussSolve, sqrtZ2mA2, C
        }
    };
})();

if (typeof window !== 'undefined') {
    window.Bridging = Bridging;
}
