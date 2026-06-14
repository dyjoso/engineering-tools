/**
 * tc23b-fea-table.js — FEA-derived SENT bridging restraint table (TC23B).
 *
 * R(a/W) = K_with_fasteners / K_without_fasteners, extracted from the
 * FEA-membranes interaction-integral solver (validated to ~1% vs the
 * analytical weight-function method at the anchor point a/W = 0.35, R = 0.811),
 * for ONE fixed stringer/skin/fastener configuration (the "offline correction
 * surface" — see docs/technical-reference.md §4).
 *
 * When params.sentBridgeModel === 'feaTable', the TC23B SENT phase multiplies
 * the unbridged SENT β by R(a/W) interpolated from this table, replacing the
 * analytical bridging in that phase. The two-crack phase is unaffected.
 *
 * To populate: run the FEA sweep (FeaSweep, --spring-scale 1 then 0) over the
 * SENT crack range and paste the (a/W, R) pairs below, ascending in a/W. Keep
 * CONFIG in sync so the running geometry can be checked against the table basis;
 * a mismatch should warn (the 1-D table is only valid for its own config).
 */

const TC23B_FEA_SENT = {
    // Configuration the table was generated for (null until populated).
    config: {
        W: null, tStr: null, EStr: null, nuStr: null,
        tSkin: null, ESkin: null, nuSkin: null,
        m: null, pitch: null, nFast: null, fastenerK: null
    },
    aOverW: [],   // ascending
    R: []         // K_bridged / K_unbridged at each aOverW
};

/**
 * Linear interpolation of the FEA restraint ratio at a/W.
 * Returns 1.0 (no restraint) if the table is empty. Clamps to the table
 * endpoints outside the tabulated range (flat extrapolation).
 * @param {number} aOverW
 * @returns {number} R = K_bridged/K_unbridged
 */
function interpSentRestraint(aOverW) {
    const g = TC23B_FEA_SENT.aOverW, R = TC23B_FEA_SENT.R;
    const n = g.length;
    if (n === 0) return 1.0;
    if (n === 1) return R[0];
    if (aOverW <= g[0]) return R[0];
    if (aOverW >= g[n - 1]) return R[n - 1];
    let i = 0;
    while (i < n - 1 && g[i + 1] < aOverW) i++;
    const t = (aOverW - g[i]) / (g[i + 1] - g[i]);
    return R[i] * (1 - t) + R[i + 1] * t;
}

/** True once the table has data to use. */
function hasSentFeaTable() {
    return TC23B_FEA_SENT.aOverW.length > 0;
}

if (typeof window !== 'undefined') {
    window.TC23B_FEA_SENT = TC23B_FEA_SENT;
    window.interpSentRestraint = interpSentRestraint;
    window.hasSentFeaTable = hasSentFeaTable;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { TC23B_FEA_SENT, interpSentRestraint, hasSentFeaTable };
}
