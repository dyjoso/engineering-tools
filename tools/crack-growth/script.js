// Nasgro Constants for 2024-T3 Sheet (Approximate Imperial)
const MATERIAL = {
    C: 1.1e-8, // in/cycle for K in ksi-sqrt(in)
    n: 3.5,
    p: 0.25,
    q: 1.0,
    dKth: 1.2, // ksi-sqrt(in)
    K1c: 33.0, // Plane Strain Fracture Toughness (ksi-sqrt(in))
    Yield: 47.0, // Yield Strength (ksi)
    Ak: 1.0, // Nasgro fit parameter
    Bk: 1.5, // Nasgro fit parameter
    alpha: 2.0, // Constraint factor for Newman closure (approx for sheet)
    Smax_Sflow: 0.3 // Ratio of max stress to flow stress (approx)
};

let chartInstance = null;

function runAnalysis() {
    // 1. Get Inputs
    const W = parseFloat(document.getElementById('width').value); // in
    const t = parseFloat(document.getElementById('thickness').value); // in
    const two_a_init = parseFloat(document.getElementById('crack-length').value); // in
    const sigma_max = parseFloat(document.getElementById('max-stress').value); // ksi
    const R = parseFloat(document.getElementById('r-ratio').value);

    const errorEl = document.getElementById('error-msg');
    const logEl = document.getElementById('analysis-log');
    errorEl.style.display = 'none';
    errorEl.textContent = '';
    logEl.value = "Starting analysis...\n";

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
    const MAX_STEPS = 10000; // Increased steps slightly

    dataPoints.push({ x: N, y: a * 2 }); // Store 2a in inches

    let failureMode = "N/A";
    let step = 0;
    let logBuffer = "";

    // 4. Growth Loop
    while (step < MAX_STEPS) {
        // A. Calculate Kmax and dK
        // Geometry Factor for M(T) Central Crack: Beta = sqrt(sec(pi*a/W))
        // K = Beta * sigma * sqrt(pi * a)

        const beta = Math.sqrt(1 / Math.cos((Math.PI * a_curr) / W_curr));

        // Check for geometry validity (a/W < 0.95 approx)
        if ((Math.PI * a_curr) / W_curr >= Math.PI / 2 * 0.99) {
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
        // Simplified Newman for constant amplitude
        const f = calculateNewmanF(R, MATERIAL.alpha, MATERIAL.Smax_Sflow);

        // C.2 Calculate Effective dK term
        // dK_eff term = ((1-f)/(1-R)) * dK

        let term1 = ((1 - f) / (1 - R)) * dK;
        if (term1 < 0) term1 = 0;

        // C.3 Threshold term
        // If dK < dKth, growth is zero (or near zero)
        if (dK <= MATERIAL.dKth) {
            // No growth
            failureMode = "Threshold (No Growth)";
            break; // Or just stop?
        }

        let term2_num = 1 - (MATERIAL.dKth / dK);
        if (term2_num < 0) term2_num = 0;

        let term2_den = 1 - (Kmax / Kcrit);
        if (term2_den < 0.001) term2_den = 0.001; // Avoid singularity near fracture

        const term2 = Math.pow(term2_num, MATERIAL.p) / Math.pow(term2_den, MATERIAL.q);

        const dadN = MATERIAL.C * Math.pow(term1, MATERIAL.n) * term2; // in/cycle

        // Logging every 1000 cycles (approximate check based on N)
        // Or simply log every X steps to avoid huge logs
        // Let's log every 1000 steps of the loop, or if N crosses a 1000 threshold?
        // The user asked for "every 1000 cycles". Since N is continuous, let's log if Math.floor(N/1000) > Math.floor(prev_N/1000)
        // But step size delta_N might be large.
        // Let's just log the state at the beginning of the step if it's the first step or if we've passed a multiple of 1000 since last log.

        // Actually, simpler: Log every iteration? No, too much.
        // Let's log if (step % 100 === 0) or if it's the first step.
        // User asked "at every 1000 cycles".
        // Since delta_N varies, we can't guarantee hitting exactly 1000, 2000.
        // We will log the current state if N >= nextLogTarget.

        if (step === 0) {
            logBuffer += formatLogLine(N, a_curr * 2, Kmax, dK, dadN);
        } else {
            // Check if we crossed a 1000 cycle boundary
            // This might miss if delta_N is huge, but for fatigue it's usually small.
            // If delta_N is large, we should log.
            // Let's just use a simple counter or check against last logged N.
        }

        // Re-reading request: "detailed output log showing all critical crack growth parameters during the analysis at every 1000 cycles."
        // I'll implement a nextLogN tracker.

        if (typeof nextLogN === 'undefined') var nextLogN = 1000;

        if (N >= nextLogN) {
            logBuffer += formatLogLine(N, a_curr * 2, Kmax, dK, dadN);
            nextLogN += 1000;
            // If N jumped way ahead (e.g. delta_N = 5000), update nextLogN to catch up
            while (nextLogN <= N) nextLogN += 1000;
        }

        if (dadN <= 0) {
            failureMode = "Stalled";
            break;
        }

        // D. Increment Crack
        // Adaptive step size

        let delta_a = 0.005; // 0.005 in default step (approx 0.12 mm)

        // Refine step near failure
        if (term2_den < 0.1) delta_a = 0.001; // 0.001 in

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
