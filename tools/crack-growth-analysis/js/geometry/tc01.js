/**
 * tc01.js — TC01: Through crack at center of plate
 * 
 * NASGRO Crack Case TC01
 * Geometry: Flat rectangular plate of width W and thickness t,
 *           with a central through-thickness crack of total length 2a.
 * Loading:  S0 — Remote uniform tension σ
 * 
 * SIF Solution:
 *   K = σ · √(πa) · β(a/W)
 *   β = √[ sec(π·a / W) ]       (Feddersen / Isida secant correction)
 * 
 * Valid for a/W < ~0.95
 */

class TC01Geometry extends CrackGeometry {
    constructor() {
        super('TC01', 'TC01 — Through Crack at Center of Plate');
    }

    /**
     * Feddersen/Isida secant correction factor.
     * β = √[ sec(π·a / W) ] = √[ 1 / cos(π·a / W) ]
     * @param {number} a      - Half-crack length [in]
     * @param {object} params - { W: plate width [in], t: thickness [in] }
     * @returns {number} β, or -1 if geometry limit exceeded
     */
    getBeta(a, params) {
        const W = params.W;
        const ratio = a / W;

        // Geometry limit: a/W must be < 0.95
        if (ratio >= 0.95) return -1;

        const arg = (Math.PI * a) / W;
        // Guard against cos → 0 (arg → π/2)
        if (arg >= Math.PI / 2 * 0.999) return -1;

        return Math.sqrt(1.0 / Math.cos(arg));
    }

    /**
     * Maximum valid half-crack length.
     * @param {object} params - { W }
     * @returns {number} [in]
     */
    getMaxCrack(params) {
        return 0.95 * params.W / 2.0;
    }

    /**
     * Input field definitions for the UI.
     */
    getInputFields() {
        return [
            { id: 'W', label: 'Plate Width, W', unit: 'in', default: 10.0, step: 0.1, min: 0.01 },
            { id: 't', label: 'Thickness, t', unit: 'in', default: 0.063, step: 0.001, min: 0.001 },
            { id: 'a0', label: 'Initial Half-Crack, a₀', unit: 'in', default: 0.25, step: 0.01, min: 0.001 }
        ];
    }

    /**
     * Draw a schematic of the TC01 geometry.
     * Shows a rectangular plate with a center crack, dimension lines, and stress arrows.
     */
    drawDiagram(ctx, params, a, canvasW, canvasH) {
        ctx.clearRect(0, 0, canvasW, canvasH);

        const pad = 40;
        const plateW = canvasW - 2 * pad;
        const plateH = canvasH - 2 * pad - 20;
        const cx = canvasW / 2;
        const cy = canvasH / 2;
        const x0 = pad;
        const y0 = pad + 10;

        // Draw plate outline
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 2;
        ctx.fillStyle = '#e2e8f0';
        ctx.beginPath();
        ctx.rect(x0, y0, plateW, plateH);
        ctx.fill();
        ctx.stroke();

        // Crack: horizontal line at center
        const W = params.W || 10;
        const aRatio = Math.min(a / (W / 2), 0.95);
        const crackHalfPx = aRatio * (plateW / 2);

        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(cx - crackHalfPx, cy);
        ctx.lineTo(cx + crackHalfPx, cy);
        ctx.stroke();

        // Crack tips
        ctx.fillStyle = '#ef4444';
        [cx - crackHalfPx, cx + crackHalfPx].forEach(tipX => {
            ctx.beginPath();
            ctx.arc(tipX, cy, 3.5, 0, 2 * Math.PI);
            ctx.fill();
        });

        // Dimension: 2a
        const dimY = cy + 20;
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        // Leader lines
        ctx.beginPath();
        ctx.moveTo(cx - crackHalfPx, cy + 4);
        ctx.lineTo(cx - crackHalfPx, dimY + 5);
        ctx.moveTo(cx + crackHalfPx, cy + 4);
        ctx.lineTo(cx + crackHalfPx, dimY + 5);
        ctx.stroke();
        ctx.setLineDash([]);
        // Dimension line
        ctx.beginPath();
        ctx.moveTo(cx - crackHalfPx, dimY);
        ctx.lineTo(cx + crackHalfPx, dimY);
        ctx.stroke();
        // Arrowheads
        drawArrowhead(ctx, cx - crackHalfPx, dimY, 'right', '#2563eb');
        drawArrowhead(ctx, cx + crackHalfPx, dimY, 'left', '#2563eb');
        // Label
        ctx.fillStyle = '#2563eb';
        ctx.font = '12px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('2a', cx, dimY + 15);

        // Dimension: W (along bottom)
        const wDimY = y0 + plateH + 18;
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x0, wDimY);
        ctx.lineTo(x0 + plateW, wDimY);
        ctx.stroke();
        drawArrowhead(ctx, x0, wDimY, 'right', '#475569');
        drawArrowhead(ctx, x0 + plateW, wDimY, 'left', '#475569');
        ctx.fillStyle = '#475569';
        ctx.fillText('W', cx, wDimY + 14);

        // Stress arrows (top and bottom)
        ctx.fillStyle = '#059669';
        ctx.strokeStyle = '#059669';
        ctx.lineWidth = 1.5;
        const arrowCount = 5;
        for (let i = 0; i < arrowCount; i++) {
            const ax = x0 + plateW * (i + 0.5) / arrowCount;
            // Top arrows (pointing down into plate = tension)
            drawStressArrow(ctx, ax, y0 - 2, 'down');
            // Bottom arrows (pointing up into plate = tension)
            drawStressArrow(ctx, ax, y0 + plateH + 2, 'up');
        }

        // σ label
        ctx.fillStyle = '#059669';
        ctx.font = 'italic 13px Inter, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('σ (S0)', x0 + plateW + 5, y0 + 5);
    }
}

// Helper: draw a small arrowhead
function drawArrowhead(ctx, x, y, direction, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    const sz = 5;
    if (direction === 'right') {
        ctx.moveTo(x, y);
        ctx.lineTo(x + sz, y - sz / 2);
        ctx.lineTo(x + sz, y + sz / 2);
    } else if (direction === 'left') {
        ctx.moveTo(x, y);
        ctx.lineTo(x - sz, y - sz / 2);
        ctx.lineTo(x - sz, y + sz / 2);
    }
    ctx.closePath();
    ctx.fill();
}

// Helper: draw a stress arrow
function drawStressArrow(ctx, x, y, direction) {
    const len = 16;
    const headSz = 5;
    ctx.beginPath();
    if (direction === 'down') {
        ctx.moveTo(x, y - len);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - headSz, y - headSz);
        ctx.lineTo(x + headSz, y - headSz);
    } else {
        ctx.moveTo(x, y + len);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - headSz, y + headSz);
        ctx.lineTo(x + headSz, y + headSz);
    }
    ctx.closePath();
    ctx.fill();
}

// Register TC01
registerGeometry(new TC01Geometry());
