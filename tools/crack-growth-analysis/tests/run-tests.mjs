/**
 * run-tests.mjs — Headless verification harness for the crack-growth tool.
 *
 * Loads the browser scripts into a shared vm sandbox and runs verification
 * tests against the bridging math, TC23/TC23B geometries, and the engine.
 *
 * Run:  node tests/run-tests.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const sandbox = { console, Math, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const SCRIPTS = [
    'js/geometry/base.js',
    'js/geometry/tc01.js',
    'js/geometry/tc05-data.js',
    'js/geometry/tc23-phi1-table.js',
    'js/geometry/tc23.js',
    'js/geometry/bridging.js',
    'js/geometry/tc23b-fea-table.js',
    'js/geometry/tc23-bridged.js',
    'js/nasgro.js',
    'js/engine.js'
];
for (const rel of SCRIPTS) {
    const src = readFileSync(join(root, rel), 'utf8');
    vm.runInContext(src, sandbox, { filename: rel });
}

const { Bridging, getGeometry, CrackGrowthEngine } = vm.runInContext(
    '({ Bridging, getGeometry, CrackGrowthEngine })', sandbox);
const B = Bridging._internals;

// ── tiny test framework ─────────────────────────────────────
let passed = 0, failed = 0;
function check(name, cond, detail = '') {
    if (cond) { passed++; console.log(`  PASS  ${name}`); }
    else { failed++; console.log(`  FAIL  ${name}  ${detail}`); }
}
function approx(a, b, rtol = 1e-3) {
    return Math.abs(a - b) <= rtol * Math.max(Math.abs(a), Math.abs(b), 1e-30);
}

// ════════════════════════════════════════════════════════════
console.log('── Bridging math verification ──');

// T1: Westergaard crack-opening closed form: half-COD at crack center = 2σa/E
{
    const a = 2.0, E = 10300;
    const v0 = B.westergaardV0(0, 1e-12, a, E, 0.33);
    check('T1 V0(0,0) = 2a/E (half-COD)', approx(v0, 2 * a / E, 1e-6),
        `got ${v0}, want ${2 * a / E}`);
    // and decays to zero far away
    // 1/y decay: at y = 200a the opening is ~a/(2·200)·(2+(1+ν))/2 of centre value
    const vFar = B.westergaardV0(0, 200 * a, a, E, 0.33);
    check('T1b V0 → 0 far from crack (1/y decay)', Math.abs(vFar) < 5e-3 * v0, `got ${vFar}`);
}

// T2: Kelvin pair σ_yy equilibrium: ∫σ_yy(x,0) dx = −1/t
// (upper half-plane contains the −y force of a unit restraining pair)
{
    const t = 0.05, b = 0.7, kappa = (3 - 0.33) / 1.33;
    let I = 0;
    const L = 4000, n = 800000;            // wide domain, fine trapezoid
    const h = 2 * L / n;
    for (let i = 0; i <= n; i++) {
        const x = -L + i * h;
        const w = (i === 0 || i === n) ? 0.5 : 1.0;
        I += w * B.pairSigYY(x, [0], b, t, kappa) * h;
    }
    check('T2 ∫σ_yy^pair dx = −1/t (equilibrium)', approx(I, -1 / t, 2e-3),
        `got ${I}, want ${-1 / t}`);
    // compression between a squeezing pair
    const s0 = B.pairSigYY(0, [0], b, t, kappa);
    check('T2b restraining pair → compressive σ_yy at origin', s0 < 0, `got ${s0}`);
}

// T3: K Green's function wedge-force limit: b → 0 ⇒ K → −1/(t√(πa))
{
    const a = 2.0, t = 0.05, kappa = (3 - 0.33) / 1.33;
    const Kexact = -1 / (t * Math.sqrt(Math.PI * a));
    const Kb = (b, n) => B.pairKs(a, [0], b, t, kappa, n).Kp;
    // Richardson extrapolation in b (K(b) analytic in b near 0)
    const K1 = Kb(0.16 * a, 4096), K2 = Kb(0.08 * a, 8192), K3 = Kb(0.04 * a, 16384);
    const Kext = K3 + (K3 - K2) + (K3 - 2 * K2 + K1) / 1; // quadratic extrap h→0 (h halving)
    check('T3 K(b→0) → −1/(t√(πa)) (wedge limit)', approx(Kext, Kexact, 0.02),
        `extrapolated ${Kext}, want ${Kexact} (K at b/a=0.04: ${K3})`);
    // both tips identical for centered pair
    const ks = B.pairKs(a, [0], 0.5, t, kappa, 2048);
    check('T3b K+ = K− for centered pair', approx(ks.Kp, ks.Km, 1e-10));
    // restraint must reduce K
    check('T3c restraining pair gives K < 0', ks.Kp < 0, `got ${ks.Kp}`);
}

// T4: Kelvin displacement consistency: ∂v/∂y = ε_yy = (σ_yy − ν σ_xx)/E
{
    const E = 10300, nu = 0.33, kappa = (3 - nu) / (1 + nu), G = E / (2 * (1 + nu));
    const t = 0.05;
    const [x0, y0, fx, fy] = [0.3, 1.1, 0, -1 / t];
    const [xf, yf] = [1.7, 2.4];
    const dh = 1e-5;
    const dvdy = (B.kelvinV(xf, yf + dh, x0, y0, fx, fy, kappa, G)
        - B.kelvinV(xf, yf - dh, x0, y0, fx, fy, kappa, G)) / (2 * dh);
    const eyy = (B.kelvinSigYY(xf, yf, x0, y0, fx, fy, kappa)
        - nu * B.kelvinSigXX(xf, yf, x0, y0, fx, fy, kappa)) / E;
    check('T4 Kelvin ∂v/∂y = (σ_yy − νσ_xx)/E', approx(dvdy, eyy, 1e-5),
        `dv/dy ${dvdy}, εyy ${eyy}`);
}

// T5: independent cross-check of the Betti machinery:
// crack-extra displacement at a fastener point under remote σ via
//   (a) closed-form Westergaard V0, and
//   (b) −(t1/E1)·∫ √(πa′)·(K₊+K₋) da′  with K from Kelvin stresses
{
    const E = 10300, nu = 0.33, kappa = (3 - nu) / (1 + nu), t = 0.05;
    const a = 2.0, yF = 1.0;
    const closed = B.westergaardV0(0, yF, a, E, nu);
    const M = 600;
    let I = 0;
    let prev = 0;
    for (let m = 1; m <= M; m++) {
        const aP = m * a / M;
        const ks = B.pairKs(aP, [0], yF, t, kappa, 512);
        const g = Math.sqrt(Math.PI * aP) * (ks.Kp + ks.Km);
        I += 0.5 * (prev + g) * (a / M);
        prev = g;
    }
    const betti = -(t / E) * I;
    check('T5 V0 closed form ≡ Betti K-integral', approx(closed, betti, 5e-3),
        `closed ${closed}, betti ${betti}`);
}

// T6/T7/T8: model assembly, symmetry, flexibility, solve behaviour
{
    const f = Bridging.modTateRosenfeld(0.1875, 0.063, 10300, 0.05, 10300, 10300, 0.33);
    // hand evaluation of the modified Tate & Rosenfeld equation
    const hand = 0.375 / (10300 * 0.063) + 0.375 / (10300 * 0.05)
        + 0.9 / (10300 * 0.063) + 0.9 / (10300 * 0.05)
        + 32 * 1.33 * (0.063 + 0.05) / (9 * 10300 * Math.PI * 0.1875 ** 2)
        + 8 * (0.063 ** 3 + 5 * 0.063 ** 2 * 0.05 + 5 * 0.063 * 0.05 ** 2 + 0.05 ** 3)
        / (5 * 10300 * Math.PI * 0.1875 ** 4);
    check('T7 modified Tate & Rosenfeld value', approx(f, hand, 1e-12), `got ${f}`);

    const cfg = {
        aMax: 6.0, x0: 0, mirror: false, pitch: 1.0, nFast: 10,
        t1: 0.063, E1: 10300, nu1: 0.33,
        t2: 0.05, E2: 10300, nu2: 0.33,
        f, d: 0.1875, M: 240
    };
    const model = Bridging.buildModel(cfg);

    // T6: compatibility matrix symmetry (Betti reciprocity)
    {
        const a = 2.0, N = cfg.nFast;
        // re-assemble A as solveAt does
        let maxAsym = 0;
        for (let i = 0; i < N; i++) {
            for (let j = 0; j < i; j++) {
                const Sij = model.S[i][j];
                const gij = -model.vStrK[i][j] - model.vSkK[i][j]
                    + (cfg.t1 / cfg.E1) * Sij[Math.round(a / cfg.aMax * model.M)];
                const gji = -model.vStrK[j][i] - model.vSkK[j][i]
                    + (cfg.t1 / cfg.E1) * Sij[Math.round(a / cfg.aMax * model.M)];
                maxAsym = Math.max(maxAsym, Math.abs(gij - gji) /
                    Math.max(Math.abs(gij), 1e-30));
            }
        }
        check('T6 influence matrix symmetric (Betti)', maxAsym < 1e-6,
            `max rel asymmetry ${maxAsym}`);
    }

    // T8: solve behaviour
    const sol = Bridging.solveAt(model, 2.0);
    check('T8a restraint ratio 0 < R < 1', sol.R > 0 && sol.R < 1, `R = ${sol.R}`);
    check('T8b fastener loads positive', sol.F.every(v => v > 0),
        `F = [${Array.from(sol.F).map(v => v.toFixed(4))}]`);
    check('T8c nearest fastener carries most load',
        sol.F[0] === Math.max(...sol.F),
        `F = [${Array.from(sol.F).map(v => v.toFixed(4))}]`);

    // restraint deepens with crack length
    const solBig = Bridging.solveAt(model, 4.0);
    check('T8d more restraint at longer crack', solBig.R < sol.R,
        `R(2)=${sol.R}, R(4)=${solBig.R}`);

    // very flexible fasteners → no restraint
    const modelSoft = Bridging.buildModel({ ...cfg, f: 1e9 });
    const solSoft = Bridging.solveAt(modelSoft, 2.0);
    check('T8e f→∞ ⇒ R→1', solSoft.R > 0.999, `R = ${solSoft.R}`);

    // stiffer skin → more restraint
    const modelStiff = Bridging.buildModel({ ...cfg, t2: 0.2 });
    const solStiff = Bridging.solveAt(modelStiff, 2.0);
    check('T8f thicker skin ⇒ more restraint', solStiff.R < sol.R,
        `R = ${solStiff.R} vs ${sol.R}`);

    console.log(`  info: R(a=2in) = ${sol.R.toFixed(4)}, ` +
        `F = [${Array.from(sol.F).slice(0, 4).map(v => v.toFixed(4))} ...] kip/ksi`);
}

// ════════════════════════════════════════════════════════════
console.log('── TC23B geometry / engine integration ──');

const MAT = {
    name: '2024-T3', C: 8.0e-9, n: 3.2, p: 0.25, q: 1.0,
    DK1: 1.2, Cth_plus: 2.0, Cth_minus: 0.1, K1e: 50, K1c: 30,
    Ak: 1.0, Bk: 1.5, Yield: 53, UTS: 70,
    alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
};

function tc23bParams(extra = {}) {
    return {
        W: 4.0, t: 0.063, D: 0.25, m: 2.0,
        a0: 0.05, a0_2: 0.05, eta: 0,
        useBridge: 'yes',
        EStr: 10300, nuStr: 0.33,
        ESkin: 10300, tSkin: 0.05, nuSkin: 0.33,
        pFast: 1.0, DFast: 0.1875, EFast: 10300, nuFast: 0.33,
        nFast: 10, FfAllow: 0,
        skinStress: 'match', sigL: 0, sigH: 0, _sigmaMax: 18,
        S2: 0, S3: 0,
        ...extra
    };
}

{
    const tc23 = getGeometry('TC23');
    const tc23b = getGeometry('TC23B');

    // G1: bridging off ⇒ identical to plain TC23
    {
        const pOff = tc23bParams({ useBridge: 'no' });
        const pRef = { ...pOff };
        const b1 = tc23b.getBeta(0.3, pOff, 'right');
        const b0 = tc23.getBeta(0.3, pRef, 'right');
        check('G1 bridging off ⇒ β = TC23 β', approx(b1, b0, 1e-12),
            `${b1} vs ${b0}`);
    }

    // G2: bridging on ⇒ β unchanged (pure geometry), K reduced (bypass on stress)
    {
        const p = tc23bParams();
        const b1 = tc23b.getBeta(0.3, p, 'right');
        const b0 = tc23.getBeta(0.3, { ...p }, 'right');
        check('G2a β is the pure geometry factor (unchanged by bridging)',
            approx(b1, b0, 1e-12), `${b1} vs ${b0}`);
        p._c1 = 0.3; p._c2 = 0.3;
        const k1 = tc23b.getK(0.3, 18, p, 'right');
        const k0 = tc23.getK(0.3, 18, { ...p }, 'right');
        check('G2b bridging reduces K', k1 < k0 && k1 > 0, `${k1} vs ${k0}`);
    }

    // G3: SENT-phase K also reduced; βEdge stays geometry
    {
        const p = tc23bParams();
        const aE = 2.5;
        const b1 = tc23b.getBetaEdge(aE, p);
        const b0 = tc23.getBetaEdge(aE, { ...p });
        check('G3a SENT βEdge is pure geometry (unchanged)', approx(b1, b0, 1e-12),
            `${b1} vs ${b0}`);
        const k1 = tc23b.getKEdge(aE, 18, p);
        const k0 = tc23.getKEdge(aE, 18, { ...p });
        check('G3b SENT K reduced by bridging', k1 < k0 && k1 > 0, `${k1} vs ${k0}`);
    }

    // G4: full engine run — bridged life exceeds unbridged life
    {
        const mkCfg = (geomId, params) => ({
            geometryId: geomId, geomParams: params,
            a0: params.a0, a0_2: params.a0_2,
            sigmaMax: 18, R: 0.05, material: MAT,
            maxCycles: 5e6, usePzc: true
        });
        const resB = CrackGrowthEngine.run(mkCfg('TC23B', tc23bParams()));
        const resU = CrackGrowthEngine.run(mkCfg('TC23', tc23bParams({ useBridge: 'no' })));
        check('G4 bridged life > unbridged life',
            resB.totalCycles > 1.05 * resU.totalCycles,
            `bridged ${Math.round(resB.totalCycles)}, unbridged ${Math.round(resU.totalCycles)}`);
        console.log(`  info: life unbridged ${Math.round(resU.totalCycles).toLocaleString()} → ` +
            `bridged ${Math.round(resB.totalCycles).toLocaleString()} cycles ` +
            `(${resB.failureMode} / ${resU.failureMode})`);

        // tighter pitch + thicker skin → much stronger retardation
        const strong = tc23bParams({ pFast: 0.5, tSkin: 0.09 });
        const resS = CrackGrowthEngine.run(mkCfg('TC23B', strong));
        check('G4b stronger bridging ⇒ longer life than mild bridging',
            resS.totalCycles > resB.totalCycles,
            `strong ${Math.round(resS.totalCycles)}, mild ${Math.round(resB.totalCycles)}`);
        console.log(`  info: strong-bridging life ${Math.round(resS.totalCycles).toLocaleString()} cycles ` +
            `(${(resS.totalCycles / resU.totalCycles).toFixed(2)}× unbridged)`);

        // G5: fastener load reporting
        const st = tc23b.getFastenerState(tc23bParams(),
            { c1: resB.finalC1, c2: resB.finalC2 }, 18);
        check('G5 fastener loads reported, positive',
            st && st.F.length > 0 && st.F[0] > 0,
            st ? `F1=${st.F[0]}` : 'null');
        if (st) {
            console.log(`  info: peak fastener load at final crack = ` +
                `${st.maxF.toFixed(3)} kip (R = ${st.R.toFixed(3)})`);
        }
    }
}

// ════════════════════════════════════════════════════════════
console.log('── Biaxial skin stress (Poisson mismatch) ──');
{
    const tc23b = getGeometry('TC23B');
    const c = 0.4;

    // β is the pure geometry factor for ALL skin-stress modes now; the mode
    // manifests in the bypass factor (S_bypass/S₀), so these tests probe that.
    const byp = (p) => { p._c1 = c; p._c2 = c; return tc23b.getBypassFactor(c, p, 'right'); };

    // B1: equivalence — biaxial inputs chosen to strain-match the stringer
    // (σ_L = σ̂·E_skin/E_str, σ_H = 0) must reproduce 'match' mode exactly
    {
        const r0 = byp(tc23bParams());
        const r1 = byp(tc23bParams({ skinStress: 'biaxial', sigL: 18, sigH: 0 }));
        check('B1 strain-matched biaxial ≡ match mode', approx(r0, r1, 1e-9),
            `${r0} vs ${r1}`);
    }

    // B2: under the LOAD-BYPASS model the far-field strain mismatch is a global
    // load-share already represented in the input stringer stress; with the
    // no-crack baseline removed it has only a small second-order effect on the
    // crack-DRIVEN bypass (it is NOT a crack-bridging action). Verify the effect
    // is bounded/small rather than the dominant driver it appeared to be before
    // the baseline-subtraction fix.
    {
        const r0 = byp(tc23bParams());
        const r1 = byp(tc23bParams({ skinStress: 'biaxial', sigL: 18, sigH: 12 }));
        check('B2 biaxial mismatch is a small effect on crack bypass (≤5%)',
            Math.abs(r1 - r0) / r0 < 0.05, `match R=${r0.toFixed(4)}, hoop R=${r1.toFixed(4)}`);
        console.log(`  info: bypass factor at a_eff=${(c + 0.25 / 2 + c / 2).toFixed(2)}: ` +
            `match ${r0.toFixed(4)} → hoop ${r1.toFixed(4)} (mismatch ≈ global load-share, not bypass)`);
    }

    // B5: 'hoop' mode ≡ 'biaxial' with the strain-matched σ_L entered
    {
        const r1 = byp(tc23bParams({ skinStress: 'hoop', sigH: 12 }));
        const r2 = byp(tc23bParams({ skinStress: 'biaxial', sigL: 18, sigH: 12 }));
        check('B5 hoop mode ≡ biaxial with matched σ_L', approx(r1, r2, 1e-9),
            `${r1} vs ${r2}`);
    }

    // B6: 'hoop' mode with σ_H = 0 ≡ match mode
    {
        const pHoop = tc23bParams({ skinStress: 'hoop', sigH: 0 });
        const pMatch = tc23bParams();
        const b1 = byp(pHoop);
        const b0 = byp(pMatch);
        check('B6 hoop mode with σ_H=0 ≡ match', approx(b1, b0, 1e-12),
            `${b1} vs ${b0}`);
    }

    // B3: no-crack baseline correctly removed — at a tiny crack any skin-stress
    // mode gives bypass ≈ 1 (no crack ⇒ no crack-driven bypass), NOT the floor.
    // This is the regression guard for the strain-mismatch-conflation bug.
    {
        const tiny = { c1: 0.02, c2: 0.02 };
        for (const mode of [
            tc23bParams({ skinStress: 'biaxial', sigL: 0, sigH: 0 }),   // "doubler"
            tc23bParams({ skinStress: 'biaxial', sigL: 18, sigH: 12 }), // hoop
            tc23bParams({ skinStress: 'biaxial', sigL: 36, sigH: 0 })]) { // attraction
            const st = tc23b.getFastenerState(mode, tiny, 18);
            check(`B3 no-crack bypass ≈ 1 (σL=${mode.sigL},σH=${mode.sigH})`,
                st.R > 0.9, `R=${st.R.toFixed(4)}`);
        }
    }

    // B4: full engine run — biaxial life is close to match life (the mismatch
    // does not dominate via the bypass route; difference within ~10%).
    {
        const mkCfg = (params) => ({
            geometryId: 'TC23B', geomParams: params,
            a0: params.a0, a0_2: params.a0_2,
            sigmaMax: 18, R: 0.05, material: MAT,
            maxCycles: 5e6, usePzc: true
        });
        const resM = CrackGrowthEngine.run(mkCfg(tc23bParams()));
        const resH = CrackGrowthEngine.run(mkCfg(
            tc23bParams({ skinStress: 'biaxial', sigL: 18, sigH: 12 })));
        check('B4 biaxial life ≈ match life (bypass route, within 10%)',
            Math.abs(resH.totalCycles - resM.totalCycles) < 0.1 * resM.totalCycles,
            `match ${Math.round(resM.totalCycles)}, hoop ${Math.round(resH.totalCycles)}`);
        console.log(`  info: life strain-matched ${Math.round(resM.totalCycles).toLocaleString()} → ` +
            `hoop-biaxial ${Math.round(resH.totalCycles).toLocaleString()} cycles ` +
            `(mismatch ≈ global load-share, already in input stress)`);
    }
}

// ════════════════════════════════════════════════════════════
console.log('── Load-bypass K reduction ──');
{
    const tc23b = getGeometry('TC23B');
    const c = 0.4;

    // Y1: bypass factor exactly = 1 − ΣF_unit/(W·t) from the reported state
    {
        const p = tc23bParams();
        const st = tc23b.getFastenerState(p, { c1: c, c2: c }, 18);
        const sumF = st.F.reduce((s, v) => s + v, 0);          // actual kip
        const Papplied = 18 * p.W * p.t;
        const expectR = 1 - sumF / Papplied;
        check('Y1 bypass factor = 1 − P_total/P_applied',
            approx(st.R, expectR, 1e-9) && approx(st.Ptot, sumF, 1e-9),
            `R=${st.R.toFixed(4)} vs ${expectR.toFixed(4)}, Ptot=${st.Ptot.toFixed(4)} vs ${sumF.toFixed(4)}`);
        check('Y1b S_bypass = R·S_gross', approx(st.Sbypass, 18 * st.R, 1e-9),
            `${st.Sbypass} vs ${18 * st.R}`);
    }

    // Y2: bypass factor is stress-independent, and getK = β_geom·S_bypass·√(πc)
    {
        const p = tc23bParams();
        p._c1 = c; p._c2 = c;                       // pin both tips to the same state
        const st18 = tc23b.getFastenerState(p, { c1: c, c2: c }, 18);
        const st50 = tc23b.getFastenerState(p, { c1: c, c2: c }, 50);
        check('Y2 bypass factor stress-independent', approx(st18.R, st50.R, 1e-9),
            `R(18)=${st18.R}, R(50)=${st50.R}`);
        // β stays the pure geometry factor; the bypass shows up in K (on stress)
        const bGeom = getGeometry('TC23').getBeta(c, { ...p }, 'right');
        const bBridged = tc23b.getBeta(c, p, 'right');
        check('Y2b β unchanged by bridging (pure geometry)',
            approx(bGeom, bBridged, 1e-12), `${bBridged} vs ${bGeom}`);
        const k = tc23b.getK(c, 18, p, 'right');
        check('Y2c getK = β_geom · (R·S₀) · √(πc)',
            approx(k, bGeom * st18.R * 18 * Math.sqrt(Math.PI * c), 2e-3),
            `${k} vs ${bGeom * st18.R * 18 * Math.sqrt(Math.PI * c)}`);
    }

    // Y3: bypass scales ONLY the membrane term — bearing K is untouched
    {
        const p = tc23bParams({ S3: 20 });
        p._c1 = c; p._c2 = c;
        const Rb = tc23b.getBypassFactor(c, p, 'right');
        // K_total via bridged (tension reduced, bearing not)
        const Kb = tc23b.getK_total(c, 18, 20, p, 'right');
        // hand reconstruction: plain TC23 minus (1−Rb)·tension
        const tc23 = getGeometry('TC23');
        const Kfull = tc23.getK_total(c, 18, 20, { ...p }, 'right');
        const Ktension = tc23.getBeta(c, { ...p }, 'right') * 18 * Math.sqrt(Math.PI * c);
        const expect = Kfull - (1 - Rb) * Ktension;
        check('Y3 bypass reduces membrane only (bearing K intact)',
            approx(Kb, expect, 1e-9), `${Kb} vs ${expect}`);
        // sanity: bearing present ⇒ bridged total K strictly between
        // full-reduction and no-reduction
        check('Y3b membrane-only < full-K reduction', Kb > Kfull * Rb,
            `Kb=${Kb.toFixed(3)}, full×Rb=${(Kfull * Rb).toFixed(3)}`);
    }

    // Y4: for S2=S3=0, getK_total ≡ getK (whole K is membrane, both bridged)
    {
        const p = tc23bParams();
        p._c1 = c; p._c2 = c;
        const Kt = tc23b.getK_total(c, 18, 0, p, 'right');
        const Kk = tc23b.getK(c, 18, p, 'right');
        check('Y4 S2=S3=0: getK_total ≡ getK (both bridged)', approx(Kt, Kk, 1e-9),
            `${Kt} vs ${Kk}`);
    }

    // Y5: more crack opening ⇒ more transfer ⇒ lower bypass factor
    {
        const p = tc23bParams();
        const rSmall = tc23b.getFastenerState(p, { c1: 0.1, c2: 0.1 }, 18).R;
        const rBig = tc23b.getFastenerState(p, { c1: 0.8, c2: 0.8 }, 18).R;
        check('Y5 bypass factor decreases with crack length', rBig < rSmall,
            `R(0.1)=${rSmall.toFixed(4)}, R(0.8)=${rBig.toFixed(4)}`);
    }
}

// ════════════════════════════════════════════════════════════
console.log('── Hybrid bearing beta (TC05 FEM → TC23) ──');
{
    const tc23 = getGeometry('TC23');
    const { interpolateTable, TC05_DATA } = vm.runInContext(
        '({ interpolateTable, TC05_DATA })', sandbox);
    const params = {
        W: 2.0, t: 0.05, D: 0.2, m: 0.4,
        a0: 0.01, a0_2: 0.05, eta: 0, S2: 0, S3: 15
    };
    params._c1 = 0.01; params._c2 = 0.05;

    // H1: default model unchanged (regression vs NASGRO Solution C)
    {
        const bpDefault = tc23.getBearingBeta(0.05, params, 'right');
        const bpNasgro = (params.D / params.W) * tc23.getBetaC(0.05, params, 'right');
        check('H1 default bearing = NASGRO Solution C', approx(bpDefault, bpNasgro, 1e-12),
            `${bpDefault} vs ${bpNasgro}`);
    }

    // H2: hybrid equals TC05 table below c = D, equals TC23 above c = 2D
    {
        const pH = { ...params, bearingModel: 'hybrid05' };
        const c = 0.05;                       // c/D = 0.25 < 1
        const bp = tc23.getBearingBeta(c, pH, 'right');
        const bp05 = interpolateTable(TC05_DATA.C7, c / (pH.W - pH.D), pH.D / pH.W);
        check('H2a hybrid = TC05 FEM beta below c = 0.5D', approx(bp, bp05, 1e-12),
            `${bp} vs ${bp05}`);

        const cL = 0.45;                      // c/D = 2.25 > 2
        pH._c1 = 0.2; pH._c2 = cL;
        const bpL = tc23.getBearingBeta(cL, pH, 'right');
        params._c1 = 0.2; params._c2 = cL;
        const bp23 = (params.D / params.W) * tc23.getBetaC(cL, params, 'right');
        check('H2b hybrid = TC23 Solution C above c = D', approx(bpL, bp23, 1e-12),
            `${bpL} vs ${bp23}`);
        params._c1 = 0.01; params._c2 = 0.05;
    }

    // H3: continuity through the transition band (no jumps)
    // (left tip — its 1.5 in ligament keeps the sweep inside valid geometry)
    {
        const pH = { ...params, bearingModel: 'hybrid05' };
        let prev = null, maxJump = 0;
        for (let c = 0.10; c <= 0.50; c += 0.005) {
            pH._c1 = c; pH._c2 = 0.05;
            const bp = tc23.getBearingBeta(c, pH, 'left');
            if (prev !== null) maxJump = Math.max(maxJump, Math.abs(bp - prev));
            prev = bp;
        }
        check('H3 hybrid bearing beta continuous through transition', maxJump < 0.05,
            `max step-to-step change ${maxJump.toFixed(4)}`);
    }

    // H4: benchmark case — hybrid life between NASGRO-bearing and no-bearing
    {
        const mkCfg = (mods) => ({
            geometryId: 'TC23',
            geomParams: { ...params, _c1: undefined, _c2: undefined, ...mods },
            a0: 0.01, a0_2: 0.05,
            sigmaMax: 15, R: 0, material: MAT,
            maxCycles: 1e7, usePzc: true
        });
        const resN = CrackGrowthEngine.run(mkCfg({}));
        const resH = CrackGrowthEngine.run(mkCfg({ bearingModel: 'hybrid05' }));
        const res0 = CrackGrowthEngine.run(mkCfg({ S3: 0 }));
        check('H4 hybrid life between NASGRO and no-bearing',
            resH.totalCycles > resN.totalCycles && resH.totalCycles < res0.totalCycles,
            `nasgro ${Math.round(resN.totalCycles)}, hybrid ${Math.round(resH.totalCycles)}, ` +
            `none ${Math.round(res0.totalCycles)}`);
        console.log(`  info: benchmark case lives — NASGRO bearing ${Math.round(resN.totalCycles).toLocaleString()}, ` +
            `hybrid ${Math.round(resH.totalCycles).toLocaleString()}, no bearing ${Math.round(res0.totalCycles).toLocaleString()} ` +
            `(benchmark code: 7,594)`);
    }
}

// H5: effective-width bearing model
{
    const tc23 = getGeometry('TC23');
    const p = {
        W: 2.0, t: 0.05, D: 0.2, m: 0.4,
        a0: 0.01, a0_2: 0.05, eta: 0, S2: 0, S3: 15,
        bearingModel: 'effwidth'
    };
    p._c1 = 0.01; p._c2 = 0.05;
    const bp = tc23.getBearingBeta(0.05, p, 'right');
    const expected = (p.D / Math.min(p.W, 7 * p.D)) * tc23.getBeta(0.05, p, 'right');
    check('H5a eff-width bp = (D/min(W,7D))·βA', approx(bp, expected, 1e-12),
        `${bp} vs ${expected}`);
    // benchmark case-1 first row: BP1 = 0.451, BP2 = 0.300
    const bp1 = tc23.getBearingBeta(0.01, p, 'left');
    check('H5b eff-width BP1 matches benchmark first row (±5%)',
        Math.abs(bp1 - 0.451) / 0.451 < 0.05, `got ${bp1.toFixed(3)}, bench 0.451`);
}

// ════════════════════════════════════════════════════════════
console.log('── Ligament-yield PZC + interval logging ──');
{
    const tc23 = getGeometry('TC23');
    const params = {
        W: 2.0, t: 0.05, D: 0.2, m: 0.4,
        a0: 0.01, a0_2: 0.05, eta: 0, S2: 0, S3: 15
    };

    // P1: ligament stress formula (right tip: σ·m/(m−R−c2))
    {
        const sLig = tc23.getLigamentStress(0.1, 16.5, params, 'right');
        const expect = 16.5 * 0.4 / (0.4 - 0.1 - 0.1);
        check('P1 TC23 ligament stress (right tip)', approx(sLig, expect, 1e-12),
            `${sLig} vs ${expect}`);
        const sLigL = tc23.getLigamentStress(0.1, 16.5, params, 'left');
        const expectL = 16.5 * 1.6 / (1.6 - 0.1 - 0.1);
        check('P1b TC23 ligament stress (left tip)', approx(sLigL, expectL, 1e-12),
            `${sLigL} vs ${expectL}`);
    }

    // P2: ligament-mode life between always-on and off
    {
        const mkCfg = (pzcMode) => ({
            geometryId: 'TC23', geomParams: { ...params },
            a0: 0.01, a0_2: 0.05,
            sigmaMax: 15, R: 0, material: MAT,
            maxCycles: 1e7, pzcMode
        });
        const resAlways = CrackGrowthEngine.run(mkCfg('always'));
        const resLig = CrackGrowthEngine.run(mkCfg('ligament'));
        const resOff = CrackGrowthEngine.run(mkCfg('off'));
        check('P2 ligament-mode life between always and off',
            resLig.totalCycles >= resAlways.totalCycles &&
            resLig.totalCycles <= resOff.totalCycles,
            `always ${Math.round(resAlways.totalCycles)}, ligament ${Math.round(resLig.totalCycles)}, ` +
            `off ${Math.round(resOff.totalCycles)}`);
        const pzcEntries = resLig.logEntries.filter(e => (e.tag || '').startsWith('PZC ON'));
        check('P2b ligament mode announces PZC activation', pzcEntries.length >= 1,
            `${pzcEntries.length} PZC ON entries`);
        console.log(`  info: lives — PZC always ${Math.round(resAlways.totalCycles).toLocaleString()}, ` +
            `ligament-triggered ${Math.round(resLig.totalCycles).toLocaleString()}, ` +
            `off ${Math.round(resOff.totalCycles).toLocaleString()}` +
            (pzcEntries.length ? `; first trigger at N=${pzcEntries[0].N.toLocaleString()}` : ''));

        // P3: usePzc back-compat still honoured
        const resCompat = CrackGrowthEngine.run({ ...mkCfg(undefined), pzcMode: undefined, usePzc: true });
        check('P3 usePzc=true ≡ pzcMode always',
            approx(resCompat.totalCycles, resAlways.totalCycles, 1e-12));
    }

    // L1: log entries at the requested cycle interval
    {
        const res = CrackGrowthEngine.run({
            geometryId: 'TC23', geomParams: { ...params },
            a0: 0.01, a0_2: 0.05,
            sigmaMax: 15, R: 0, material: MAT,
            maxCycles: 1e7, pzcMode: 'off', logEvery: 500
        });
        const Ns = res.logEntries.filter(e => !e.tag).map(e => e.N);
        let minGap = Infinity, maxGap = 0;
        for (let i = 1; i < Ns.length; i++) {
            const g = Ns[i] - Ns[i - 1];
            minGap = Math.min(minGap, g);
            maxGap = Math.max(maxGap, g);
        }
        check('L1 log interval respected (gaps ≈ logEvery)',
            Ns.length > 10 && minGap >= 0.9 * 500 && maxGap <= 3 * 500,
            `${Ns.length} entries, gaps ${Math.round(minGap)}…${Math.round(maxGap)}`);
    }
}

// ════════════════════════════════════════════════════════════
console.log('── FEA SENT restraint table (interpolation) ──');
{
    const { TC23B_FEA_SENT, interpSentRestraint, hasSentFeaTable } = vm.runInContext(
        '({ TC23B_FEA_SENT, interpSentRestraint, hasSentFeaTable })', sandbox);

    // empty table ⇒ no restraint, and hasSentFeaTable false
    check('F1 empty FEA table ⇒ R=1, not active',
        interpSentRestraint(0.3) === 1.0 && hasSentFeaTable() === false);

    // inject a synthetic ascending table and check interpolation + clamping
    TC23B_FEA_SENT.aOverW = [0.15, 0.35, 0.55, 0.75];
    TC23B_FEA_SENT.R = [0.91, 0.811, 0.78, 0.77];
    check('F2 exact node lookup', approx(interpSentRestraint(0.35), 0.811, 1e-12));
    check('F2b linear interpolation midpoint',
        approx(interpSentRestraint(0.25), (0.91 + 0.811) / 2, 1e-12));
    check('F2c clamp below range', interpSentRestraint(0.05) === 0.91);
    check('F2d clamp above range', interpSentRestraint(0.95) === 0.77);
    check('F2e table now active', hasSentFeaTable() === true);
    // reset so it doesn't leak into other tests
    TC23B_FEA_SENT.aOverW = [];
    TC23B_FEA_SENT.R = [];
}

// G6: drawDiagram smoke test with a stub 2D context
{
    const calls = [];
    const stub = new Proxy({}, {
        get(_, prop) {
            if (prop === 'canvas') return { width: 600, height: 320 };
            return (...args) => { calls.push(String(prop)); return stubObj; };
        },
        set() { return true; }
    });
    const stubObj = stub;
    try {
        const tc23b = getGeometry('TC23B');
        tc23b.drawDiagram(stub, tc23bParams(), { c1: 0.3, c2: 0.4 }, 600, 320);
        check('G6 drawDiagram smoke (no exceptions)', calls.length > 20,
            `${calls.length} ctx calls`);
    } catch (e) {
        check('G6 drawDiagram smoke (no exceptions)', false, e.message);
    }
}

// ════════════════════════════════════════════════════════════
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
