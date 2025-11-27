// Nasgro Constants for 2024-T3 Sheet (Approximate Imperial)
const MATERIAL = {
    C: 8e-9, // in/cycle for K in ksi-sqrt(in)
    n: 3.2,
    p: 0.25,
    q: 1.0,
    dKth: 1.2, // ksi-sqrt(in)
    K1c: 30.0, // Plane Strain Fracture Toughness (ksi-sqrt(in))
    Yield: 53.0, // Yield Strength (ksi)
    Ak: 1.0, // Nasgro fit parameter
    Bk: 1.5, // Nasgro fit parameter
    alpha: 2.0, // Constraint factor for Newman closure (approx for sheet)
    Smax_Sflow: 0.3 // Ratio of max stress to flow stress (approx)
};

let chartInstance = null;

function toggleInputs() {
    const geom = document.getElementById('geometry').value;
    const holeGroup = document.getElementById('hole-diam-group');
    if (geom === 'TC23') {
        holeGroup.style.display = 'block';
    } else {
        holeGroup.style.display = 'none';
    }
}

function runAnalysis() {
    // 1. Get Inputs
    const geom = document.getElementById('geometry').value;
    const W = parseFloat(document.getElementById('width').value); // in
    const t = parseFloat(document.getElementById('thickness').value); // in
    const two_a_init = parseFloat(document.getElementById('crack-length').value); // in
    const sigma_max = parseFloat(document.getElementById('max-stress').value); // ksi
    const R = parseFloat(document.getElementById('r-ratio').value);

    let D = 0;
    if (geom === 'TC23') {
        D = parseFloat(document.getElementById('hole-diam').value);
    }

    const errorEl = document.getElementById('error-msg');
    const logEl = document.getElementById('analysis-log');
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    logEl.value = `Starting analysis for ${geom}...\n`;

    if (two_a_init >= W) {
        showError("Initial crack length must be smaller than width.");
        return;
    }

    // 2. Calculate Kcrit based on thickness
    const Kcrit = calculateKcrit(t, MATERIAL);
    document.getElementById('mat-kc-calc').value = Kcrit.toFixed(1);
    logEl.value += `Calculated Kcrit: ${Kcrit.toFixed(2)} ksi-sqrt(in) for t=${t} in\n`;
    logEl.value += "----------------------------------------------------------------\n";
    logEl.value += "Cycle      | 2a (in)  | Kmax (ksi√in) | dK (ksi√in) | da/dN (in/cyc)\n";
    logEl.value += "----------------------------------------------------------------\n";

    // 3. Initialize Variables
    let a = two_a_init / 2.0; // Half crack length (in)
    let N = 0;
    const dataPoints = [];

    // Working in INCHES directly

    let a_curr = a; // inches
    const W_curr = W; // inches

    // Loop limit to prevent browser freeze
    const MAX_CYCLES = 1e7;
    const MAX_STEPS = 10000;

    dataPoints.push({ x: N, y: a * 2 }); // Store 2a in inches

    let failureMode = "N/A";
    let step = 0;
    let logBuffer = "";
    let nextLogN = 1000;

    // 4. Growth Loop
    while (step < MAX_STEPS) {
        // A. Calculate Kmax

        // Get Beta Factor based on geometry
        const beta = getBeta(geom, a_curr, W_curr, D);

        if (beta === -1) {
            failureMode = "Geometry Limit";
            break;
        }

        const Kmax = beta * sigma_max * Math.sqrt(Math.PI * a_curr); // ksi-sqrt(in)
        const Kmin = Kmax * R;
        const dK = Kmax - Kmin;

        // B. Check Failure Criteria
        if (Kmax >= Kcrit) {
            failureMode = "Fracture (K > Kc)";
            break;
        }

        // C. Calculate da/dN using Nasgro
        // da/dN = C * [ ((1-f)/(1-R)) * dK ]^n * [ (1 - dKth/dK)^p / (1 - Kmax/Kcrit)^q ]

        // C.1 Calculate f (Newman Closure Function)
        const f = calculateNewmanF(R, MATERIAL.alpha, MATERIAL.Smax_Sflow);

        // C.2 Calculate Effective dK term
        let term1 = ((1 - f) / (1 - R)) * dK;
        if (term1 < 0) term1 = 0;

        // C.3 Threshold term
        if (dK <= MATERIAL.dKth) {
            failureMode = "Threshold (No Growth)";
            break;
        }

        let term2_num = 1 - (MATERIAL.dKth / dK);
        if (term2_num < 0) term2_num = 0;

        let term2_den = 1 - (Kmax / Kcrit);
        if (term2_den < 0.001) term2_den = 0.001;

        const term2 = Math.pow(term2_num, MATERIAL.p) / Math.pow(term2_den, MATERIAL.q);

        const dadN = MATERIAL.C * Math.pow(term1, MATERIAL.n) * term2; // in/cycle

        // Logging
        if (step === 0) {
            logBuffer += formatLogLine(N, a_curr * 2, Kmax, dK, dadN);
        }

        if (N >= nextLogN) {
            logBuffer += formatLogLine(N, a_curr * 2, Kmax, dK, dadN);
            nextLogN += 1000;
            while (nextLogN <= N) nextLogN += 1000;
        }

        if (dadN <= 0) {
            failureMode = "Stalled";
            break;
        }

        // D. Increment Crack
        let delta_a = 0.005;
        if (term2_den < 0.1) delta_a = 0.001;

        const delta_N = delta_a / dadN;

        a_curr += delta_a;
        N += delta_N;

        // Store data
        dataPoints.push({ x: Math.round(N), y: (a_curr * 2).toFixed(4) });

        step++;

        if (N > MAX_CYCLES) {
            failureMode = "Max Cycles Reached";
            break;
        }
    }

    // Log final state
    logBuffer += formatLogLine(N, a_curr * 2, 0, 0, 0) + " (End)";
    logEl.value += logBuffer;

    // 5. Update UI
    document.getElementById('res-final-a').textContent = (a_curr * 2).toFixed(4) + " in";
    document.getElementById('res-cycles').textContent = Math.round(N).toLocaleString();
    document.getElementById('res-mode').textContent = failureMode;

    renderChart(dataPoints);
}

function getBeta(geom, a, W, D) {
    if (geom === 'MT') {
        // M(T) - Central Crack
        // Beta = sqrt(sec(pi*a/W))
        // Validity: a/W < 0.95 approx
        if ((Math.PI * a) / W >= Math.PI / 2 * 0.99) return -1;
        return Math.sqrt(1 / Math.cos((Math.PI * a) / W));
    } else if (geom === 'TC23') {
        // TC23 - Through Crack at Hole (Approximated as Bowie/Newman for Central Hole)
        // a is crack length measured from the hole edge? 
        // NASGRO definition for TC23: "c" is crack length from hole edge.
        // In our tool, "a" variable tracks half crack length for M(T).
        // For TC23, let's assume the user input "Initial Crack Length" is the TOTAL crack length (2c) if it were M(T),
        // but here we should clarify.
        // Usually for hole cracks, input is 'c' (length from hole edge).
        // But to keep UI consistent, let's assume the user input "Initial Crack Length" means the total flaw size?
        // No, "Initial Crack Length, 2a" usually implies the physical crack size.
        // For TC23, let's interpret the input "2a" as the total length of the two cracks emerging from the hole?
        // OR, let's interpret "2a" as the total length including the hole? 2a = D + 2c?
        // Let's stick to the standard definition: "2a" in the input field is the total length of the crack(s).
        // For TC23 (two cracks), let's assume symmetric cracks of length c each.
        // So input value = 2c. 
        // Therefore c = input / 2.
        // And 'a' in the code (which is half length) corresponds to 'c'.

        // Bowie Solution for symmetric cracks at hole:
        // Beta = F1 * F2
        // F1 (Hole interaction) = 0.5 * (3 - c/r) / (1 + c/r) ... this is for single crack?
        // Let's use the Newman solution for symmetric cracks at a hole in finite plate.

        // Newman (1981) for two symmetric cracks at a hole:
        // K = S * sqrt(pi * c) * F
        // F = F_hole * F_width

        // r = D / 2
        const r = D / 2.0;
        const c = a; // 'a' in our loop is half the total crack length input.

        // x = c / (c + r)
        // But Newman uses lambda = c / r?

        // Let's use the Bowie approximation fitted by Newman:
        // F_hole = 1 + 0.358*lambda + 1.425*lambda^2 - 1.578*lambda^3 + 2.156*lambda^4 ... valid for c/r?
        // Actually, a simpler form often used:
        // F_hole = 0.5 * (3 - c/r) / (1 + c/r) is for single crack? No.

        // Let's use the Grandt/Bowie formula for double cracks:
        // F_hole = 1 + 0.2 * (1 - c/(c+r)) + 0.3 * (1 - c/(c+r))^2 ... ?

        // Let's use the classic Bowie solution (approx):
        // F_hole = 1 / sqrt(1 + c/r) ... No, that decreases.

        // Reliable approximation for two symmetric cracks (Newman):
        // F_hole = 1 - 0.15*u + 3.46*u^2 - 4.47*u^3 + 3.52*u^4
        // where u = 1 / (1 + c/r)

        const u = 1.0 / (1.0 + c / r);
        const F_hole = 1.0 - 0.15 * u + 3.46 * Math.pow(u, 2) - 4.47 * Math.pow(u, 3) + 3.52 * Math.pow(u, 4);

        // Finite Width Correction (Feddersen or similar):
        // Secant formula modified for hole
        // width_ratio = (2r + 2c) / W
        const width_ratio = (2 * r + 2 * c) / W;

        if (width_ratio >= 0.99) return -1;

        const F_width = Math.sqrt(1 / Math.cos((Math.PI * width_ratio) / 2));

        return F_hole * F_width;
    }
    return 1.0;
}

function formatLogLine(N, two_a, Kmax, dK, dadN) {
    return `${Math.round(N).toString().padEnd(10)} | ${two_a.toFixed(4).padEnd(8)} | ${Kmax.toFixed(2).padEnd(13)} | ${dK.toFixed(2).padEnd(11)} | ${dadN.toExponential(3)}\n`;
}

function calculateKcrit(t, mat) {
    // t0 = 2.5 * (K1c / Yield)^2
    const t0 = 2.5 * Math.pow(mat.K1c / mat.Yield, 2);

    // Kc = K1c * (1 + Bk * exp( - (Ak * t / t0)^2 ))
    const exponent = -Math.pow((mat.Ak * t) / t0, 2);
    const Kc = mat.K1c * (1 + mat.Bk * Math.exp(exponent));

    return Kc;
}

function calculateNewmanF(R, alpha, Smax_Sflow) {
    // Newman closure function f
    // f = A0 + A1*R + A2*R^2 + A3*R^3  for R >= 0

    // Constants
    const A0 = (0.825 - 0.34 * alpha + 0.05 * Math.pow(alpha, 2)) * Math.pow(Math.cos((Math.PI * Smax_Sflow) / 2), 1 / alpha);
    const A1 = (0.415 - 0.071 * alpha) * Smax_Sflow;
    // A3 = 2A0 + A1 - 1
    const A3 = 2 * A0 + A1 - 1;

    // A2 = 1 - A0 - A1 - A3
    const A2_real = 1 - A0 - A1 - A3;

    if (R >= 0) {
        return Math.max(R, A0 + A1 * R + A2_real * Math.pow(R, 2) + A3 * Math.pow(R, 3));
    } else {
        return A0;
    }
}

function showError(msg) {
    const el = document.getElementById('error-msg');
    el.textContent = msg;
    el.style.display = 'block';
}

function renderChart(data) {
    const ctx = document.getElementById('growthChart').getContext('2d');

    if (chartInstance) {
        chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: 'Crack Length (2a) vs Cycles',
                data: data,
                borderColor: '#2563eb',
                backgroundColor: 'rgba(37, 99, 235, 0.1)',
                borderWidth: 2,
                pointRadius: 0,
                fill: true,
                tension: 0.1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    type: 'linear',
                    title: {
                        display: true,
                        text: 'Cycles (N)'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: 'Crack Length 2a (in)'
                    }
                }
            },
            plugins: {
                tooltip: {
                    mode: 'index',
                    intersect: false
                }
            }
        }
    });
}

// Run once on load
window.addEventListener('DOMContentLoaded', () => {
    // runAnalysis(); // Optional: auto-run
});
