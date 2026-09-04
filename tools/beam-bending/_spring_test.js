// Numerical verification harness for spring supports (Euler-Bernoulli).
// Mirrors the exact assembly in index.html so signs can be trusted.
function bandedCholesky(K, b, half) {
  const n = K.length;
  const Lb = new Float64Array(n * (half + 1));
  for (let i = 0; i < n; i++) for (let j = Math.max(0, i - half); j <= i; j++) {
    let s = K[i][j]; const iB = i * (half + 1);
    for (let k = Math.max(0, i - half); k < j; k++) s -= Lb[iB + (i - k)] * Lb[j * (half + 1) + (j - k)];
    if (j === i) Lb[iB] = Math.sqrt(Math.max(s, 1e-300)); else Lb[iB + (i - j)] = s / Lb[j * (half + 1)];
    }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; const iB = i * (half + 1); for (let k = Math.max(0, i - half); k < i; k++) s -= Lb[iB + (i - k)] * y[k]; y[i] = s / Lb[iB]; }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k <= Math.min(n - 1, i + half); k++) s -= Lb[k * (half + 1) + (k - i)] * x[k]; x[i] = s / Lb[i * (half + 1)]; }
  return x;
}
function eulerKe(EI, L) {
  const k = EI / Math.pow(L, 3);
  return [
    [12 * k, 6 * L * k, -12 * k, 6 * L * k],
    [6 * L * k, 4 * L * L * k, -6 * L * k, 2 * L * L * k],
    [-12 * k, -6 * L * k, 12 * k, -6 * L * k],
    [6 * L * k, 2 * L * L * k, -6 * L * k, 4 * L * L * k],
   ];
}
// Single-section Euler beam. endBC: 'fixed'|'pinned'|'free'.
// springs: {node, dof(0=trans,1=rot), k}. forces: {node, P}.
function solve({ L, EI, n, leftBC, rightBC, springs = [], forces = [] }) {
  const dx = L / n, m = n + 1, ndof = 2 * m;
  const K = Array.from({ length: ndof }, () => new Array(ndof).fill(0));
  const F = new Array(ndof).fill(0);
  for (let e = 0; e < n; e++) {
    const g = [2 * e, 2 * e + 1, 2 * (e + 1), 2 * (e + 1) + 1];
    const Ke = eulerKe(EI, dx);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) K[g[i]][g[j]] += Ke[i][j];
    }
  for (const fo of forces) F[2 * fo.node] += fo.P;
  const constrained = [], Korig = K.map((r) => r.slice()), Forig = F.slice();
  const applyBC = (node, type) => {
    let dofs = [];
    if (type === 'pinned') dofs = [2 * node];
    else if (type === 'sliding') dofs = [2 * node + 1];
    else if (type === 'fixed') dofs = [2 * node, 2 * node + 1];
    for (const dof of dofs) { for (let j = 0; j < ndof; j++) { K[dof][j] = 0; K[j][dof] = 0; } K[dof][dof] = 1; F[dof] = 0; constrained.push(dof); }
    };
  applyBC(0, leftBC); applyBC(m - 1, rightBC);
  for (const sp of springs) K[2 * sp.node + sp.dof][2 * sp.node + sp.dof] += sp.k;
  const d = bandedCholesky(K, F, 3);
  const reactions = {};
  for (const cidx of constrained) { let r = Forig[cidx]; for (let j = 0; j < ndof; j++) r -= Korig[cidx][j] * d[j]; reactions[cidx] = r; }
  return { d, reactions };
}
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

console.log('=== Case A: beam on 2 vertical springs, central point load P ===');
{
  const L = 4, EI = 1.6e7, P = 10000, k = 5e6, n = 400;
  const res = solve({ L, EI, n, leftBC: 'free', rightBC: 'free', springs: [{ node: 0, dof: 0, k }, { node: n, dof: 0, k }], forces: [{ node: n / 2, P }] });
  const Fs = k * res.d[0], wMid = res.d[2 * (n / 2)];
  console.log('spring reaction (k*w)    =', Fs, ' expected P/2 =', P / 2, ' rel err', rel(Fs, P / 2));
  console.log('midspan deflection       =', wMid, ' expected P L^3/48EI + P/2k =', P * L ** 3 / (48 * EI) + P / (2 * k), ' rel err', rel(wMid, P * L ** 3 / (48 * EI) + P / (2 * k)));
}

console.log('\n=== Case B: cantilever (fixed left) + tip rotation spring, tip load P ===');
{
  const L = 3, EI = 1.6e7, P = 5000, kr = 2e6, n = 400;
  const res = solve({ L, EI, n, leftBC: 'fixed', rightBC: 'free', springs: [{ node: n, dof: 1, k: kr }], forces: [{ node: n, P }] });
  const theta = res.d[2 * n + 1];
  const Mccw = -kr * theta, Mtable = kr * theta, Man = kr * P * L * L / (2 * (EI + kr * L));
  console.log('theta tip                 =', theta);
  console.log('spring M (CCW, -k*th)    =', Mccw, ' expected', Man, ' rel err', rel(Mccw, Man));
  console.log('spring M (table, k*th)   =', Mtable);
  console.log('fixed-end RAW reactions[1]=', res.reactions[1], ' vs analytic CCW', Man, ' ratio', res.reactions[1] / Man);
   // Direct internal moment at the tip from the last element DOFs (sagging+ per stiffness matrix).
  const e = n - 1, g = [2 * e, 2 * e + 1, 2 * (e + 1), 2 * (e + 1) + 1], d = res.d, dx = L / n;
  const kk = EI / dx ** 3;
  const Mtip_internal = 6 * dx * kk * d[g[0]] + 2 * dx * dx * kk * d[g[1]] - 6 * dx * kk * d[g[2]] + 4 * dx * dx * kk * d[g[3]];
  console.log('M at tip from element (internal) =', Mtip_internal);
  console.log('  |internal| vs k*theta  =', rel(Mtip_internal, Mtable), ' vs -k*theta', rel(Mtip_internal, Mccw));
}

console.log('\n=== Case C: raw reaction sign for a fixed end (downward tip load P) ===');
{
  const L = 3, EI = 1.6e7, P = 5000, n = 200;
  const res = solve({ L, EI, n, leftBC: 'fixed', rightBC: 'free', forces: [{ node: n, P }] });
  console.log('reactions[1] (raw)       =', res.reactions[1]);
  console.log('-reactions[1]            =', -res.reactions[1]);
  console.log('physical: downward P at tip -> fixed-end moment magnitude P*L =', P * L);
}
