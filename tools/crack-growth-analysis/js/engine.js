/**
 * engine.js — Crack growth analysis engine
 * 
 * Runs the crack growth integration loop using a geometry + material + NASGRO equation.
 * Supports both single-crack (TC01) and dual-crack (TC23) geometries.
 * Produces output arrays for plotting and a structured result object.
 */

const CrackGrowthEngine = {

    /**
     * Run a crack growth analysis.
     * 
     * @param {object} config
     * @param {string} config.geometryId   - Geometry case ID (e.g. 'TC01')
     * @param {object} config.geomParams   - Geometry parameters (W, t, etc.)
     * @param {number} config.a0           - Initial crack length [in] (or left crack for dual)
     * @param {number} [config.a0_2]       - Initial right crack for dual-crack geometries [in]
     * @param {number} config.sigmaMax     - Maximum applied stress [ksi]
     * @param {number} config.R            - Stress ratio
     * @param {object} config.material     - Material properties object
     * @param {number} [config.maxCycles=1e7]  - Maximum cycles before stopping
     * @param {number} [config.maxSteps=50000] - Maximum integration steps
     * @returns {object} Analysis results
     */
    run(config) {
        const geom = getGeometry(config.geometryId);

        if (geom.isDualCrack()) {
            return this._runDual(config, geom);
        }
        return this._runSingle(config, geom);
    },

    // ── Single-crack engine (TC01 and simple geometries) ──────

    _runSingle(config, geom) {
        const mat = config.material;
        const R = config.R;
        const sigmaMax = config.sigmaMax;
        const t = config.geomParams.t;

        const maxCycles = config.maxCycles || 1e7;
        const maxSteps = config.maxSteps || 50000;

        const Kc = NasgroEquation.calcKc(t, mat);
        const aMax = geom.getMaxCrack(config.geomParams);

        let a = config.a0;
        let N = 0;
        let step = 0;
        let failureMode = 'Running';

        const data = {
            N: [0], a: [a], twoA: [2 * a],
            Kmax: [0], dK: [0], dadN: [0], beta: [0]
        };
        const logEntries = [];

        while (step < maxSteps) {
            if (a >= aMax) { failureMode = 'Geometry Limit (a/W)'; break; }

            const Kmax = geom.getK(a, sigmaMax, config.geomParams);
            if (Kmax < 0) { failureMode = 'Geometry Limit'; break; }
            const beta = geom.getBeta(a, config.geomParams);

            if (Kmax >= Kc) {
                failureMode = 'Fracture (Kmax ≥ Kc)';
                logEntries.push(this._logEntry(N, a, Kmax, 0, 0, beta, 'FRACTURE'));
                break;
            }

            const sigmaNet = geom.getNetSectionStress(a, sigmaMax, config.geomParams);
            if (sigmaNet >= mat.Yield) {
                failureMode = 'Net Section Yield';
                logEntries.push(this._logEntry(N, a, Kmax, 0, 0, beta, 'NSY'));
                break;
            }

            const result = NasgroEquation.growthRate(Kmax, R, mat, Kc);
            if (result.dadN <= 0) {
                failureMode = 'Below Threshold (No Growth)';
                logEntries.push(this._logEntry(N, a, Kmax, result.dK, 0, beta, 'THRESHOLD'));
                break;
            }

            const delta_a = this._adaptiveStep(Kmax, Kc, a, aMax);
            const delta_N = delta_a / result.dadN;

            if (step === 0 || step % 50 === 0) {
                logEntries.push(this._logEntry(N, a, Kmax, result.dK, result.dadN, beta));
            }

            a += delta_a;
            N += delta_N;
            step++;

            data.N.push(N);
            data.a.push(a);
            data.twoA.push(2 * a);
            data.Kmax.push(Kmax);
            data.dK.push(result.dK);
            data.dadN.push(result.dadN);
            data.beta.push(beta);

            if (N >= maxCycles) { failureMode = 'Max Cycles Reached'; break; }
        }

        if (step >= maxSteps && failureMode === 'Running') {
            failureMode = 'Max Steps Reached';
        }

        const finalK = geom.getK(a, sigmaMax, config.geomParams);
        const finalBeta = geom.getBeta(a, config.geomParams);
        logEntries.push(this._logEntry(N, a, Math.max(finalK, 0), 0, 0, Math.max(finalBeta, 0), 'END'));

        return {
            failureMode,
            finalCrack: a,
            finalTwoA: 2 * a,
            totalCycles: N,
            totalSteps: step,
            Kc,
            data,
            logEntries,
            isDual: false
        };
    },

    // ── Dual-crack engine (TC23 offset/unequal) ──────────────

    _runDual(config, geom) {
        const mat = config.material;
        const R = config.R;
        const sigmaMax = config.sigmaMax;
        const t = config.geomParams.t;

        const maxCycles = config.maxCycles || 1e7;
        const maxSteps = config.maxSteps || 50000;

        const Kc = NasgroEquation.calcKc(t, mat);

        // Initial crack lengths
        let c1 = config.a0;                                       // Left crack
        let c2 = config.a0_2 !== undefined ? config.a0_2 : config.a0; // Right crack

        const c1Max = geom.getMaxCrack(config.geomParams, 'left');
        const c2Max = geom.getMaxCrack(config.geomParams, 'right');

        const S3 = config.geomParams.S3 || 0;  // Bearing stress
        const S2 = config.geomParams.S2 || 0;  // Bending stress
        const useTotal = (S3 > 0 || S2 !== 0) && geom.getK_total;
        let N = 0;
        let step = 0;
        let failureMode = 'Running';
        let failureSide = null;

        // Output data arrays (track both cracks)
        const data = {
            N: [0],
            c1: [c1], c2: [c2],
            a: [Math.max(c1, c2)],      // "a" = critical crack for chart compatibility
            twoA: [2 * Math.max(c1, c2)],
            Kmax: [0], Kmax1: [0], Kmax2: [0],
            dK: [0], dadN: [0],
            beta1: [0], beta2: [0]
        };
        const logEntries = [];

        while (step < maxSteps) {
            // Geometry limits
            if (c1 >= c1Max) { failureMode = 'Geometry Limit (left)'; failureSide = 'left'; break; }
            if (c2 >= c2Max) {
                // RHS ligament broken — transition to edge crack
                logEntries.push(this._logEntryDual(N, c1, c2,
                    geom.getK(c1, sigmaMax, config.geomParams, 'left'),
                    geom.getK(c2, sigmaMax, config.geomParams, 'right'),
                    0, 0, 0,
                    geom.getBeta(c1, config.geomParams, 'left'),
                    geom.getBeta(c2, config.geomParams, 'right'), 'LINK-UP'));
                return this._runEdgeCrackPhase(config, geom, c1, N, step, data, logEntries, Kc);
            }

            // Set current crack lengths on params so geometry can compute global F_width
            config.geomParams._c1 = c1;
            config.geomParams._c2 = c2;

            // Calculate K for each tip (combined: tension + bending + bearing)
            // First pass: LEFM K with physical crack lengths
            const calcK = (c_tip, side) => {
                return useTotal
                    ? geom.getK_total(c_tip, sigmaMax, S3, config.geomParams, side)
                    : geom.getK(c_tip, sigmaMax, config.geomParams, side);
            };

            let K1 = calcK(c1, 'left');
            let K2 = calcK(c2, 'right');

            // Irwin plastic zone correction (2 iterations)
            // r_y = (K / σ_flow)² / (2·α·π)
            // Guard: if effective crack exceeds geometry limits, keep uncorrected K
            const sigma_flow = (mat.Yield + mat.UTS) / 2.0;
            const alpha_pz = mat.alpha || 1.5;
            const pzFactor = 1.0 / (2.0 * alpha_pz * Math.PI);

            for (let pzIter = 0; pzIter < 2; pzIter++) {
                const ry1 = (K1 > 0) ? pzFactor * Math.pow(K1 / sigma_flow, 2) : 0;
                const ry2 = (K2 > 0) ? pzFactor * Math.pow(K2 / sigma_flow, 2) : 0;

                // Recalculate K with effective crack lengths
                config.geomParams._c1 = c1 + ry1;
                config.geomParams._c2 = c2 + ry2;
                const K1_corr = calcK(c1 + ry1, 'left');
                const K2_corr = calcK(c2 + ry2, 'right');

                // Only accept correction if geometry is still valid
                if (K1_corr > 0) K1 = K1_corr;
                if (K2_corr > 0) K2 = K2_corr;
            }

            // Restore physical crack lengths for growth step
            config.geomParams._c1 = c1;
            config.geomParams._c2 = c2;
            if (K1 < 0) { failureMode = 'Geometry Limit (left)'; failureSide = 'left'; break; }
            // Right-side geometry limit → treat as link-up (ligament broken)
            if (K2 < 0) {
                logEntries.push(this._logEntryDual(N, c1, c2,
                    Math.max(K1, 0), 0, 0, 0, 0,
                    geom.getBeta(c1, config.geomParams, 'left'), 0, 'LINK-UP'));
                return this._runEdgeCrackPhase(config, geom, c1, N, step, data, logEntries, Kc);
            }

            const beta1 = geom.getBeta(c1, config.geomParams, 'left');
            const beta2 = geom.getBeta(c2, config.geomParams, 'right');

            const Kmax = Math.max(K1, K2);

            // Fracture check — left tip only terminates; right tip = link-up
            if (K1 >= Kc) {
                failureMode = 'Fracture — Left Tip (K₁ ≥ Kc)';
                failureSide = 'left';
                logEntries.push(this._logEntryDual(N, c1, c2, K1, K2, 0, 0, 0, beta1, beta2, 'FRACTURE-L'));
                break;
            }
            if (K2 >= Kc) {
                // Right ligament fracture = link-up event → transition to SENT
                logEntries.push(this._logEntryDual(N, c1, c2, K1, K2, 0, 0, 0, beta1, beta2, 'LINK-UP'));
                return this._runEdgeCrackPhase(config, geom, c1, N, step, data, logEntries, Kc);
            }

            // Net section yield (minimum ligament) — uses flow stress
            const sigma_flow_nsy = (mat.Yield + mat.UTS) / 2.0;
            const S_gross = sigmaMax + (S3 > 0 ? (config.geomParams.D / config.geomParams.W) * S3 : 0);
            const sigmaNet1 = geom.getNetSectionStress(c1, S_gross, config.geomParams, 'left');
            const sigmaNet2 = geom.getNetSectionStress(c2, S_gross, config.geomParams, 'right');
            if (sigmaNet1 >= sigma_flow_nsy || sigmaNet2 >= sigma_flow_nsy) {
                failureMode = 'Net Section Yield (σ_net ≥ σ_flow)';
                failureSide = sigmaNet1 >= sigma_flow_nsy ? 'left' : 'right';
                logEntries.push(this._logEntryDual(N, c1, c2, K1, K2, 0, 0, 0, beta1, beta2, 'NSY'));
                break;
            }

            // Growth rates
            const res1 = NasgroEquation.growthRate(K1, R, mat, Kc);
            const res2 = NasgroEquation.growthRate(K2, R, mat, Kc);

            // If both below threshold, no growth
            if (res1.dadN <= 0 && res2.dadN <= 0) {
                failureMode = 'Below Threshold (No Growth)';
                logEntries.push(this._logEntryDual(N, c1, c2, K1, K2, res1.dK, 0, 0, beta1, beta2, 'THRESHOLD'));
                break;
            }

            // Adaptive step size based on most critical tip
            const delta_a = this._adaptiveStep(Kmax, Kc,
                Math.max(c1, c2), Math.min(c1Max, c2Max));

            // Cycle increment: use the faster-growing tip to set ΔN
            const maxDadN = Math.max(res1.dadN, res2.dadN, 1e-20);
            const delta_N = delta_a / maxDadN;

            // Advance each crack independently
            const dc1 = res1.dadN > 0 ? res1.dadN * delta_N : 0;
            const dc2 = res2.dadN > 0 ? res2.dadN * delta_N : 0;

            // Log at intervals
            if (step === 0 || step % 50 === 0) {
                logEntries.push(this._logEntryDual(N, c1, c2, K1, K2,
                    res1.dK, res1.dadN, res2.dadN, beta1, beta2));
            }

            c1 += dc1;
            c2 += dc2;
            N += delta_N;
            step++;

            // Store data
            data.N.push(N);
            data.c1.push(c1);
            data.c2.push(c2);
            data.a.push(Math.max(c1, c2));
            data.twoA.push(2 * Math.max(c1, c2));
            data.Kmax.push(Kmax);
            data.Kmax1.push(K1);
            data.Kmax2.push(K2);
            data.dK.push(Math.max(res1.dK, res2.dK));
            data.dadN.push(maxDadN);
            data.beta1.push(beta1);
            data.beta2.push(beta2);

            if (N >= maxCycles) { failureMode = 'Max Cycles Reached'; break; }
        }

        if (step >= maxSteps && failureMode === 'Running') {
            failureMode = 'Max Steps Reached';
        }

        // Final log entry
        const fK1 = geom.getK(c1, sigmaMax, config.geomParams, 'left');
        const fK2 = geom.getK(c2, sigmaMax, config.geomParams, 'right');
        const fb1 = geom.getBeta(c1, config.geomParams, 'left');
        const fb2 = geom.getBeta(c2, config.geomParams, 'right');
        logEntries.push(this._logEntryDual(N, c1, c2,
            Math.max(fK1, 0), Math.max(fK2, 0), 0, 0, 0,
            Math.max(fb1, 0), Math.max(fb2, 0), 'END'));

        return {
            failureMode,
            failureSide,
            finalCrack: Math.max(c1, c2),
            finalC1: c1,
            finalC2: c2,
            finalTwoA: 2 * Math.max(c1, c2),
            totalCycles: N,
            totalSteps: step,
            Kc,
            data,
            logEntries,
            isDual: true
        };
    },

    // ── Edge-crack phase (post-link-up continuation) ─────────

    /**
     * Continue crack growth after RHS link-up, using SENT beta factors.
     * Called from _runDual when c₂ reaches the right plate edge.
     *
     * The surviving left crack c₁ continues to grow. The total edge crack
     * length is a_edge = c₁ + D + right_ligament, measured from the right
     * plate edge inward.
     */
    _runEdgeCrackPhase(config, geom, c1_start, N_start, step_start, data, logEntries, Kc) {
        const mat = config.material;
        const R = config.R;
        const sigmaMax = config.sigmaMax;

        const maxCycles = config.maxCycles || 1e7;
        const maxSteps = config.maxSteps || 50000;
        const transitionCycle = N_start;
        const S3 = config.geomParams.S3 || 0;

        // Freeze c2 at the right ligament width (for data continuity)
        const R_hole = config.geomParams.D / 2;
        const e0 = config.geomParams.e0 || 0;
        const c2_frozen = config.geomParams.W / 2 - e0 - R_hole;

        let c1 = c1_start;
        let aEdge = geom.getEdgeCrackLength(c1, config.geomParams);
        const aEdgeMax = geom.getMaxCrackEdge(config.geomParams);

        let N = N_start;
        let step = step_start;
        let failureMode = 'Running';

        // ─── DEBUG: Log SENT phase stress breakdown ───
        const S3_DW = S3 > 0 ? (config.geomParams.D / config.geomParams.W) * S3 : 0;
        console.log('═══ SENT Phase Entry ═══');
        console.log(`  S₀ (bypass):        ${sigmaMax.toFixed(3)} ksi`);
        console.log(`  S₃ (bearing):       ${S3.toFixed(3)} ksi`);
        console.log(`  D/W:                ${(config.geomParams.D / config.geomParams.W).toFixed(5)}`);
        console.log(`  S₃·D/W:            ${S3_DW.toFixed(3)} ksi`);
        console.log(`  S_gross = S₀+S₃D/W: ${(sigmaMax + S3_DW).toFixed(3)} ksi`);
        console.log(`  a_edge₀:            ${aEdge.toFixed(5)} in`);
        console.log('════════════════════════');

        while (step < maxSteps) {
            if (aEdge >= aEdgeMax) { failureMode = 'Geometry Limit (SENT a/W)'; break; }

            // Combined K (tension + bending + bearing) for SENT phase
            const useEdgeTotal = (S3 > 0 || (config.geomParams.S2 || 0) !== 0) && geom.getKEdge_total;
            const calcKEdge = (a) => {
                return useEdgeTotal
                    ? geom.getKEdge_total(a, sigmaMax, S3, config.geomParams)
                    : geom.getKEdge(a, sigmaMax, config.geomParams);
            };

            let Kmax = calcKEdge(aEdge);

            // Irwin plastic zone correction (2 iterations)
            const sigma_flow = (mat.Yield + mat.UTS) / 2.0;
            const alpha_pz = mat.alpha || 1.5;
            const pzFactor = 1.0 / (2.0 * alpha_pz * Math.PI);
            for (let pzIter = 0; pzIter < 2; pzIter++) {
                const ry = (Kmax > 0) ? pzFactor * Math.pow(Kmax / sigma_flow, 2) : 0;
                const K_corr = calcKEdge(aEdge + ry);
                if (K_corr > 0) Kmax = K_corr;  // Only accept if geometry valid
            }
            // ─── DEBUG: Log first few SENT steps ───
            if (step - step_start < 3) {
                const S_eff = sigmaMax + (S3 > 0 ? (config.geomParams.D / config.geomParams.W) * S3 : 0);
                const K_pure = geom.getKEdge(aEdge, sigmaMax, config.geomParams);
                console.log(`  SENT step ${step}: a_edge=${aEdge.toFixed(5)}, K_total=${Kmax.toFixed(3)}, K_pure(S0 only)=${K_pure.toFixed(3)}, S_eff=${S_eff.toFixed(3)}`);
            }
            if (Kmax < 0) { failureMode = 'Geometry Limit (SENT)'; break; }
            const betaEdge = geom.getBetaEdge(aEdge, config.geomParams);

            if (Kmax >= Kc) {
                failureMode = 'TC23 → SENT: Fracture (K ≥ Kc)';
                logEntries.push(this._logEntry(N, aEdge, Kmax, 0, 0, betaEdge, 'FRACTURE'));
                break;
            }

            // Net section yield — uses flow stress and gross stress
            const sigma_flow_nsy = (mat.Yield + mat.UTS) / 2.0;
            const S_gross = sigmaMax + (S3 > 0 ? (config.geomParams.D / config.geomParams.W) * S3 : 0);
            const sigmaNet = geom.getNetSectionStressEdge(aEdge, S_gross, config.geomParams);
            if (sigmaNet >= sigma_flow_nsy) {
                failureMode = 'TC23 → SENT: Net Section Yield (σ_net ≥ σ_flow)';
                logEntries.push(this._logEntry(N, aEdge, Kmax, 0, 0, betaEdge, 'NSY'));
                break;
            }

            const result = NasgroEquation.growthRate(Kmax, R, mat, Kc);
            if (result.dadN <= 0) {
                failureMode = 'TC23 → SENT: Below Threshold';
                logEntries.push(this._logEntry(N, aEdge, Kmax, result.dK, 0, betaEdge, 'THRESHOLD'));
                break;
            }

            const delta_a = this._adaptiveStep(Kmax, Kc, aEdge, aEdgeMax);
            const delta_N = delta_a / result.dadN;

            if ((step - step_start) === 0 || (step - step_start) % 50 === 0) {
                logEntries.push(this._logEntry(N, aEdge, Kmax, result.dK, result.dadN, betaEdge, 'SENT'));
            }

            c1 += delta_a;  // left crack grows
            aEdge = geom.getEdgeCrackLength(c1, config.geomParams);
            N += delta_N;
            step++;

            // Append to data arrays (c2 frozen, c1 growing)
            data.N.push(N);
            data.c1.push(c1);
            data.c2.push(c2_frozen);
            data.a.push(aEdge);
            data.twoA.push(2 * aEdge);
            data.Kmax.push(Kmax);
            data.Kmax1.push(Kmax);
            data.Kmax2.push(0);
            data.dK.push(result.dK);
            data.dadN.push(result.dadN);
            data.beta1.push(betaEdge);
            data.beta2.push(0);

            if (N >= maxCycles) { failureMode = 'Max Cycles Reached'; break; }
        }

        if (step >= maxSteps && failureMode === 'Running') {
            failureMode = 'Max Steps Reached';
        }

        // Final log entry
        const fK = geom.getKEdge(aEdge, sigmaMax, config.geomParams);
        const fBeta = geom.getBetaEdge(aEdge, config.geomParams);
        logEntries.push(this._logEntry(N, aEdge, Math.max(fK, 0), 0, 0, Math.max(fBeta, 0), 'END'));

        return {
            failureMode,
            failureSide: 'right',
            finalCrack: aEdge,
            finalC1: c1,
            finalC2: c2_frozen,
            finalTwoA: 2 * aEdge,
            totalCycles: N,
            totalSteps: step,
            Kc,
            data,
            logEntries,
            isDual: true,
            hasTransition: true,
            transitionCycle: transitionCycle
        };
    },

    // ── Helpers ───────────────────────────────────────────────

    /**
     * Adaptive step sizing based on proximity to instability.
     */
    _adaptiveStep(Kmax, Kc, a, aMax) {
        const fracMargin = 1.0 - Kmax / Kc;
        let delta_a;

        if (fracMargin < 0.05) {
            delta_a = 0.0005;
        } else if (fracMargin < 0.15) {
            delta_a = 0.001;
        } else if (fracMargin < 0.3) {
            delta_a = 0.002;
        } else {
            delta_a = 0.005;
        }

        if (a + delta_a > aMax) {
            delta_a = aMax - a;
        }
        return Math.max(delta_a, 1e-8);
    },

    /**
     * Create a log entry for single-crack geometries.
     */
    _logEntry(N, a, Kmax, dK, dadN, beta, tag) {
        return {
            N: Math.round(N),
            a: a.toFixed(5),
            twoA: (2 * a).toFixed(5),
            Kmax: Kmax.toFixed(3),
            dK: dK.toFixed(3),
            dadN: dadN > 0 ? dadN.toExponential(3) : '0',
            beta: beta.toFixed(4),
            tag: tag || '',
            isDual: false
        };
    },

    /**
     * Create a log entry for dual-crack geometries.
     */
    _logEntryDual(N, c1, c2, K1, K2, dK, dadN1, dadN2, beta1, beta2, tag) {
        return {
            N: Math.round(N),
            c1: c1.toFixed(5),
            c2: c2.toFixed(5),
            K1: K1.toFixed(3),
            K2: K2.toFixed(3),
            dK: dK.toFixed(3),
            dadN1: dadN1 > 0 ? dadN1.toExponential(3) : '0',
            dadN2: dadN2 > 0 ? dadN2.toExponential(3) : '0',
            beta1: beta1.toFixed(4),
            beta2: beta2.toFixed(4),
            tag: tag || '',
            isDual: true
        };
    }
};
