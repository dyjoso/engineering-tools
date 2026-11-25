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
vm.runInContext(src + '\nthis.computeInclusion = computeInclusion; this.A3 = APPENDIX_A3; this.A4 = APPENDIX_A4;', ctx);
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

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
