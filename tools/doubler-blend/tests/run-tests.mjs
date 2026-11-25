// Headless checks of the SCT-027 engine (the ENGINE block of index.html, run as-is).
// Run:  node tools/doubler-blend/tests/run-tests.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const src = html.split('// ENGINE-BEGIN')[1].split('// ENGINE-END')[0];
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.computeInclusion = computeInclusion; this.A3 = APPENDIX_A3; this.A4 = APPENDIX_A4; this.ext = exteriorStress; this.at = stressAt; this.profile = stressProfile; this.decay = decayDistance; this.edge = edgeStress; this.edgePeak = edgePeak;', ctx);
const C = ctx.computeInclusion;

let failed = 0, passed = 0;
const near = (got, want, tol, what) => {
    if (Math.abs(got - want) <= tol) { passed++; return; }
    failed++;
    console.log(`FAIL ${what}: got ${got}, want ${want} (tol ${tol})`);
};
const ok = (cond, what) => { if (cond) passed++; else { failed++; console.log('FAIL ' + what); } };

// 1. The spreadsheet (Doubler_Blend_Skin_Stress_Calculator.xlsx) baseline, to machine precision
const base = { sx0: 15, sy0: 0, ts: 0.04, tr: 0.09, L: 5, W: 5, Es: 10.5, Ed: 10.5, nu: 0.33 };
let r = C(base);
ok(r.type === 'Doubler', 'baseline type');
near(r.Gamma, 2.25, 1e-12, 'Gamma');
near(r.S.S1111, 0.66625, 1e-12, 'S1111');
near(r.S.S1122, -0.00124999999999997, 1e-12, 'S1122');
near(r.det, 3.35919921875, 1e-12, 'det');
near(r.ends.sx, 18.4143356338413, 1e-9, 'ends sx');
near(r.ends.sy, 3.38293864213825, 1e-9, 'ends sy');
near(r.ends.vm, 16.9775576308021, 1e-9, 'ends vM');
near(r.sides.sx, 8.18702722816892, 1e-9, 'sides sx');
near(r.sides.sy, 0.0156984958515278, 1e-9, 'sides sy');
near(r.region.sx, 8.18414917059614, 1e-9, 'region sx');
near(r.region.sy, 0.00697710926734571, 1e-9, 'region sy');
near(r.doubler.sx, 8.18414917059614, 1e-9, 'doubler sx');
near(r.peak, 18.4143356338413, 1e-9, 'peak');
ok(r.peakAt === 'ends', 'peak at ends');
near(r.peakVM, 16.9775576308021, 1e-9, 'peak vM');
near(r.equilibrium.inRegion, 736.573425353652, 1e-6, 'equilibrium in region');
near(r.equilibrium.inRegion - r.equilibrium.ends, 0, 1e-9, 'equilibrium difference');

// 2. Uniaxial closed form (Appendix A Eqs. A.7, A.8) for many Γ, r, ν
for (const nu of [0.0, 0.3, 0.33]) for (const G of [0.0, 0.25, 0.75, 1, 1.5, 2.25, 4, 20]) for (const rr of [0.2, 0.5, 1, 2, 5]) {
    const t = C({ sx0: 10, sy0: 0, ts: 0.05, tr: G * 0.05, L: 1, W: rr, Es: 10, Ed: 10, nu });
    const N = G * (2 + rr * (3 + nu)) + rr * (2 * rr + 1 - nu);
    const D = G * G * rr * (1 + nu) * (3 - nu) + 2 * G * (1 + rr * rr - rr * nu * (1 - nu)) + rr * (1 - nu * nu);
    const tag = `G=${G} r=${rr} nu=${nu}`;
    near(t.K.front, G * N / D, 1e-9, 'Kfront ' + tag);
    near(t.K.side, (N + nu * rr * (G - 1) ** 2 * (1 - nu - 2 * nu * rr)) / D, 1e-9, 'Kside ' + tag);
    if (G > 0) near(t.K.under, N / D, 1e-9, 'Kunder ' + tag);
    near(t.equilibrium.inRegion, t.equilibrium.ends, 1e-9, 'equilibrium ' + tag);
}

// 3. Linearity: biaxial = σx0 case + σy0 case (the latter with L and W swapped)
{
    const p = { sx0: 12, sy0: 5, ts: 0.04, tr: 0.03, L: 6, W: 2.5, Es: 10.5, Ed: 10.5, nu: 0.33 };
    const both = C(p), x = C({ ...p, sy0: 0 }), y = C({ ...p, sx0: 0 });
    for (const loc of ['ends', 'sides', 'region']) for (const c of ['sx', 'sy'])
        near(both[loc][c], x[loc][c] + y[loc][c], 1e-9, `superposition ${loc}.${c}`);
    const ySwap = C({ ...p, sx0: 5, sy0: 0, L: 2.5, W: 6 });
    near(y.sides.sy, ySwap.ends.sx, 1e-9, 'σy0 case = σx0 case rotated (side vs end)');
}

// 4. Limits: Kirsch for an open circular hole; a region of skin thickness changes nothing
r = C({ ...base, tr: 0, L: 4, W: 4 });
ok(r.type === 'Hole' && r.region === null && r.doubler === null, 'hole: no region / doubler stress');
near(r.sides.sx, 45, 1e-9, 'Kirsch σx,side = 3σx0');
near(r.ends.sy, -15, 1e-9, 'Kirsch σy,end = −σx0');
near(r.ends.sx, 0, 1e-12, 'hole: σx,end = 0');
r = C({ ...base, tr: 0.04 });
ok(r.type === 'None', 'tr = ts: no region');
for (const loc of ['ends', 'sides', 'region']) { near(r[loc].sx, 15, 1e-12, `none ${loc} sx`); near(r[loc].sy, 0, 1e-12, `none ${loc} sy`); }
r = C({ ...base, tr: 0.02 });
ok(r.type === 'Blend' && r.doubler === null && Math.abs(r.Gamma - 0.5) < 1e-12, 'blend: Γ = tr/ts, no doubler row');
// doubler of a different modulus enters only through Γ; the doubler stress scales by Ed/Es
r = C({ ...base, Ed: 16.0 });
near(r.Gamma, (10.5 * 0.04 + 16 * 0.05) / (10.5 * 0.04), 1e-12, 'Γ with Ed ≠ Es');
near(r.doubler.sx, 16 / 10.5 * r.region.sx, 1e-12, 'doubler stress = Ed/Es σin');

// 5. Appendix A tables reproduced to their printed rounding
for (const [LW, G, kf, , , ku] of ctx.A3) {
    // The table prints Γ rounded (2.58 is really ~2.576); Kfront = Γ·Kunder recovers it from the
    // table's own values, so compare at that Γ (the printed one agrees to within 0.0006).
    const Gt = Math.abs(kf / ku - G) < 0.01 ? kf / ku : G;
    const t = C({ sx0: 15, sy0: 0, ts: 0.04, tr: Gt * 0.04, L: LW, W: 1, Es: 10.5, Ed: 10.5, nu: 0.33 });
    near(t.K.front, kf, 0.0006, `A.3 Kfront L/W=${LW} Γ=${G}`);
    near(t.K.under, ku, 0.0006, `A.3 Kunder L/W=${LW} Γ=${G}`);
}
for (const [label, tr, L, W, sy0, loc, sx, , sy] of ctx.A4) {
    const t = C({ sx0: 15, sy0, ts: 0.04, tr, L, W, Es: 10.5, Ed: 10.5, nu: 0.33 });
    near(t[loc].sx, sx, 0.006, `A.4 ${tr} ${loc} σx`);
    near(t[loc].sy, sy, 0.006, `A.4 ${tr} ${loc} σy`);
}
// worked blend example (A.6): peak 17.2 ksi in the thinned region, beside 16.5, ends 12.9
r = C({ sx0: 15, sy0: 7.5, ts: 0.04, tr: 0.03, L: 5, W: 2.5, Es: 10.5, Ed: 10.5, nu: 0.33 });
ok(r.peakAt === 'region', 'A.6 blend: peak in the thinned region');
near(r.peak, 17.24, 0.006, 'A.6 blend peak');

// 6. Input checks
ok(C({ ...base, ts: 0 }).errors.some(e => e.field === 'ts'), 'ts = 0 rejected');
ok(C({ ...base, W: -1 }).errors.some(e => e.field === 'W'), 'negative W rejected');
ok(C({ ...base, nu: 0.5 }).errors.some(e => e.field === 'nu'), 'ν = 0.5 rejected');
ok(C({ ...base, sx0: NaN }).errors.some(e => e.field === 'sx0'), 'blank stress rejected');


// 7. Stress away from the edge (exterior field)
{
    const X = ctx.ext, AT = ctx.at;
    // circle, doubler: closed form σx = σ0 + [½(ΓS−σ0) + 2(ΓD−σ0)]ρ² − 1.5(ΓD−σ0)ρ⁴ (stress-function solution)
    const t = C(base), a = 2.5, G = t.Gamma, S = t.sinx + t.siny, D = t.sinx - t.siny;
    for (const d of [0.001, 0.1, 0.25, 0.6, 1.25, 2.5, 5, 10]) {
        const rho = a / (a + d);
        near(AT(base, t, 'ahead', d).sx, 15 + (0.5 * (G * S - 15) + 2 * (G * D - 15)) * rho ** 2 - 1.5 * (G * D - 15) * rho ** 4,
             1e-6, `circle closed form, ahead d=${d}`);
    }
    // the maximum ahead is just off the edge: ρ² = (½(ΓS−σ0)+2(ΓD−σ0)) / (3(ΓD−σ0))
    const c2 = 0.5 * (G * S - 15) + 2 * (G * D - 15), c4 = 1.5 * (G * D - 15);
    const pr = ctx.profile(base, t, 'ahead', 5);
    near(pr.peak.sx, 15 + c2 * c2 / (4 * c4), 1e-6, 'off-edge peak value');
    near(pr.peak.d, a / Math.sqrt(c2 / (2 * c4)) - a, 1e-4, 'off-edge peak distance');
    ok(pr.peak.sx > t.ends.sx, 'the peak ahead is above the edge value');
    // Kirsch (open circular hole): ahead σx = σ0(1 − 2.5ρ² + 1.5ρ⁴), beside σx = σ0(1 + ρ²/2 + 1.5ρ⁴)
    const hole = { ...base, tr: 0 }, th = C(hole);
    for (const d of [0.01, 0.3, 1, 2.5, 7]) {
        const rho = a / (a + d);
        near(AT(hole, th, 'ahead', d).sx, 15 * (1 - 2.5 * rho ** 2 + 1.5 * rho ** 4), 1e-6, `Kirsch ahead d=${d}`);
        near(AT(hole, th, 'beside', d).sx, 15 * (1 + rho ** 2 / 2 + 1.5 * rho ** 4), 1e-6, `Kirsch beside d=${d}`);
    }
    // ellipses: the outside field tends to the edge values from the interior solution; far field = remote
    const cases = [{ ...base, sy0: 7.5, W: 2.5 }, { ...base, tr: 0.03, W: 2.5, sy0: 7.5 }, { ...base, tr: 0.02, L: 2, W: 6 },
                   { ...base, tr: 0, W: 1.5 }, { ...base, L: 8, W: 2, sy0: -6 }, { ...base, tr: 0.2, Ed: 16, L: 1.5, W: 4 }];
    for (const p of cases) {
        const r = C(p), tag = `tr=${p.tr} L=${p.L} W=${p.W} σy0=${p.sy0}`;
        const e = X(p, r, p.L / 2 * (1 + 1e-9), 0), s = X(p, r, 0, p.W / 2 * (1 + 1e-9));
        for (const c of ['sx', 'sy']) {
            near(e[c], r.ends[c], 1e-4 * Math.max(1, Math.abs(r.ends[c])), `edge limit ends.${c} ${tag}`);
            near(s[c], r.sides[c], 1e-4 * Math.max(1, Math.abs(r.sides[c])), `edge limit sides.${c} ${tag}`);
        }
        const far = X(p, r, 1e4 * p.L, 0), far2 = X(p, r, 0, 1e4 * p.W);
        near(far.sx, p.sx0, 1e-5, 'far field σx ' + tag); near(far.sy, p.sy0, 1e-5, 'far field σy ' + tag);
        near(far2.sx, p.sx0, 1e-5, 'far field (side) σx ' + tag);
        near(X(p, r, p.L / 2 + 0.3, 0).txy, 0, 1e-8, 'no shear on the axis ' + tag);
    }
    // decay distance: circle doubler, half the edge excess left at about one half-length
    const d50 = ctx.decay(base, t, 0.5), rho50 = (() => { const s2 = AT(base, t, 'ahead', d50); return s2; })();
    near(rho50.sx - 15, 0.5 * (t.ends.sx - 15), 1e-6, 'decay distance hits 50%');
    ok(d50 > 2 && d50 < 3.5, `50% excess between 2 and 3.5 in (got ${d50.toFixed(3)})`);
    ok(ctx.decay({ ...base, tr: 0.04 }, C({ ...base, tr: 0.04 }), 0.5) === 0, 'no region: no decay distance');
}

// N. Highest round the edge (closed form at any edge point)
{
    const s1 = (q) => (q.sx + q.sy) / 2 + Math.hypot((q.sx - q.sy) / 2, q.txy);
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 40; i++) {
        const p = { sx0: 30 * rnd() - 10, sy0: 30 * rnd() - 15, ts: 0.04, tr: [0, 0.02, 0.03, 0.06, 0.09, 0.16][i % 6],
                    L: 1 + 5 * rnd(), W: 1 + 5 * rnd(), Es: 10.5, Ed: [10.5, 16][i % 2], nu: 0.33 };
        const r = C(p), tag = `random ${i}`;
        const e0 = ctx.edge(p, r, 0), e9 = ctx.edge(p, r, Math.PI / 2);
        near(e0.sx, r.ends.sx, 1e-9, 'edge t=0 is the end σx ' + tag); near(e0.sy, r.ends.sy, 1e-9, 'edge t=0 is the end σy ' + tag);
        near(e9.sx, r.sides.sx, 1e-9, 'edge t=90 is the side σx ' + tag); near(e9.sy, r.sides.sy, 1e-9, 'edge t=90 is the side σy ' + tag);
        // agrees with the exterior field just outside the edge at an arbitrary point
        const t = 0.1 + 1.3 * rnd(), e = ctx.edge(p, r, t), x = ctx.ext(p, r, e.x * (1 + 1e-7), e.y * (1 + 1e-7));
        const tol = 2e-4 * Math.max(1, Math.abs(p.sx0), Math.abs(p.sy0));
        near(x.sx, e.sx, tol, 'edge σx = exterior field ' + tag); near(x.sy, e.sy, tol, 'edge σy = exterior field ' + tag);
        near(x.txy, e.txy, tol, 'edge τxy = exterior field ' + tag);
        const pk = ctx.edgePeak(p, r);
        ok(pk.s1 >= Math.max(r.ends.sx, r.ends.sy, r.sides.sx, r.sides.sy) - 1e-9, 'edge peak not below the ends and sides ' + tag);
        let scan = -1e9;
        for (let k = 0; k <= 2000; k++) scan = Math.max(scan, ctx.edge(p, r, k / 2000 * Math.PI / 2).s1);
        near(pk.s1, scan, 1e-6 * Math.max(1, scan), 'edge peak is the maximum ' + tag);
    }
    // BRANE FE validation (SCT-030 Validation, cases 1-4): FE highest skin principal round the edge
    for (const [tr, L, W, fe] of [[0.09, 5, 5, 18.64], [0.08, 5, 2.5, 20.43], [0.12, 2.5, 5, 17.44], [0.16, 5, 1.25, 31.44]]) {
        const p = { sx0: 15, sy0: 0, ts: 0.04, tr, L, W, Es: 10.5, Ed: 10.5, nu: 0.33 };
        near(ctx.edgePeak(p, C(p)).s1, fe, 0.003 * fe, `edge peak vs FE, tr ${tr} ${L}x${W}`);
    }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
