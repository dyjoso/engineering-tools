const fs = require('fs');

const { TC05_DATA, interpolateTable } = require('./js/geometry/tc05-data.js');

const c = 0.05;
const D = 0.25;
const H = 1.0;
const t = 0.1;

const DH = D / H; // 0.25
const denominator = H - D; // 0.75
const x = c / denominator; // 0.05 / 0.75 = 0.066666...

const tableTension = TC05_DATA.C4;

const F0 = interpolateTable(tableTension, x, DH);

console.log(`DH: ${DH}, x: ${x}`);
console.log(`F0: ${F0}`);
