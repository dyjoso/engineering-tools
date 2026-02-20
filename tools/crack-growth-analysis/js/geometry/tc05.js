/**
 * tc05.js — Through Crack at Hole in a Plate with a Row of Holes
 * 
 * Supports three configurations:
 * 1. Single crack (Tables C4, C5)
 * 2. Two equal cracks at one hole (Tables C6, C7)
 * 3. Two equal cracks at every hole in the row (Tables C8, C9)
 */

class TC05 extends CrackGeometry {
    constructor() {
        super('TC05', 'TC05 — Through Crack at Hole (Row of Holes)');
    }

    /**
     * Input Definition:
     * - c: Crack length (from hole edge) [in]
     * - D: Hole diameter [in]
     * - H: Hole spacing (pitch) [in]
     * - t: Thickness [in] (standard)
     * - W: Plate width is NOT explicitly used in the K solution for infinite row,
     *      but we need it for net section stress if we assume a finite width W,
     *      or we just use H as the repeating width unit.
     *      NASGRO TC05 is typically for an "infinite row" in an infinite plate (width-wise).
     *      However, usually checks are done against H.
     *      Let's ask for H.
     *      We will also include a "config" dropdown.
     */
    getInputFields() {
        return [
            { id: 'a0', label: 'Crack Length (c)', unit: 'in', default: 0.1, step: 0.01, min: 0.0001 },
            { id: 'D', label: 'Hole Diameter (D)', unit: 'in', default: 0.25, step: 0.01, min: 0.001 },
            { id: 'H', label: 'Hole Spacing (H)', unit: 'in', default: 1.0, step: 0.1, min: 0.001 },
            { id: 't', label: 'Thickness (t)', unit: 'in', default: 0.1, step: 0.01, min: 0.001 },
            {
                id: 'config',
                label: 'Configuration',
                type: 'select',
                options: [
                    { value: 'single', label: 'Single Crack' },
                    { value: 'double_one', label: 'Double Crack (One Hole)' },
                    { value: 'double_all', label: 'Double Crack (All Holes)' }
                ],
                default: 'single'
            }
        ];
    }

    /**
     * Configuration Beta factor for tension.
     */
    getBeta(c, params) {
        const { D, H, config } = params;
        if (c <= 0 || D <= 0 || H <= 0) return -1;
        if (D >= H) return -1;

        const DH = D / H;
        const denominator = H - D;
        let x = 0;
        let tableTension;

        if (config === 'double_all') {
            tableTension = TC05_DATA.C8;
            x = (2 * c) / denominator;
        } else if (config === 'double_one') {
            tableTension = TC05_DATA.C6;
            x = c / denominator;
        } else {
            tableTension = TC05_DATA.C4;
            x = c / denominator;
        }

        return interpolateTable(tableTension, x, DH);
    }

    /**
     * SIF Calculation
     * K = (S0*F0 + S2*F2 + S3*F3 + S4*F4) * sqrt(pi*c)
     * 
     * Note: The NASGRO Appendix C text for TC05 mentions F0 (Tension), F3 (Pin), F4 (Lateral).
     * It does not explicitly mention S2 (Bending) in the standard way, 
     * but standard NASGRO usually allows S0, S1, S2, S3.
     * 
     * Based on the tables:
     * - Tension (S0) -> Tables C4, C6, C8
     * - Pin (S3)     -> Tables C5, C7, C9
     * - Lateral (S4?) -> Table C10 (Formula)
     * 
     * We will implement S0 and S3 mapping to the tables.
     * We will implement Lateral check if needed? 
     * Technical Reference mentions S0, S1, S2, S3 usually.
     * 
     * Let's enforce:
     * - S0 = Tension
     * - S3 = Bearing
     */
    getK(c, sigma, params) {
        const { D, H, config } = params;
        const S0 = sigma || 0; // Remote Tension
        const S3 = params.S3 || 0; // Bearing

        // Safety checks
        if (c <= 0 || D <= 0 || H <= 0) return -1;
        if (D >= H) return -1; // Holes overlapping

        // Calculate ratios
        const DH = D / H;
        const denominator = H - D;
        let x = 0; // c/(H-D) or 2c/(H-D)

        // Select Tables
        let tableTension, tableBearing;

        if (config === 'double_all') {
            tableTension = TC05_DATA.C8;
            tableBearing = TC05_DATA.C9;
            x = (2 * c) / denominator; // Check axis definition for C8/C9
        } else if (config === 'double_one') {
            tableTension = TC05_DATA.C6;
            tableBearing = TC05_DATA.C7;
            x = c / denominator; // Tables C6, C7 use c/(H-D)
        } else {
            // Default single
            tableTension = TC05_DATA.C4;
            tableBearing = TC05_DATA.C5;
            x = c / denominator; // Tables C4, C5 use c/(H-D)
        }

        // Warning: Table C8/C9 header says 2c/(H-D). Tables C4-C7 say c/(H-D).
        // I used that logic above.

        // Get Correction Factors F0, F3
        const F0 = interpolateTable(tableTension, x, DH);
        const F3 = interpolateTable(tableBearing, x, DH);

        // K = (S0*F0 + S3*F3) * sqrt(pi*c)
        const K0 = S0 * F0 * Math.sqrt(Math.PI * c);
        const K3 = S3 * F3 * Math.sqrt(Math.PI * c);

        return K0 + K3;
    }

    getMaxCrack(params) {
        const { H, D, config } = params;
        // Limit based on ligament
        // c_max approx (H-D)/2 or similar. 
        // Tables go up to 0.99 of the ratio.

        // if double_all, ratio is 2c/(H-D) <= 0.99 => c <= 0.495*(H-D)
        // if single/double_one, ratio is c/(H-D) <= 0.99 => c <= 0.99*(H-D)

        if (config === 'double_all') {
            return 0.495 * (H - D);
        } else {
            return 0.99 * (H - D);
        }
    }

    getNetSectionStress(c, S0, params) {
        const { H, D, config } = params;
        const S3 = params.S3 || 0;

        let n = 1;
        if (config === 'double_one') n = 2;
        else if (config === 'double_all') n = 4;

        const S3_bar = Math.max(S3, 0); // compression clipping

        const numerator = S0 * H + S3_bar * D;
        const denominator = (H - D) - (n / 2) * c;

        if (denominator <= 0) return 1e9; // Fail

        return Math.abs(numerator / denominator);
    }

    drawDiagram(ctx, params, c, width, height) {
        const { D, H, config } = params;

        // Scale logic
        // Draw 3 holes to show row effect
        // Center hole at cx, cy

        const cx = width / 2;
        const cy = height / 2;

        // Determine scale. Max width needed is 3H roughly.
        const drawW = 2.5 * H;
        const scale = Math.min(width / drawW, height / (2 * H)); // heuristic

        const r = (D / 2) * scale;
        const hPx = H * scale;
        const cPx = c * scale;

        ctx.clearRect(0, 0, width, height);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;

        // Draw Plate (infinite strip simulation)
        // Just draw holes and cracks

        const holes = [-1, 0, 1];

        holes.forEach(offset => {
            const hx = cx + offset * hPx;

            // Draw Hole
            ctx.beginPath();
            ctx.arc(hx, cy, r, 0, 2 * Math.PI);
            ctx.stroke();

            // Draw Cracks
            ctx.beginPath();
            ctx.strokeStyle = '#d00';
            ctx.lineWidth = 3;

            if (config === 'double_all') {
                // Crack on both sides of every hole
                ctx.moveTo(hx - r, cy);
                ctx.lineTo(hx - r - cPx, cy);
                ctx.moveTo(hx + r, cy);
                ctx.lineTo(hx + r + cPx, cy);
            } else if (offset === 0) {
                // Center hole logic for single/double_one
                if (config === 'double_one') {
                    ctx.moveTo(hx - r, cy);
                    ctx.lineTo(hx - r - cPx, cy);
                    ctx.moveTo(hx + r, cy);
                    ctx.lineTo(hx + r + cPx, cy);
                } else {
                    // Single crack - let's put it on the right
                    ctx.moveTo(hx + r, cy);
                    ctx.lineTo(hx + r + cPx, cy);
                }
            }
            ctx.stroke();
            ctx.strokeStyle = '#000';
            ctx.lineWidth = 2;
        });

        // Check labels
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.fillText(`D=${D}", H=${H}"`, cx, cy + r + 20);
        ctx.fillText(`c=${c}"`, cx, cy - r - 20);
    }
}

// Register
registerGeometry(new TC05());
