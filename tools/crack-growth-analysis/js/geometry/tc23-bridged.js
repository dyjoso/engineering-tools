/**
 * tc23-bridged.js — TC23B: Cracked Stringer at a Fastener Hole with
 *                   Skin Bridging (vertical fastener row through the hole)
 *
 * Extends TC23 (unequal through cracks at an offset hole in a finite-width
 * plate) for the case where the cracked plate is a stringer (modelled by its
 * unfolded width) attached to a background infinite fuselage skin by a single
 * vertical line of fasteners passing through the critical (cracked) hole.
 *
 * As the crack opens, the fasteners above and below the crack plane transfer
 * load into the intact skin, which bridges the crack and retards growth.
 *
 * The Swift displacement-compatibility solve (see bridging.js) gives the
 * equilibrium fastener loads F_j. The bridging then reduces K through the
 * LOAD-BYPASS mechanism: the load shed into the skin bypasses the crack
 * section, so the membrane stress reaching the crack is the bypass stress
 *
 *   P_applied = S_gross · W · t                (total stringer load, S_gross = σ + (D/W)·S₃)
 *   P_total   = Σ_j F_j(a) − Σ_j F_j(0)        (CRACK-DRIVEN load bypassed via the skin)
 *   S_bypass  = S_gross · (P_applied − P_total) / P_applied
 *   R_bypass  = S_bypass / S_gross = 1 − P_total / (S_gross · W · t)
 *
 * The no-crack baseline Σ_j F_j(0) is subtracted because the far-field strain
 * mismatch (biaxial/hoop skin stress) produces distributed stringer↔skin
 * load-sharing that exists with no crack and does NOT bypass the crack — it is
 * a global load-share already represented in the input stringer stress. Only
 * the crack-driven increment bypasses the crack section. In strain-matched mode
 * the baseline is identically zero.
 *
 * and K's membrane (tension) contribution is scaled by R_bypass:
 *
 *   K_bridged = R_bypass · K_tension + K_bending + K_bearing
 *
 * (bending and bearing are separate load paths and are not bypassed). Because
 * the fastener loads scale with the remote stress, R_bypass is stress-
 * independent. This replaces the earlier weight-function crack-face-traction
 * reduction (still computed in bridging.js as a diagnostic) — applying both
 * would double-count the same fastener loads.
 *
 * Two-crack phase:  effective centre crack 2c₀ = c₁ + D + c₂, fastener line
 *                   taken through the flaw centre (exact for c₁ = c₂).
 * Post-link-up SENT phase: edge crack a_edge modelled as a half centre crack
 *                   (model centre at the right plate edge) with the fastener
 *                   line at depth m and free-edge image sources at −m; the
 *                   intact skin sees the real fastener forces only.
 *
 * Fastener stiffness: modified Tate & Rosenfeld equation (0.375 fastener-
 * bearing and 0.9 sheet-bearing hole-compliance numerators).
 *
 * Assumptions (documented in docs/technical-reference.md):
 *  - bridging influence functions use infinite-sheet fields for the stringer
 *    (finite width enters through the TC23 β factors, standard compounding)
 *  - skin and stringer share the same far-field strain (no pre-existing
 *    load transfer); bridging forces arise from crack opening only
 *  - fastener failure is flagged against the optional shear allowable but
 *    not progressively released
 *  - the fastener in the cracked hole itself transfers no bridging load
 *    (it sits on the crack plane); bearing transfer can still be applied
 *    via the S₃ input
 */

class TC23BGeometry extends TC23Geometry {
    constructor() {
        super();
        this.id = 'TC23B';
        this.label = 'TC23B — Cracked Stringer at Hole, Skin-Bridged (Fastener Row)';
        this._models = { token: null, phase1: null, sent: null };
        this._rCache = { phase1: new Map(), sent: new Map() };
    }

    // ══════════════════════════════════════════════════════════
    //  Bridging model management
    // ══════════════════════════════════════════════════════════

    _bridgeToken(params) {
        return [
            params.W, params.D, params.m, params.t,
            params.EStr, params.nuStr,
            params.ESkin, params.tSkin, params.nuSkin,
            params.pFast, params.DFast, params.EFast, params.nuFast,
            params.nFast,
            params.skinStress, params.sigL, params.sigH, params._sigmaMax
        ].join('|');
    }

    /**
     * Far-field strain mismatch between stringer and skin per unit applied
     * stringer stress (proportional loading: skin stresses are specified at
     * the peak stringer stress σ̂ and scale with it through the cycle).
     *
     * Modes (params.skinStress):
     *
     *  'match' (default): skin longitudinal strain identical to the stringer
     *      far field (edges effectively coincident). Δε = 0 — bridging forces
     *      arise from crack opening only.
     *
     *  'hoop': longitudinal strain compatibility is RETAINED, and a specified
     *      hoop (transverse) stress σ_H adds Poisson contraction of the skin:
     *        Δε/σ = ν_skin·σ_H / (E_skin·σ̂)
     *      This is the intended fuselage case: skin works with the stringer
     *      axially, hoop tension increases the fastener load transfer.
     *
     *  'biaxial': BOTH skin stresses specified absolutely:
     *        Δε/σ = 1/E_str − (σ_L − ν_skin·σ_H)/(E_skin·σ̂)
     *      Note σ_L = 0 means a longitudinally unloaded skin — the skin then
     *      acts as a doubler absorbing stringer load (strong retardation).
     *      Equivalent to 'hoop' when σ_L = σ̂·E_skin/E_str.
     *
     * Positive Δε (skin strains less than the stringer) increases fastener
     * load transfer and crack restraint.
     */
    _dEpsUnit(params) {
        const mode = params.skinStress;
        if (mode !== 'biaxial' && mode !== 'hoop') return 0;
        const s0 = params._sigmaMax;
        if (!(s0 > 0)) return 0;
        if (mode === 'hoop') {
            return params.nuSkin * params.sigH / (params.ESkin * s0);
        }
        return 1 / params.EStr
            - (params.sigL - params.nuSkin * params.sigH) / (params.ESkin * s0);
    }

    _getModel(params, phase) {
        const token = this._bridgeToken(params);
        if (this._models.token !== token) {
            this._models = { token, phase1: null, sent: null };
            this._rCache = { phase1: new Map(), sent: new Map() };
        }
        if (!this._models[phase]) {
            for (const k of ['t', 'EStr', 'nuStr', 'tSkin', 'ESkin', 'nuSkin',
                'pFast', 'DFast', 'EFast', 'nuFast', 'nFast']) {
                if (!isFinite(params[k]) || params[k] <= 0 && k.indexOf('nu') !== 0) {
                    throw new Error(`TC23B bridging input '${k}' missing or invalid (${params[k]}).`);
                }
            }
            const m = params.m !== undefined ? params.m : params.W / 2;
            const f = Bridging.modTateRosenfeld(
                params.DFast, params.t, params.EStr,
                params.tSkin, params.ESkin, params.EFast, params.nuFast);
            const cfg = {
                aMax: params.W,
                x0: phase === 'sent' ? m : 0,
                mirror: phase === 'sent',
                pitch: params.pFast,
                nFast: Math.max(1, Math.min(60, Math.round(params.nFast || 12))),
                t1: params.t, E1: params.EStr, nu1: params.nuStr,
                t2: params.tSkin, E2: params.ESkin, nu2: params.nuSkin,
                f, d: params.DFast
            };
            this._models[phase] = Bridging.buildModel(cfg);
        }
        return this._models[phase];
    }

    /**
     * Load-bypass factor R_bypass = 1 − P_total/(S_gross·W·t) applied to the
     * membrane (tension) SIF, where
     *   P_applied = S_gross·W·t,  S_gross = σ + (D/W)·S₃  (gross-section basis)
     * and PtotUnit is the crack-driven bypass load per unit membrane stress σ.
     * Dividing by (S_gross/σ)·W·t cancels σ, so the factor is stress-independent
     * under proportional loading. Clamped to [0.05, 2] (>1 = load attraction).
     */
    _bypassFactor(PtotUnit, params) {
        const WT = params.W * params.t;
        if (!(WT > 0)) return 1.0;
        const s0 = params._sigmaMax;
        const S3 = params.S3 || 0;
        const grossRatio = (s0 > 0 && S3 > 0)
            ? 1 + (params.D / params.W) * (S3 / s0) : 1;
        return Math.min(2, Math.max(0.05, 1 - PtotUnit / (grossRatio * WT)));
    }

    /**
     * No-crack baseline of Σ_j F_j (per unit stress): the distributed
     * stringer↔skin load-sharing driven by the far-field strain mismatch,
     * which exists independent of the crack (and is an artefact of the finite
     * fastener row — it scales with the row length). Subtracted from Σ_j F_j(a)
     * so that P_total is the crack-DRIVEN bypass load only. Identically zero in
     * strain-matched mode (Δε = 0). Cached on the model object (one per
     * geometry/skin-stress token).
     */
    _baselinePtot(model, params) {
        if (model._Ptot0 === undefined) {
            const aSmall = model.cfg.aMax / 8000;
            model._Ptot0 = Bridging.solveAt(model, aSmall, this._dEpsUnit(params)).Ptot;
        }
        return model._Ptot0;
    }

    /**
     * Bypass factor at effective half-crack aEff.
     * Cached on a fine quantised grid (varies smoothly with aEff).
     */
    _restraint(params, aEff, phase) {
        if (params.useBridge !== 'yes') return 1.0;
        if (!(aEff > 0)) return 1.0;
        const model = this._getModel(params, phase);
        const aMax = model.cfg.aMax;
        const q = Math.round(aEff / (aMax / 8000));
        const cache = this._rCache[phase];
        let R = cache.get(q);
        if (R === undefined) {
            const sol = Bridging.solveAt(model, Math.min(q * aMax / 8000, aMax),
                this._dEpsUnit(params));
            const Pbypass = sol.Ptot - this._baselinePtot(model, params);
            R = this._bypassFactor(Pbypass, params);
            if (cache.size > 20000) cache.clear();
            cache.set(q, R);
        }
        return R;
    }

    /** Effective half-crack and restraint for the two-crack phase. */
    _restraintPhase1(c, params, side) {
        let c1, c2;
        if (side === 'left') {
            c1 = c;
            c2 = params._c2 !== undefined ? params._c2 : (params.a0_2 || c);
        } else {
            c1 = params._c1 !== undefined ? params._c1 : (params.a0 || c);
            c2 = c;
        }
        const aEff = (c1 + params.D + c2) / 2.0;
        return this._restraint(params, aEff, 'phase1');
    }

    // ══════════════════════════════════════════════════════════
    //  SIF interface overrides — load bypass on the MEMBRANE STRESS
    //
    //  The geometry β factors (getBeta / getBetaEdge) are NOT overridden:
    //  they remain the pure TC23 geometry SIF correction factors, so the
    //  analysis-log β column is the geometry factor (as in standard DTA
    //  practice). The bypass instead reduces the membrane stress used to
    //  form K, i.e.  K_membrane = β · S_bypass · √(πc),  S_bypass = R·S₀.
    //  Bending (S₂) and bearing (S₃) are separate load paths and keep S₀.
    // ══════════════════════════════════════════════════════════

    /** Bypass factor R = S_bypass/S₀ for the two-crack phase (1 if no bridging). */
    getBypassFactor(c, params, side) {
        if (params.useBridge !== 'yes') return 1.0;
        return this._restraintPhase1(c, params, side);
    }

    /** Bypass factor R = S_bypass/S₀ for the SENT phase (1 if no bridging). */
    getBypassFactorEdge(aEdge, params) {
        if (params.useBridge !== 'yes') return 1.0;
        return this._restraint(params, aEdge, 'sent');
    }

    getK(c, sigma, params, side) {
        const K = super.getK(c, sigma, params, side);   // β_geom · σ · √(πc)
        if (K < 0 || params.useBridge !== 'yes') return K;
        return K * this._restraintPhase1(c, params, side);   // → β_geom · S_bypass · √(πc)
    }

    getK_total(c, S0, S3, params, side) {
        const Kfull = super.getK_total(c, S0, S3, params, side);
        if (Kfull < 0 || params.useBridge !== 'yes') return Kfull;
        const betaA = super.getBeta(c, params, side);   // pure geometry β
        if (betaA < 0) return Kfull;
        // Bypass reduces ONLY the membrane (tension) contribution; bending and
        // bearing keep the full stress.
        const Rb = this._restraintPhase1(c, params, side);
        const Ktension = betaA * S0 * Math.sqrt(Math.PI * c);
        return Kfull - (1 - Rb) * Ktension;
    }

    getKEdge(aEdge, sigma, params) {
        const K = super.getKEdge(aEdge, sigma, params);
        if (K < 0 || params.useBridge !== 'yes') return K;
        return K * this._restraint(params, aEdge, 'sent');
    }

    getKEdge_total(aEdge, S0, S3, params) {
        const Kfull = super.getKEdge_total(aEdge, S0, S3, params);
        if (Kfull < 0 || params.useBridge !== 'yes') return Kfull;
        const betaE = super.getBetaEdge(aEdge, params);   // pure geometry β
        if (betaE < 0) return Kfull;
        const Rb = this._restraint(params, aEdge, 'sent');
        const Ktension = betaE * S0 * Math.sqrt(Math.PI * aEdge);
        return Kfull - (1 - Rb) * Ktension;
    }

    // ══════════════════════════════════════════════════════════
    //  Fastener load reporting
    // ══════════════════════════════════════════════════════════

    /**
     * Fastener bridging loads at a given crack state and peak stress.
     *
     * @param {object} params - Geometry parameters
     * @param {object} state  - {c1, c2} (two-crack phase) or {aEdge} (SENT)
     * @param {number} sigmaMax - Peak applied stress [ksi]
     * @returns {object|null} {
     *     F[ kip ], y[ in ], maxF[ kip ],
     *     R         - applied bypass factor (S_bypass/S_gross),
     *     Ptot      - total load bypassing the crack via the skin [kip],
     *     Papplied  - total stringer load [kip],
     *     Sbypass   - membrane bypass stress at the crack [ksi],
     *     weightFnR - weight-function restraint ratio (diagnostic)
     *   } or null
     */
    getFastenerState(params, state, sigmaMax) {
        if (params.useBridge !== 'yes') return null;
        let phase, aEff;
        if (state.aEdge !== undefined) {
            phase = 'sent';
            aEff = state.aEdge;
        } else {
            phase = 'phase1';
            aEff = (state.c1 + params.D + state.c2) / 2.0;
        }
        if (!(aEff > 0)) return null;
        const model = this._getModel(params, phase);
        const dE = this._dEpsUnit(params);
        const sol = Bridging.solveAt(model, Math.min(aEff, model.cfg.aMax), dE);
        const sol0 = Bridging.solveAt(model, model.cfg.aMax / 8000, dE);  // no-crack baseline
        // Crack-driven fastener load increments (remove the no-crack load-sharing
        // baseline so the reported loads and P_total are the bridging action only).
        const F = Array.from(sol.F, (v, j) => (v - sol0.F[j]) * sigmaMax);
        const PbypassUnit = sol.Ptot - sol0.Ptot;
        const Rb = this._bypassFactor(PbypassUnit, params);
        const S3 = params.S3 || 0;
        const grossRatio = (sigmaMax > 0 && S3 > 0)
            ? 1 + (params.D / params.W) * (S3 / sigmaMax) : 1;
        const Sgross = sigmaMax * grossRatio;
        return {
            F,
            y: Array.from(sol.y),
            R: Rb,
            Ptot: PbypassUnit * sigmaMax,
            Papplied: Sgross * params.W * params.t,
            Sbypass: Sgross * Rb,
            weightFnR: sol.R,
            maxF: F.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
        };
    }

    // ══════════════════════════════════════════════════════════
    //  UI
    // ══════════════════════════════════════════════════════════

    getInputFields() {
        const G_STR = 'Stringer Properties';
        const G_OPT = 'Analysis Options';
        const G_SKIN = 'Skin Properties';
        const G_FAST = 'Fastener Properties';
        return [
            // ── Stringer (the cracked member) ──
            { group: G_STR, id: 'W', label: 'Stringer Unfolded Width, W', unit: 'in', default: 4.0, step: 0.1, min: 0.01 },
            { group: G_STR, id: 't', label: 'Stringer Thickness, t', unit: 'in', default: 0.063, step: 0.001, min: 0.001 },
            { group: G_STR, id: 'D', label: 'Hole Diameter, D', unit: 'in', default: 0.25, step: 0.01, min: 0.01 },
            { group: G_STR, id: 'm', label: 'Right Margin (hole centre to right edge), m', unit: 'in', default: 2.0, step: 0.05, min: 0 },
            { group: G_STR, id: 'a0', label: 'Left Crack, c₁₀', unit: 'in', default: 0.05, step: 0.005, min: 0.001 },
            { group: G_STR, id: 'a0_2', label: 'Right Crack, c₂₀', unit: 'in', default: 0.05, step: 0.005, min: 0.001 },
            { group: G_STR, id: 'EStr', label: 'Stringer Modulus, E_str', unit: 'ksi', default: 10300.0, step: 100, min: 1.0 },
            { group: G_STR, id: 'nuStr', label: 'Stringer Poisson Ratio, ν_str', unit: '—', default: 0.33, step: 0.01, min: 0, max: 0.49 },

            // ── Analysis options (method / modelling choices) ──
            { group: G_OPT, id: 'useBridge', label: 'Skin Bridging', type: 'toggle', default: 'yes', onValue: 'yes', offValue: 'no', full: true },
            { group: G_OPT, id: 'bearingModel', label: 'Bearing β Model (S₃)', type: 'select', options: [{ value: 'nasgro', label: 'NASGRO TC23 Solution C' }, { value: 'hybrid05', label: 'Hybrid: TC05 FEM → TC23 (c/D=0.5…1)' }, { value: 'effwidth', label: 'Effective width (W_eff = 7D, local reaction)' }], default: 'nasgro', full: true },
            { group: G_OPT, id: 'eta', label: 'Bending Restraint, η (0=free, 1=fixed)', unit: '—', default: 0, step: 0.1, min: 0, max: 1 },

            // ── Skin (bridging sheet) ──
            { group: G_SKIN, id: 'ESkin', label: 'Skin Modulus, E_skin', unit: 'ksi', default: 10300.0, step: 100, min: 1.0 },
            { group: G_SKIN, id: 'tSkin', label: 'Skin Thickness, t_skin', unit: 'in', default: 0.05, step: 0.001, min: 0.001 },
            { group: G_SKIN, id: 'nuSkin', label: 'Skin Poisson Ratio, ν_skin', unit: '—', default: 0.33, step: 0.01, min: 0, max: 0.49 },
            { group: G_SKIN, id: 'skinStress', label: 'Skin Far-Field Stress State', type: 'select', options: [{ value: 'match', label: 'Strain-matched to stringer' }, { value: 'hoop', label: 'Strain-matched + hoop σ_H (Poisson)' }, { value: 'biaxial', label: 'Fully specified σ_L, σ_H (absolute)' }], default: 'match', full: true },
            { group: G_SKIN, id: 'sigL', label: 'Skin Longitudinal Stress at σ_max, σ_L (fully-specified mode only; 0 = unloaded skin/doubler)', unit: 'ksi', default: 0, step: 0.5, full: true },
            { group: G_SKIN, id: 'sigH', label: 'Skin Hoop (Transverse) Stress at σ_max, σ_H', unit: 'ksi', default: 0, step: 0.5, full: true },

            // ── Fasteners (stringer-to-skin attachment) ──
            { group: G_FAST, id: 'pFast', label: 'Fastener Vertical Pitch, p', unit: 'in', default: 1.0, step: 0.05, min: 0.05 },
            { group: G_FAST, id: 'DFast', label: 'Fastener Diameter, d', unit: 'in', default: 0.1875, step: 0.01, min: 0.01 },
            { group: G_FAST, id: 'EFast', label: 'Fastener Modulus, E_fast', unit: 'ksi', default: 10300.0, step: 100, min: 1.0 },
            { group: G_FAST, id: 'nuFast', label: 'Fastener Poisson Ratio, ν_fast', unit: '—', default: 0.33, step: 0.01, min: 0, max: 0.49 },
            { group: G_FAST, id: 'nFast', label: 'Fasteners Each Side of Crack, n', unit: '—', default: 12, step: 1, min: 1, max: 60 },
            { group: G_FAST, id: 'FfAllow', label: 'Fastener Shear Allowable (0 = no check)', unit: 'kip', default: 0, step: 0.05, min: 0, full: true }
        ];
    }

    /**
     * Draw the TC23 schematic plus the vertical fastener row through the
     * critical hole and the background skin.
     */
    drawDiagram(ctx, params, c, canvasW, canvasH) {
        super.drawDiagram(ctx, params, c, canvasW, canvasH);
        if (params.useBridge !== 'yes') return;

        // Reconstruct super's layout
        const pad = 40;
        const plateW = canvasW - 2 * pad;
        const plateH = canvasH - 2 * pad - 20;
        const cy = canvasH / 2;
        const x0 = pad;
        const y0 = pad + 10;
        const W = params.W || 4;
        const m = params.m !== undefined ? params.m : W / 2;
        const B = W - m;
        const scale = plateW / W;
        const holeCx = x0 + B * scale;

        // Fastener row through the hole (vertical = load direction)
        const p = params.pFast || 1.0;
        const pPx = p * scale;
        const fastR = Math.max(2.5, Math.min(4, (params.DFast || 0.19) * scale / 2));

        ctx.save();
        // row centreline
        ctx.strokeStyle = 'rgba(37, 99, 235, 0.35)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 4]);
        ctx.beginPath();
        ctx.moveTo(holeCx, y0);
        ctx.lineTo(holeCx, y0 + plateH);
        ctx.stroke();
        ctx.setLineDash([]);

        const drawFastener = (fy) => {
            ctx.beginPath();
            ctx.arc(holeCx, fy, fastR, 0, 2 * Math.PI);
            ctx.fillStyle = 'rgba(37, 99, 235, 0.75)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.lineWidth = 0.8;
            ctx.stroke();
        };
        const maxDist = plateH / 2 - 5;
        for (let dist = pPx; dist <= maxDist; dist += pPx) {
            drawFastener(cy - dist);
            drawFastener(cy + dist);
        }

        // pitch dimension (first two fasteners above the hole)
        if (2 * pPx <= maxDist) {
            const dimX = holeCx + 16;
            ctx.strokeStyle = '#6366f1';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(dimX, cy - pPx);
            ctx.lineTo(dimX, cy - 2 * pPx);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(holeCx + fastR + 2, cy - pPx); ctx.lineTo(dimX + 3, cy - pPx);
            ctx.moveTo(holeCx + fastR + 2, cy - 2 * pPx); ctx.lineTo(dimX + 3, cy - 2 * pPx);
            ctx.stroke();
            ctx.fillStyle = '#6366f1';
            ctx.font = '10px Inter, sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('p', dimX + 4, cy - 1.5 * pPx + 3);
        }

        // skin note
        ctx.fillStyle = 'rgba(37, 99, 235, 0.65)';
        ctx.font = '9px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('FASTENED TO INFINITE SKIN', x0 + 4, y0 + plateH - 6);
        ctx.restore();
    }
}

// Register TC23B
registerGeometry(new TC23BGeometry());
