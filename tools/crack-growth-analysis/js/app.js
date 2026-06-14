/**
 * app.js — UI glue: event handlers, chart rendering, and application flow
 * 
 * Reads inputs, runs CrackGrowthEngine, and renders results.
 * Supports both single-crack (TC01) and dual-crack (TC23) geometries.
 */

let chartA = null;   // Chart.js instance: crack vs N
let chartDadN = null; // Chart.js instance: da/dN vs ΔK
let currentGeomId = 'TC01';
let lastResult = null;

// ── Initialisation ──────────────────────────

window.addEventListener('DOMContentLoaded', () => {
    populateGeometrySelector();
    populateMaterialSelector();
    onGeometryChange();
});

function populateGeometrySelector() {
    const sel = document.getElementById('geometry-select');
    const geoms = getGeometryList();
    geoms.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.label;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', onGeometryChange);
}

function populateMaterialSelector() {
    const sel = document.getElementById('material-select');
    const keys = getMaterialKeys();
    keys.forEach(key => {
        const mat = getMaterial(key);
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = mat.name;
        sel.appendChild(opt);
    });
    sel.addEventListener('change', onMaterialChange);
    onMaterialChange();  // populate fields from first material on load
}

/**
 * Build the DOM for a single geometry input field.
 * Supports type 'select', 'toggle' (binary yes/no switch) and the default
 * numeric input. A field may set `full: true` to span both grid columns.
 */
function buildGeomField(f) {
    const group = document.createElement('div');
    group.className = 'input-group';
    if (f.full) group.classList.add('full');

    // Binary toggle: rendered as a switch, value is 'yes' / 'no'.
    if (f.type === 'toggle') {
        group.classList.add('toggle-group');
        const onVal = f.onValue || 'yes';
        const lab = document.createElement('label');
        lab.className = 'toggle-label';
        lab.innerHTML =
            `<span class="toggle-switch">` +
            `<input type="checkbox" id="geom-${f.id}">` +
            `<span class="toggle-track"></span></span>` +
            `<span>${f.label}</span>`;
        const cb = lab.querySelector('input');
        cb.dataset.onValue = onVal;
        cb.dataset.offValue = f.offValue || 'no';
        cb.checked = (f.default === undefined ? true : f.default === onVal);
        group.appendChild(lab);
        return group;
    }

    const label = document.createElement('label');
    label.htmlFor = `geom-${f.id}`;
    label.innerHTML = f.unit ? `${f.label} <span class="unit">(${f.unit})</span>` : f.label;

    let input;
    if (f.type === 'select') {
        input = document.createElement('select');
        input.id = `geom-${f.id}`;
        f.options.forEach(opt => {
            const optEl = document.createElement('option');
            optEl.value = opt.value;
            optEl.textContent = opt.label;
            if (opt.value === f.default) optEl.selected = true;
            input.appendChild(optEl);
        });
    } else {
        input = document.createElement('input');
        input.type = 'number';
        input.id = `geom-${f.id}`;
        input.value = f.default;
        input.step = f.step;
        if (f.min !== undefined) input.min = f.min;
    }

    group.appendChild(label);
    group.appendChild(input);
    return group;
}

/**
 * When geometry changes, rebuild the geometry-specific input fields.
 * Fields carrying a `group` label are rendered as titled sub-regions
 * (e.g. Stringer / Skin / Fastener Properties); ungrouped fields fall into
 * a single untitled two-column block.
 */
function onGeometryChange() {
    const geomId = document.getElementById('geometry-select').value;
    const geom = getGeometry(geomId);
    const container = document.getElementById('geom-fields');
    container.innerHTML = '';

    const fields = geom.getInputFields();

    // Preserve first-seen order of groups; '' is the default (untitled) block.
    const order = [];
    const byGroup = new Map();
    fields.forEach(f => {
        const g = f.group || '';
        if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
        byGroup.get(g).push(f);
    });

    order.forEach(g => {
        const grid = document.createElement('div');
        grid.className = 'field-grid';
        byGroup.get(g).forEach(f => grid.appendChild(buildGeomField(f)));

        if (g === '') {
            container.appendChild(grid);          // ungrouped: bare grid, no box
        } else {
            const region = document.createElement('div');
            region.className = 'field-group';
            const title = document.createElement('div');
            title.className = 'field-group-title';
            title.textContent = g;
            region.appendChild(title);
            region.appendChild(grid);
            container.appendChild(region);
        }
    });

    // Live geometry preview: redraw the diagram on any geometry input change
    container.querySelectorAll('input, select').forEach(el => {
        el.addEventListener('input', () => drawGeomDiagram(geom));
        el.addEventListener('change', () => drawGeomDiagram(geom));
    });

    drawGeomDiagram(geom);
}

function onMaterialChange() {
    const key = document.getElementById('material-select').value;
    const mat = getMaterial(key);
    document.getElementById('mat-C').value = mat.C;
    document.getElementById('mat-n').value = mat.n;
    document.getElementById('mat-p').value = mat.p;
    document.getElementById('mat-q').value = mat.q;
    document.getElementById('mat-DK1').value = mat.DK1;
    document.getElementById('mat-Cth-plus').value = mat.Cth_plus;
    document.getElementById('mat-Cth-minus').value = mat.Cth_minus;
    document.getElementById('mat-K1e').value = mat.K1e;
    document.getElementById('mat-K1c').value = mat.K1c;
    document.getElementById('mat-Ak').value = mat.Ak;
    document.getElementById('mat-Bk').value = mat.Bk;
    document.getElementById('mat-Yield').value = mat.Yield;
    document.getElementById('mat-UTS').value = mat.UTS;
    document.getElementById('mat-alpha').value = mat.alpha;
    document.getElementById('mat-Smax-S0').value = mat.Smax_S0;
    document.getElementById('mat-alpha-th').value = mat.alpha_th;
    document.getElementById('mat-Smax-S0-th').value = mat.Smax_S0_th;
}

// ── Collapsible Sections ────────────────────

function toggleCollapse(headerEl) {
    headerEl.classList.toggle('open');
    const body = headerEl.nextElementSibling;
    body.classList.toggle('open');
}

// ── Read Inputs ─────────────────────────────

function readGeomParams() {
    const geomId = document.getElementById('geometry-select').value;
    const geom = getGeometry(geomId);
    const fields = geom.getInputFields();
    const params = {};
    fields.forEach(f => {
        const el = document.getElementById(`geom-${f.id}`);
        if (f.type === 'toggle') {
            params[f.id] = el.checked ? el.dataset.onValue : el.dataset.offValue;
        } else if (f.type === 'select') {
            params[f.id] = el.value;
        } else {
            params[f.id] = parseFloat(el.value);
        }
    });
    return params;
}

function readMaterial() {
    return {
        name: 'Custom',
        C: parseFloat(document.getElementById('mat-C').value),
        n: parseFloat(document.getElementById('mat-n').value),
        p: parseFloat(document.getElementById('mat-p').value),
        q: parseFloat(document.getElementById('mat-q').value),
        DK1: parseFloat(document.getElementById('mat-DK1').value),
        Cth_plus: parseFloat(document.getElementById('mat-Cth-plus').value),
        Cth_minus: parseFloat(document.getElementById('mat-Cth-minus').value),
        K1e: parseFloat(document.getElementById('mat-K1e').value),
        K1c: parseFloat(document.getElementById('mat-K1c').value),
        Ak: parseFloat(document.getElementById('mat-Ak').value),
        Bk: parseFloat(document.getElementById('mat-Bk').value),
        Yield: parseFloat(document.getElementById('mat-Yield').value),
        UTS: parseFloat(document.getElementById('mat-UTS').value),
        alpha: parseFloat(document.getElementById('mat-alpha').value),
        Smax_S0: parseFloat(document.getElementById('mat-Smax-S0').value),
        alpha_th: parseFloat(document.getElementById('mat-alpha-th').value),
        Smax_S0_th: parseFloat(document.getElementById('mat-Smax-S0-th').value)
    };
}

// ── Run Analysis ────────────────────────────

function runAnalysis() {
    const errorEl = document.getElementById('error-msg');
    errorEl.style.display = 'none';
    errorEl.textContent = '';

    try {
        const geomId = document.getElementById('geometry-select').value;
        const geomParams = readGeomParams();
        const mat = readMaterial();
        const sigmaMax = parseFloat(document.getElementById('sigma-max').value);
        const R = parseFloat(document.getElementById('R-ratio').value);
        const S2_bending = parseFloat(document.getElementById('S2-bending').value) || 0;
        const S3_bearing = parseFloat(document.getElementById('S3-bearing').value) || 0;
        const maxCycles = parseFloat(document.getElementById('max-cycles').value) || 1e7;

        geomParams.S2 = S2_bending;
        geomParams.S3 = S3_bearing;
        geomParams._sigmaMax = sigmaMax;   // used by TC23B biaxial skin mismatch

        const KcOverrideStr = document.getElementById('mat-Kc-override').value;
        const KcOverride = KcOverrideStr ? parseFloat(KcOverrideStr) : undefined;

        const geom = getGeometry(geomId);

        // Validation
        if (sigmaMax <= 0) throw new Error('Max stress must be positive.');
        if (R >= 1) throw new Error('R must be < 1.');
        if (geomParams.a0 <= 0) throw new Error('Initial crack must be positive.');

        if (geomId === 'TC23' && geomParams.useStif === 'yes') {
            const R_hole = geomParams.D / 2;
            const m = geomParams.m !== undefined ? geomParams.m : geomParams.W / 2;
            if (geomParams.dStif <= R_hole) {
                throw new Error('Stiffener distance (d_stif) must be greater than the hole radius (D/2).');
            }
            if (geomParams.dStif >= m) {
                throw new Error('Stiffener must be to the left of the right edge (d_stif must be less than right margin m).');
            }
            if (geomParams.tStif <= 0) {
                throw new Error('Stiffener thickness must be positive.');
            }
            if (geomParams.AStif <= 0) {
                throw new Error('Stiffener area must be positive.');
            }
            if (geomParams.DFast <= 0) {
                throw new Error('Fastener diameter must be positive.');
            }
            if (geomParams.pFast <= 0) {
                throw new Error('Fastener pitch must be positive.');
            }
        }

        if (geomId === 'TC23B' && geomParams.useBridge === 'yes') {
            if (geomParams.pFast <= 0) {
                throw new Error('Fastener pitch must be positive.');
            }
            if (geomParams.DFast <= 0) {
                throw new Error('Fastener diameter must be positive.');
            }
            if (geomParams.pFast <= geomParams.DFast) {
                throw new Error('Fastener pitch must exceed the fastener diameter.');
            }
            if (geomParams.tSkin <= 0 || geomParams.ESkin <= 0) {
                throw new Error('Skin thickness and modulus must be positive.');
            }
            if (geomParams.EStr <= 0 || geomParams.EFast <= 0) {
                throw new Error('Stringer and fastener moduli must be positive.');
            }
            if (!(geomParams.nFast >= 1)) {
                throw new Error('At least one fastener each side of the crack is required.');
            }
            if (geomParams.skinStress === 'biaxial'
                && (!isFinite(geomParams.sigL) || !isFinite(geomParams.sigH))) {
                throw new Error('Skin biaxial stresses σ_L and σ_H must be specified.');
            }
            if (geomParams.skinStress === 'hoop' && !isFinite(geomParams.sigH)) {
                throw new Error('Skin hoop stress σ_H must be specified.');
            }
        }

        const engineConfig = {
            geometryId: geomId,
            geomParams: geomParams,
            a0: geomParams.a0,
            sigmaMax: sigmaMax,
            R: R,
            material: mat,
            maxCycles: maxCycles,
            pzcMode: document.getElementById('pzc-mode').value,
            logEvery: parseFloat(document.getElementById('log-every').value) || 1000
        };

        if (KcOverride !== undefined && !isNaN(KcOverride)) {
            engineConfig.Kc_override = KcOverride;
        }

        // For dual-crack, pass the second initial crack
        if (geom.isDualCrack() && geomParams.a0_2 !== undefined) {
            engineConfig.a0_2 = geomParams.a0_2;
        }

        // Calc and display Kc, DKth
        const Kc = NasgroEquation.calcKc(geomParams.t, mat);
        const DKth = NasgroEquation.thresholdDK(R, mat);
        document.getElementById('mat-Kc-calc').value = Kc.toFixed(2);
        document.getElementById('mat-DKth-calc').value = DKth.toFixed(3);

        // Run engine
        const result = CrackGrowthEngine.run(engineConfig);
        lastResult = result;
        currentGeomId = geomId;

        // ── Update summary stats ──
        if (result.hasTransition) {
            document.getElementById('res-final-a').textContent =
                `a_edge=${result.finalCrack.toFixed(4)} in (c₁=${result.finalC1.toFixed(4)})`;
            document.querySelector('#res-final-a').closest('.stat-box')
                .querySelector('.stat-label').textContent = 'Final Edge Crack';
        } else if (result.isDual) {
            document.getElementById('res-final-a').textContent =
                `c₁=${result.finalC1.toFixed(4)}  c₂=${result.finalC2.toFixed(4)} in`;
            document.querySelector('#res-final-a').closest('.stat-box')
                .querySelector('.stat-label').textContent = 'Final Cracks (c₁, c₂)';
        } else {
            const isHoleCrack = (geomId === 'TC23' || geomId === 'TC05');
            const crackLabel = isHoleCrack ? 'c' : '2a';
            const displayVal = isHoleCrack ? result.finalCrack : result.finalTwoA;
            document.getElementById('res-final-a').textContent = displayVal.toFixed(4) + ' in';
            document.querySelector('#res-final-a').closest('.stat-box')
                .querySelector('.stat-label').textContent = `Final Crack (${crackLabel})`;
        }

        document.getElementById('res-cycles').textContent = Math.round(result.totalCycles).toLocaleString();
        document.getElementById('res-kc').textContent = result.Kc.toFixed(1) + ' ksi√in';

        const modeEl = document.getElementById('res-mode');
        modeEl.textContent = result.failureMode;
        modeEl.className = 'stat-value';
        if (result.failureMode.includes('Fracture') || result.failureMode.includes('Yield')) {
            modeEl.classList.add('danger');
        } else if (result.failureMode.includes('Threshold')) {
            modeEl.classList.add('success');
        } else {
            modeEl.classList.add('warning');
        }

        // ── Render charts ──
        if (result.isDual) {
            renderChartDual(result.data, result);
        } else {
            renderChartSingle(result.data);
        }
        renderChartDadNvsDK(result.data);

        // ── Draw diagram ──
        if (result.isDual) {
            drawGeomDiagram(geom, geomParams, { c1: result.finalC1, c2: result.finalC2 });
        } else {
            drawGeomDiagram(geom, geomParams, result.finalCrack);
        }

        // ── Render log ──
        renderLog(result);

        // ── Fastener bridging report (TC23B) ──
        if (geomId === 'TC23B' && geomParams.useBridge === 'yes') {
            renderFastenerReport(result, geom, geomParams, sigmaMax);
        }

    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    }
}

// ── Chart Rendering ─────────────────────────

/**
 * Single-crack chart: crack length vs cycles.
 */
function renderChartSingle(data) {
    const ctx = document.getElementById('chart-a-vs-N').getContext('2d');
    if (chartA) chartA.destroy();

    const isHoleCrack = (currentGeomId === 'TC23' || currentGeomId === 'TC05');
    const label = isHoleCrack ? 'Crack Length (c)' : 'Crack Length (2a)';
    const yLabel = isHoleCrack ? 'Crack Length c (in)' : 'Crack Length 2a (in)';
    const points = data.N.map((n, i) => ({
        x: n,
        y: isHoleCrack ? data.a[i] : data.twoA[i]
    }));

    chartA = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: label,
                data: points,
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59, 130, 246, 0.08)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.1
            }]
        },
        options: chartOptionsLinear('Cycles (N)', yLabel)
    });
}

/**
 * Dual-crack chart: c₁ and c₂ vs cycles (two series).
 * If result has a transition, also shows a_edge and a vertical transition marker.
 */
function renderChartDual(data, result) {
    const ctx = document.getElementById('chart-a-vs-N').getContext('2d');
    if (chartA) chartA.destroy();

    const pts1 = data.N.map((n, i) => ({ x: n, y: data.c1[i] }));
    const pts2 = data.N.map((n, i) => ({ x: n, y: data.c2[i] }));

    const datasets = [
        {
            label: 'c₁ (left)',
            data: pts1,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.05)',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.1
        },
        {
            label: 'c₂ (right)',
            data: pts2,
            borderColor: '#8b5cf6',
            backgroundColor: 'rgba(139, 92, 246, 0.05)',
            borderWidth: 2,
            pointRadius: 0,
            fill: true,
            tension: 0.1,
            borderDash: [6, 3]
        }
    ];

    // Add a_edge series if transition occurred
    if (result && result.hasTransition) {
        const ptsEdge = data.N.map((n, i) => {
            return n >= result.transitionCycle ? { x: n, y: data.a[i] } : null;
        }).filter(p => p !== null);
        datasets.push({
            label: 'a_edge (SENT)',
            data: ptsEdge,
            borderColor: '#ef4444',
            backgroundColor: 'rgba(239, 68, 68, 0.05)',
            borderWidth: 2.5,
            pointRadius: 0,
            fill: false,
            tension: 0.1
        });
    }

    const options = chartOptionsLinear('Cycles (N)', 'Crack Length (in)');

    // Add vertical transition line via plugin
    const transLine = (result && result.hasTransition) ? result.transitionCycle : null;
    const plugins = transLine ? [{
        id: 'transitionLine',
        afterDraw(chart) {
            const xScale = chart.scales.x;
            const yScale = chart.scales.y;
            const xPx = xScale.getPixelForValue(transLine);
            if (xPx < xScale.left || xPx > xScale.right) return;
            const ctx2 = chart.ctx;
            ctx2.save();
            ctx2.strokeStyle = '#f59e0b';
            ctx2.lineWidth = 1.5;
            ctx2.setLineDash([6, 4]);
            ctx2.beginPath();
            ctx2.moveTo(xPx, yScale.top);
            ctx2.lineTo(xPx, yScale.bottom);
            ctx2.stroke();
            ctx2.setLineDash([]);
            ctx2.fillStyle = '#f59e0b';
            ctx2.font = '11px Inter, sans-serif';
            ctx2.textAlign = 'center';
            ctx2.fillText('Link-up', xPx, yScale.top - 4);
            ctx2.restore();
        }
    }] : [];

    chartA = new Chart(ctx, {
        type: 'line',
        data: { datasets },
        options,
        plugins
    });
}

/**
 * da/dN vs ΔK chart (log-log) — same for single and dual.
 */
function renderChartDadNvsDK(data) {
    const ctx = document.getElementById('chart-dadN-vs-dK').getContext('2d');
    if (chartDadN) chartDadN.destroy();

    const points = [];
    for (let i = 0; i < data.dK.length; i++) {
        if (data.dK[i] > 0 && data.dadN[i] > 0) {
            points.push({ x: data.dK[i], y: data.dadN[i] });
        }
    }

    chartDadN = new Chart(ctx, {
        type: 'scatter',
        data: {
            datasets: [{
                label: 'da/dN vs ΔK',
                data: points,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.5)',
                pointRadius: 1.5,
                pointHoverRadius: 4,
                showLine: true,
                borderWidth: 1.5,
                tension: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'logarithmic',
                    title: { display: true, text: 'ΔK (ksi√in)', color: '#94a3b8' },
                    ticks: { color: '#64748b' },
                    grid: { color: 'rgba(100,116,139,0.15)' }
                },
                y: {
                    type: 'logarithmic',
                    title: { display: true, text: 'da/dN (in/cycle)', color: '#94a3b8' },
                    ticks: { color: '#64748b' },
                    grid: { color: 'rgba(100,116,139,0.15)' }
                }
            },
            plugins: {
                legend: { labels: { color: '#94a3b8' } },
                tooltip: { mode: 'nearest', intersect: true }
            }
        }
    });
}

/**
 * Shared chart options factory for linear-scale charts.
 */
function chartOptionsLinear(xLabel, yLabel) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
            x: {
                type: 'linear',
                title: { display: true, text: xLabel, color: '#94a3b8' },
                ticks: { color: '#64748b' },
                grid: { color: 'rgba(100,116,139,0.15)' }
            },
            y: {
                title: { display: true, text: yLabel, color: '#94a3b8' },
                ticks: { color: '#64748b' },
                grid: { color: 'rgba(100,116,139,0.15)' }
            }
        },
        plugins: {
            legend: { labels: { color: '#94a3b8' } },
            tooltip: { mode: 'index', intersect: false }
        }
    };
}

// ── Geometry Diagram ────────────────────────

function drawGeomDiagram(geom, params, a) {
    const canvas = document.getElementById('geom-canvas');
    const ctx = canvas.getContext('2d');

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const p = params || readGeomParams();
    const aCurr = a || p.a0 || 0.25;

    geom.drawDiagram(ctx, p, aCurr, rect.width, rect.height);
}

// ── Log Rendering ───────────────────────────

function renderLog(result) {
    const logEl = document.getElementById('analysis-log');

    if (result.isDual) {
        renderLogDual(result, logEl);
    } else {
        renderLogSingle(result, logEl);
    }
}

function renderLogSingle(result, logEl) {
    const crackCol = (currentGeomId === 'TC23' || currentGeomId === 'TC05') ? 'c (in)' : '2a (in)';

    let header = `Crack Growth Analysis — ${result.failureMode}\n`;
    header += `Kc = ${result.Kc.toFixed(2)} ksi√in | Steps = ${result.totalSteps} | Cycles = ${Math.round(result.totalCycles).toLocaleString()}\n`;
    header += '─'.repeat(90) + '\n';
    header += padCol('Cycle', 12) + padCol(crackCol, 12) + padCol('Kmax', 12) +
        padCol('ΔK', 12) + padCol('β', 10) + padCol('da/dN', 14) + 'Note\n';
    header += '─'.repeat(90) + '\n';

    let body = '';
    result.logEntries.forEach(e => {
        const crackVal = (currentGeomId === 'TC23' || currentGeomId === 'TC05')
            ? (parseFloat(e.twoA) / 2).toFixed(5)
            : e.twoA;
        body += padCol(e.N.toLocaleString(), 12) +
            padCol(crackVal, 12) +
            padCol(e.Kmax, 12) +
            padCol(e.dK, 12) +
            padCol(e.beta, 10) +
            padCol(e.dadN, 14) +
            e.tag + '\n';
    });

    logEl.textContent = header + body;
}

function renderLogDual(result, logEl) {
    // Optional load-bypass column (TC23B with bridging): S_bypass/S₀ applied to
    // the membrane stress. β columns remain the pure geometry factors.
    const geom = getGeometry(currentGeomId);
    const params = readGeomParams();
    const showByp = typeof geom.getBypassFactor === 'function'
        && params.useBridge === 'yes';
    const bypDual = (e) => {
        if (!showByp) return '';
        const c1 = parseFloat(e.c1), c2 = parseFloat(e.c2);
        params._c1 = c1; params._c2 = c2;
        return padCol(geom.getBypassFactor(c2, params, 'right').toFixed(4), 10);
    };
    const bypEdge = (e) => {
        if (!showByp || typeof geom.getBypassFactorEdge !== 'function') return '';
        return padCol(geom.getBypassFactorEdge(parseFloat(e.a), params).toFixed(4), 10);
    };
    const bypHead = showByp ? padCol('Sbyp/S₀', 10) : '';

    let header = `Crack Growth Analysis (Dual) — ${result.failureMode}\n`;
    header += `Kc = ${result.Kc.toFixed(2)} ksi√in | Steps = ${result.totalSteps} | Cycles = ${Math.round(result.totalCycles).toLocaleString()}\n`;
    if (showByp) header += 'β columns are pure geometry factors; K = β · (Sbyp/S₀)·S₀ · √(πc) on the membrane term.\n';
    header += '─'.repeat(120) + '\n';
    header += padCol('Cycle', 12) + padCol('c₁', 10) + padCol('c₂', 10) +
        padCol('K₁', 10) + padCol('K₂', 10) +
        padCol('da/dN₁', 12) + padCol('da/dN₂', 12) +
        padCol('β₁', 8) + padCol('β₂', 8) + bypHead + 'Note\n';
    header += '─'.repeat(120) + '\n';

    let body = '';
    let sentHeaderShown = false;
    result.logEntries.forEach(e => {
        if (e.isDual === false && !sentHeaderShown) {
            // Transition separator
            body += '\n' + '═'.repeat(120) + '\n';
            body += `  LINK-UP at N = ${result.transitionCycle ? Math.round(result.transitionCycle).toLocaleString() : '?'} — Transition to SENT Edge Crack\n`;
            body += '═'.repeat(120) + '\n';
            body += padCol('Cycle', 12) + padCol('a_edge', 12) +
                padCol('Kmax', 12) + padCol('ΔK', 12) +
                padCol('β', 10) + padCol('da/dN', 14) + bypHead + 'Note\n';
            body += '─'.repeat(100) + '\n';
            sentHeaderShown = true;
        }

        if (e.isDual === false) {
            // SENT-phase single-crack entry
            body += padCol(e.N.toLocaleString(), 12) +
                padCol(e.a, 12) +
                padCol(e.Kmax, 12) +
                padCol(e.dK, 12) +
                padCol(e.beta, 10) +
                padCol(e.dadN, 14) +
                bypEdge(e) +
                e.tag + '\n';
        } else {
            // TC23-phase dual-crack entry
            body += padCol(e.N.toLocaleString(), 12) +
                padCol(e.c1, 10) +
                padCol(e.c2, 10) +
                padCol(e.K1, 10) +
                padCol(e.K2, 10) +
                padCol(e.dadN1, 12) +
                padCol(e.dadN2, 12) +
                padCol(e.beta1, 8) +
                padCol(e.beta2, 8) +
                bypDual(e) +
                e.tag + '\n';
        }
    });

    logEl.textContent = header + body;
}

function padCol(val, width) {
    return String(val).padEnd(width);
}

// ── Fastener Bridging Report (TC23B) ────────

/**
 * Appends a fastener bridging summary to the analysis log:
 * restraint ratio and per-fastener loads at the final crack size, the peak
 * fastener load over the whole run, and an allowable-exceedance warning.
 */
function renderFastenerReport(result, geom, geomParams, sigmaMax) {
    if (typeof geom.getFastenerState !== 'function') return;
    const logEl = document.getElementById('analysis-log');
    const data = result.data;

    // helper: fastener state at a history index
    const stateAt = (i) => {
        const inSent = result.hasTransition && data.N[i] >= result.transitionCycle;
        return inSent
            ? { aEdge: data.a[i] }
            : { c1: data.c1[i], c2: data.c2[i] };
    };

    // Sweep the crack history for the peak fastener load (linear in σ, so
    // the peak occurs at the largest restrained crack — but sweep anyway).
    const nPts = data.N.length;
    const nSamples = Math.min(60, nPts);
    let peakF = 0, peakN = 0, peakA = 0;
    for (let s = 0; s < nSamples; s++) {
        const i = Math.min(nPts - 1, Math.round(s * (nPts - 1) / Math.max(nSamples - 1, 1)));
        const st = geom.getFastenerState(geomParams, stateAt(i), sigmaMax);
        if (st && st.maxF > peakF) {
            peakF = st.maxF;
            peakN = data.N[i];
            peakA = data.a[i];
        }
    }

    const stFinal = geom.getFastenerState(geomParams, stateAt(nPts - 1), sigmaMax);
    if (!stFinal) return;

    let txt = '\n' + '═'.repeat(90) + '\n';
    txt += '  FASTENER BRIDGING SUMMARY (Swift displacement compatibility, modified Tate & Rosenfeld)\n';
    txt += '═'.repeat(90) + '\n';
    txt += `At final crack — load bypass reduction of membrane K:\n`;
    txt += `   P_applied (stringer)  = ${stFinal.Papplied.toFixed(3)} kip\n`;
    txt += `   P_total  (to skin)    = ${stFinal.Ptot.toFixed(3)} kip  (Σ fastener loads, one side)\n`;
    txt += `   S_bypass / S_gross    = ${stFinal.R.toFixed(4)}   (membrane K scaled by this)\n`;
    txt += `Peak fastener load over run:     ${peakF.toFixed(3)} kip  (at N ≈ ${Math.round(peakN).toLocaleString()}, a ≈ ${peakA.toFixed(3)} in)\n`;
    txt += 'Fastener pair loads at final crack size (per fastener, kip):\n';
    stFinal.F.forEach((F, j) => {
        if (j < 8 || F > 0.01 * stFinal.maxF) {
            txt += `   y = ±${stFinal.y[j].toFixed(2)} in:  ${F.toFixed(3)}\n`;
        }
    });

    const allow = geomParams.FfAllow || 0;
    if (allow > 0) {
        if (peakF > allow) {
            txt += `\n⚠ WARNING: peak fastener load ${peakF.toFixed(3)} kip exceeds the shear allowable ` +
                `${allow.toFixed(3)} kip.\n  Fastener failure is NOT modelled — bridging restraint beyond this ` +
                `point is unconservative.\n  Re-run with Skin Bridging = Off (or fewer effective fasteners) to bound the result.\n`;
        } else {
            txt += `\nFastener check: peak load ${peakF.toFixed(3)} kip ≤ allowable ${allow.toFixed(3)} kip  ✓\n`;
        }
    }

    logEl.textContent += txt;
}
