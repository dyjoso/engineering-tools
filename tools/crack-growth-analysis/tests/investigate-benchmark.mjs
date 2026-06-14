/**
 * investigate-benchmark.mjs — TC23 benchmark discrepancy investigation
 *
 * Benchmark case (external code V1.2.3): W=2, B(=m)=0.4, D=0.2, t=0.05,
 * a1=0.01, a2=0.05, Sy=15 (R=0), bearing S3=15, PZC on, 2024-T3 clad L-T.
 * Benchmark life: 7594 cycles to free edge (net section failure - ligament,
 * final A1=0.139, A2=0.250). Our result: ~4760 cycles.
 *
 * Run: node tests/investigate-benchmark.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { console, Math, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const rel of ['js/geometry/base.js', 'js/geometry/tc05-data.js',
    'js/geometry/tc23-phi1-table.js',
    'js/geometry/tc23.js', 'js/nasgro.js', 'js/engine.js']) {
    vm.runInContext(readFileSync(join(root, rel), 'utf8'), sandbox, { filename: rel });
}
const { getGeometry, CrackGrowthEngine, NasgroEquation } = vm.runInContext(
    '({ getGeometry, CrackGrowthEngine, NasgroEquation })', sandbox);

const MAT = {
    name: '2024-T3', C: 8.0e-9, n: 3.2, p: 0.25, q: 1.0,
    DK1: 1.2, Cth_plus: 2.0, Cth_minus: 0.1, K1e: 50, K1c: 30,
    Ak: 1.0, Bk: 1.5, Yield: 53, UTS: 70,
    alpha: 2.0, Smax_S0: 0.3, alpha_th: 2.0, Smax_S0_th: 0.3
};

const baseParams = () => ({
    W: 2.0, t: 0.05, D: 0.2, m: 0.4,
    a0: 0.01, a0_2: 0.05, eta: 0,
    S2: 0, S3: 15
});

function run(label, paramMods = {}, cfgMods = {}, matMods = {}) {
    const params = { ...baseParams(), ...paramMods };
    const mat = { ...MAT, ...matMods };
    const cfg = {
        geometryId: 'TC23', geomParams: params,
        a0: params.a0, a0_2: params.a0_2,
        sigmaMax: 15, R: 0, material: mat,
        maxCycles: 1e7, usePzc: true, ...cfgMods
    };
    const res = CrackGrowthEngine.run(cfg);
    // cycles at link-up (free edge) if transition happened
    const linkN = res.hasTransition ? res.transitionCycle : null;
    console.log(
        `${label.padEnd(42)} life=${String(Math.round(res.totalCycles)).padStart(8)}` +
        (linkN !== null ? `  toFreeEdge=${String(Math.round(linkN)).padStart(8)}` : '                    ') +
        `  c1=${res.finalC1 !== undefined ? res.finalC1.toFixed(3) : '-'}` +
        `  c2=${res.finalC2 !== undefined ? res.finalC2.toFixed(3) : '-'}` +
        `  [${res.failureMode}]`);
    return res;
}

console.log('═══ Reproduction + sensitivity (benchmark: 7594 to free edge) ═══');
const ref = run('baseline (S3=15, PZC on)');
run('no bearing (S3=0)', { S3: 0 });
run('PZC off', {}, { usePzc: false });
run('no bearing + PZC off', { S3: 0 }, { usePzc: false });
run('threshold DK1=2.9 (NASGRO 2024 clad-ish)', {}, {}, { DK1: 2.9 });
run('hybrid TC05→TC23 bearing', { bearingModel: 'hybrid05' });
run('hybrid bearing + PZC off', { bearingModel: 'hybrid05' }, { usePzc: false });

console.log('\n═══ Transition-band sensitivity (all PZC off, benchmark: 7594) ═══');
run('pure TC05 throughout', { bearingModel: 'hybrid05', blendLo: 999, blendHi: 1000 }, { usePzc: false });
run('blend c/D = 0.5…1.5', { bearingModel: 'hybrid05', blendLo: 0.5, blendHi: 1.5 }, { usePzc: false });
run('blend c/D = 0.5…1 (default)', { bearingModel: 'hybrid05' }, { usePzc: false });
run('blend c/D = 1…2', { bearingModel: 'hybrid05', blendLo: 1, blendHi: 2 }, { usePzc: false });
run('blend c/D = 1.5…3', { bearingModel: 'hybrid05', blendLo: 1.5, blendHi: 3 }, { usePzc: false });
run('blend c/D = 2…4', { bearingModel: 'hybrid05', blendLo: 2, blendHi: 4 }, { usePzc: false });

console.log('\n═══ Case 2: W=4, m=1.5 (benchmark: 24,508) ═══');
{
    const mods = { W: 4.0, m: 1.5 };
    run('case2 NASGRO bearing, PZC on', { ...mods });
    run('case2 NASGRO bearing, PZC off', { ...mods }, { usePzc: false });
    run('case2 hybrid, PZC on', { ...mods, bearingModel: 'hybrid05' });
    run('case2 hybrid, PZC off', { ...mods, bearingModel: 'hybrid05' }, { usePzc: false });
    run('case2 pure TC05, PZC off', { ...mods, bearingModel: 'hybrid05', blendLo: 999, blendHi: 1000 }, { usePzc: false });
    run('case2 no bearing, PZC off', { ...mods, S3: 0 }, { usePzc: false });
    run('case2 eff-width 7D, PZC off', { ...mods, bearingModel: 'effwidth' }, { usePzc: false });
    run('case2 eff-width 7D, PZC on', { ...mods, bearingModel: 'effwidth' });
}

console.log('\n═══ Effective-width model: case 1 (benchmark: 7,594) ═══');
run('case1 eff-width 7D, PZC off', { bearingModel: 'effwidth' }, { usePzc: false });
run('case1 eff-width 7D, PZC on', { bearingModel: 'effwidth' });

console.log('\n═══ Eff-width BP vs benchmark BP, both cases ═══');
{
    const geom = getGeometry('TC23');
    const rows = [
        ['case1', { W: 2.0, m: 0.4 }, [
            [0.010, 0.050, 0.451, 0.300],
            [0.050, 0.108, 0.324, 0.237],
            [0.100, 0.171, 0.256, 0.242],
            [0.139, 0.250, 0.269, 0.374]]],
        ['case2', { W: 4.0, m: 1.5 }, [
            [0.010, 0.050, 0.440, 0.247],
            [0.020, 0.068, 0.386, 0.207],
            [0.030, 0.080, 0.342, 0.189],
            [0.039, 0.089, 0.311, 0.177]]]
    ];
    console.log('  case   c1      c2      BP1_bench BP1_eff   BP2_bench BP2_eff   BS1_ours BS2_ours');
    for (const [name, mods, pts] of rows) {
        for (const [c1, c2, b1, b2] of pts) {
            const p = { ...baseParams(), ...mods, bearingModel: 'effwidth' };
            p._c1 = c1; p._c2 = c2;
            const e1 = geom.getBearingBeta(c1, p, 'left');
            const e2 = geom.getBearingBeta(c2, p, 'right');
            const bs1 = geom.getBeta(c1, p, 'left');
            const bs2 = geom.getBeta(c2, p, 'right');
            console.log(`  ${name}  ${c1.toFixed(3)}   ${c2.toFixed(3)}   ${b1.toFixed(3)}     ` +
                `${e1.toFixed(3)}     ${b2.toFixed(3)}     ${e2.toFixed(3)}     ` +
                `${bs1.toFixed(3)}    ${bs2.toFixed(3)}`);
        }
    }
}

console.log('\n═══ Bearing beta comparison vs benchmark BP columns ═══');
{
    const geom = getGeometry('TC23');
    // (c1, c2, BP1, BP2) sampled from the benchmark with-bearing output
    const bench = [
        [0.010, 0.050, 0.451, 0.300],
        [0.020, 0.070, 0.413, 0.266],
        [0.050, 0.108, 0.324, 0.237],
        [0.100, 0.171, 0.256, 0.242],
        [0.139, 0.250, 0.269, 0.374]
    ];
    console.log('  c1      c2      BP1_bench BP1_nasgro BP1_hyb   BP2_bench BP2_nasgro BP2_hyb');
    for (const [c1, c2, b1, b2] of bench) {
        const p = baseParams();
        p._c1 = c1; p._c2 = c2;
        const n1 = geom.getBearingBeta(c1, p, 'left');
        const n2 = geom.getBearingBeta(c2, p, 'right');
        const pH = { ...p, bearingModel: 'hybrid05' };
        const h1 = geom.getBearingBeta(c1, pH, 'left');
        const h2 = geom.getBearingBeta(c2, pH, 'right');
        console.log(`  ${c1.toFixed(3)}   ${c2.toFixed(3)}   ${b1.toFixed(3)}     ` +
            `${n1.toFixed(3)}      ${h1.toFixed(3)}     ${b2.toFixed(3)}     ` +
            `${n2.toFixed(3)}      ${h2.toFixed(3)}`);
    }
}

console.log('\n═══ K breakdown along the right-crack path (c1 grown proportionally) ═══');
{
    const geom = getGeometry('TC23');
    const params = baseParams();
    const sigma = 15, S3 = 15;
    console.log('  c2      c1      beta2A   K2_tens  K2_bear  K2_tot   da/dN');
    // sample along roughly the observed c1(c2) trajectory of the baseline run
    const path = ref.data;
    const Kc = ref.Kc;
    for (const c2t of [0.05, 0.08, 0.12, 0.16, 0.20, 0.25, 0.29]) {
        // find c1 at this c2 from the run history
        let c1t = params.a0;
        for (let i = 0; i < path.c2.length; i++) {
            if (path.c2[i] >= c2t) { c1t = path.c1[i]; break; }
        }
        params._c1 = c1t; params._c2 = c2t;
        const betaA = geom.getBeta(c2t, params, 'right');
        const Ktens = sigma * Math.sqrt(Math.PI * c2t) * betaA;
        const Ktot = geom.getK_total(c2t, sigma, S3, params, 'right');
        const Kbear = Ktot - Ktens;
        const gr = NasgroEquation.growthRate(Ktot, 0, MAT, Kc);
        console.log(`  ${c2t.toFixed(3)}   ${c1t.toFixed(3)}   ${betaA.toFixed(3)}    ` +
            `${Ktens.toFixed(2).padStart(6)}   ${Kbear.toFixed(2).padStart(6)}   ` +
            `${Ktot.toFixed(2).padStart(6)}   ${gr.dadN.toExponential(2)}`);
    }
    console.log(`  (Kc = ${Kc.toFixed(1)} ksi√in)`);
}

console.log('\n═══ Bearing beta decomposition at start (c1=0.01, c2=0.05) ═══');
{
    const geom = getGeometry('TC23');
    const params = baseParams();
    params._c1 = 0.01; params._c2 = 0.05;
    const c = 0.05, side = 'right';
    const R = params.D / 2, W = params.W;
    const B = W - params.m;
    const c1 = 0.01, c2 = 0.05;
    const c0 = (c1 + params.D + c2) / 2, b = B + (c2 - c1) / 2;
    const betaA = geom.getBeta(c, params, side);
    const bC2_2 = geom._betaC2_2(c, R);
    const bC2_3 = geom._betaC2_3(c0, c1, c2, W, side);
    const bC2_4 = geom._betaC2_4(c0, b, W, side);
    const betaC = geom.getBetaC(c, params, side);
    console.log(`  βA (C1, also C2:1) = ${betaA.toFixed(3)}`);
    console.log(`  C2:2 (radial press) = ${bC2_2.toFixed(3)}`);
    console.log(`  C2:3 (unequal)      = ${bC2_3.toFixed(3)}`);
    console.log(`  C2:4 (finite width) = ${bC2_4.toFixed(3)}`);
    console.log(`  βC2 = product       = ${(betaA * bC2_2 * bC2_3 * bC2_4).toFixed(3)}`);
    console.log(`  βC = ½(C1+C2+C3)    = ${betaC.toFixed(3)}`);
    console.log(`  K_bear = (D/W)·βC·S3·√(πc) = ${(params.D / W * betaC * 15 * Math.sqrt(Math.PI * c)).toFixed(2)} ksi√in`);
}

console.log('\n═══ Growth-law check at fixed ΔK (R=0) ═══');
{
    const Kc = NasgroEquation.calcKc(0.05, MAT);
    for (const dK of [5, 10, 15, 20, 30]) {
        const gr = NasgroEquation.growthRate(dK, 0, MAT, Kc);
        console.log(`  ΔK=${String(dK).padStart(2)}: da/dN=${gr.dadN.toExponential(2)} in/cyc  ` +
            `(f=${gr.f.toFixed(3)}, effΔK=${((1 - gr.f) * dK).toFixed(1)}, ΔKth=${gr.DKth.toFixed(2)})`);
    }
}

console.log('\n═══ Benchmark implied average rates ═══');
console.log('  benchmark: A2 0.05→0.250 in 7594 cyc → avg da/dN ≈ ' +
    ((0.25 - 0.05) / 7594).toExponential(2));
console.log('  benchmark: A1 0.01→0.139 in 7594 cyc → avg da/dN ≈ ' +
    ((0.139 - 0.01) / 7594).toExponential(2));
{
    // ours: cycles for c2 to reach 0.25 and c1 value there
    const d = ref.data;
    for (let i = 0; i < d.c2.length; i++) {
        if (d.c2[i] >= 0.25) {
            console.log(`  ours:      c2 reaches 0.250 at N=${Math.round(d.N[i])}, c1=${d.c1[i].toFixed(3)}` +
                ` → avg da/dN ≈ ${((0.25 - 0.05) / d.N[i]).toExponential(2)}`);
            break;
        }
    }
}
