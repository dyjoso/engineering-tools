# Beam Calculator — Validation Manual

A proposed suite of analytical reference cases to validate `index.html`. It covers **every
end condition**, **every load type**, a **multi-section (variable-stiffness) beam**, and
**Timoshenko shear-beam** results. **These cases are not run here** — enter each in the
tool and compare the tool's output to the *Reference* column.

See the **Theory Manual** for how the tool computes its results and its sign conventions.

---

## 1. How to use this suite

1. For each case, set the boundary conditions, section properties, and loads as specified
   (many map directly to a built-in **preset** — noted in each case).
2. Read the tool's output from the **Key results** card, the **Reactions** table, and the
   **Value at a point** card (set the query `x` to the location of interest).
3. Compare to the *Reference* values. Because the elements are **exact**, the tool should
   match to well under 0.1 % at any mesh; a single element per break-segment is already
   near-exact for these loads.
4. **Compare magnitude + physical direction** (e.g. "R = P/2 upward", "M_max = PL/4,
   sagging, at midspan"), not the raw printed sign — the tool's internal sign convention
   is documented in §3 of the Theory Manual and has a couple of display quirks.

### 1.1 Recommended tolerance

| Quantity      | Tolerance      |
|---------------|----------------|
| Deflection w  | < 0.1 % rel.   |
| Moment M      | < 0.1 % rel.   |
| Shear V       | < 0.1 % rel.   |
| Reaction R, M | < 0.1 % rel.   |
| Bending σ     | < 0.1 % rel.   |

For the **exact elements** used here, expect relative errors ≪ 10⁻⁶; use these tolerances
as a sanity bound, not a target.

---

## 2. Reference sources

Standard closed-form beam results (deflection, moment, reaction tables):

- **Roark's *Formulas for Stress and Strain*** (Gurtin, et al.) — reaction, deflection and
  moment tables for simply-supported, cantilever, fixed-fixed, overhang and stepped beams.
- **Gere & Goodno, *Mechanics of Materials*** — same tables, worked examples.
- **Hibbeler, *Mechanics of Materials*** — cantilever / simply-supported / fixed cases.
- **Timoshenko & Winkler, *Theory of Beams*** — shear-deformable (Timoshenko) results.
- **Reddy, *Introduction to Continuum Mechanics*** / any FEM text — exact Timoshenko
  (shear-flexible) element.

All values below are the standard textbook results; where a deflection maximum *location* is
less standard it is flagged **[verify]**.

---

## 3. Sign-convention reminder (match these)

| Quantity        | Positive in the tool |
|-----------------|----------------------|
| Load P, q       | **downward**         |
| Point moment M  | **counter-clockwise**|
| Reaction vert.  | labelled `+ up`      |
| Reaction moment | `+ CCW`             |
| Internal V      | standard beam sign   |
| Internal M      | **sagging** (tension on lower fibre) — the code's output is sagging-**positive** (note the in-app Help text says the opposite; the code is authoritative) |
| Deflection w    | **downward**         |
| Rotation φ/slope| **counter-clockwise**|

When comparing, use **magnitude + physical direction**; flip signs if your reference uses
the opposite convention.

---

## 4. Standard material / section used in the numeric examples

Unless a case states otherwise, use:

```
E = 200e9 Pa (200 GPa)     I = 8e-5 m⁴      h = 0.1 m  (c = h/2 = 0.05 m)
A = 0.01 m²                ν = 0.3          G = E/2(1+ν) = 76.923 GPa
κ = 5/6                   ⇒  EI = 1.6e7 N·m²
```

Point loads `P = 10 000 N`, distributed `q = 1 000 N/m`, moment `M0 = 5 000 N·m` unless
stated. **Bending stress** check uses `σ = M·c/I` with `c = 0.05 m`.

---

## 5. Test cases

### A — Simply supported (pinned–pinned)

**A1. Central point load** — preset **point** (set L = 4, P = 10 000 N at x = 2)
- R = P/2 = **5 000 N** (each, upward).
- M_max = PL/4 = **10 000 N·m**, sagging, at x = 2 m.
- w_max = PL³/48EI = **0.8333 mm**, at x = 2 m.
- Max slope = PL²/16EI = **0.000625 rad**, at the supports.
- σ_max = M·c/I = **6.25 MPa**.

**A2. Uniform distributed load** — preset **udl** (L = 4, q = 1 000 N/m over 0→4)
- R = qL/2 = **2 000 N** (each, upward).
- M_max = qL²/8 = **2 000 N·m**, sagging, at x = 2 m.
- w_max = 5qL⁴/384EI = **0.2083 mm**, at x = 2 m.
- Max slope = qL³/24EI = **0.0001667 rad**, at the supports.
- σ_max = **1.25 MPa**.

**A3. Off-centre point load** — point load P = 10 000 N at x = 1.5 m, L = 4 m
- R_left = P(L−a)/L = **6 250 N**, R_right = Pa/L = **3 750 N**.
- M_max = P·a(L−a)/L = **9 375 N·m**, at x = 1.5 m.
- w at load point = P·a²(L−a)²/(3L·EI) = **0.7324 mm**, at x = 1.5 m.

**A4. Triangular (linear) distributed load**, 0 at x = 0 to q = 2 000 N/m at x = 4 m
- R_left = qL/6 = **1 333.3 N**, R_right = qL/3 = **2 666.7 N**.
- M_max = qL²/(9√3) = **2 052.8 N·m**, at x = L/√3 = **2.309 m**.
- w_max ≈ 0.00652·qL⁴/EI at x ≈ 0.4187L **[verify location/value vs Roark]**.

### B — Cantilever (fixed–free)

**B1. Tip point load** — preset **cant** (L = 4, P = 5 000 N at x = 4)
- R = P = **5 000 N** (up), M_reaction = PL = **20 000 N·m** at x = 0.
- M_max = PL = **20 000 N·m** (hogging) at x = 0; V = P = **5 000 N** (constant).
- w_max = PL³/3EI = **6.667 mm** at x = 4 m.
- Max slope = PL²/2EI = **0.0025 rad** at x = 4 m.
- σ_max = M·c/I = **12.5 MPa**.

**B2. Uniform distributed load**, q = 1 000 N/m over 0→4 m
- R = qL = **4 000 N**, M_reaction = qL²/2 = **8 000 N·m** at x = 0.
- M_max = qL²/2 = **8 000 N·m** (hogging) at x = 0; V_max = qL = **4 000 N** at x = 0.
- w_max = qL⁴/8EI = **2.0 mm** at x = 4 m.
- Max slope = qL³/6EI = **0.0006667 rad** at x = 4 m.

**B3. Tip applied moment**, M0 = 5 000 N·m at x = 4 m
- R = 0, M_reaction = M0 = **5 000 N·m** at x = 0; M is constant = **5 000 N·m**.
- w_max = M0L²/2EI = **2.5 mm** at x = 4 m.
- Max slope = M0L/EI = **0.00125 rad** at x = 4 m.

### C — Fixed–fixed (clamped–clamped)

**C1. Central point load**, P = 10 000 N at x = 2 m, L = 4 m
- R = P/2 = **5 000 N** (each, up), M_reaction = PL/8 = **5 000 N·m** at each end.
- M_max = PL/8 = **5 000 N·m** at the ends (hogging) and at the centre (sagging).
- w_max = PL³/192EI = **0.2083 mm** at x = 2 m.

**C2. Uniform distributed load**, q = 1 000 N/m over 0→4 m
- R = qL/2 = **2 000 N** (each, up), M_reaction = qL²/12 = **1 333.3 N·m** at each end.
- M_max = qL²/12 = **1 333.3 N·m** at ends (hogging); M_centre = qL²/24 = **666.7 N·m** (sagging).
- w_max = qL⁴/384EI = **0.04167 mm** at x = 2 m.

**C3. Central applied moment**, M0 = 5 000 N·m at x = 2 m
- R = M0/L = **1 250 N** (each, opposite sign), M_max = M0/2 = **2 500 N·m** at the ends/centre **[verify distribution vs Roark]**.

### D — Overhangs / intermediate supports

**D1. Beam with overhang**, supports at x = 0 and x = 3 m, overhang to x = 4 m, tip load
P = 5 000 N at x = 4 m (main span 3 m, overhang 1 m)
- R at x = 3 = P(1 + a/L₁) = P·4/3 = **6 666.7 N** (up); R at x = 0 = −Pa/L₁ = **−1 666.7 N** (down).
- M_max = −P·a = **−5 000 N·m** (hogging) at x = 3 m.
- w_max on the main span **[verify vs Roark overhang table]**.

**D2. Continuous / multiple intermediate supports** — preset **overhang**, or add two
supports at x = 3 m and x = 6 m on a 9 m beam with a mid-span UDL; check the three reaction
forces sum to the total load and the moment diagram is continuous.
- Static check: ΣR = total load; M = 0 at interior simple supports **[verify reaction split vs Roark]**.

### E — Guided (sliding) end conditions

**E1. Guided–guided, uniform load**, q = 1 000 N/m over 0→4 m (both ends sliding)
- R = qL/2 = **2 000 N** (each, up).
- M is parabolic: M_max = qL²/8 = **2 000 N·m** at x = 2 m, M = 0 at the ends.
- w_max = qL⁴/384EI = **0.04167 mm** at x = 2 m *(equal to the fixed–fixed UDL result, C2)*.

**E2. Fixed–guided, uniform load**, q = 1 000 N/m over 0→4 m (fixed at x = 0, sliding at x = 4)
- R = qL = **4 000 N** at x = 0; M_reaction = qL²/2 = **8 000 N·m** at x = 0.
- w_max (at the guided end) = qL⁴/384EI = **0.04167 mm** **[verify vs Timoshenko & Winkler]**.

### F — Point moments

**F1. Simply supported, central applied moment**, M0 = 5 000 N·m at x = 2 m, L = 4 m
- R = M0/L = **1 250 N** (each, opposite sign — a reaction couple).
- M_max = M0/2 = **2 500 N·m** (just inside the centre); M = 0 at the supports.
- w_max at the centre **[verify location vs Roark]**.

**F2. Cantilever, applied moment at the mid-point**, M0 = 5 000 N·m at x = 2 m, L = 4 m
- R = 0, M_reaction = M0 = **5 000 N·m** at x = 0; M = M0 on [0,2], M = 0 on [2,4].
- w_max = M0L²/8EI + M0·(L/2)²/2EI on the loaded half **[verify vs Roark]**.

### G — Multi-section (variable stiffness)

**G1. Simply supported, step in I at midspan, central point load** P = 10 000 N at x = 2 m,
L = 4 m; section 1 = [0, 2] with **I₁ = 4e-5 m⁴**, section 2 = [2, 4] with **I₂ = 8e-5 m⁴**
(E = 200 GPa, ν = 0.3, A = 0.01 m² each).
- R = P/2 = **5 000 N** (each); M_max = PL/4 = **10 000 N·m** at x = 2 m *(unchanged by the
  step, by symmetry)*.
- **w at centre = P·L³/(96E)·(1/I₁ + 1/I₂)**
   = 10 000·64/(96·200e9)·(1/4e-5 + 1/8e-5)
   = **1.25 mm**.
   *(Derived by virtual work; this is the key multi-section check — the deflection depends on
   both section stiffnesses.)*

**G1b. Consistency (equal sections)** — same as G1 but **I₁ = I₂ = 8e-5 m⁴**
- Must reduce to case **A1**: w_max = **0.8333 mm** at x = 2 m.
   *(If G1b ≠ A1, the section bookkeeping is wrong.)*

**G2. Stepped multi-section UDL** — preset **varsec** (two sections, different I, UDL q =
6 000 N/m). Check:
- Reactions and the moment at the section change are continuous; the curvature (second
  derivative) is *discontinuous* at the step — a visible kink in the deflection curve.
- Compare w_max to a fine single-section reference or Roark's stepped-beam table **[verify]**.

### H — Timoshenko shear-beam results

> The tool's exact Timoshenko element reproduces the **continuous** shear-beam solution at
> any mesh. Use **1 element/segment** for the exact check. The **Euler (bending) part is
> unambiguous**; the **shear term** is additive — verify its coefficient against your
> reference, as some texts use a different shear-area (κ) convention.
>
> Shear-area: `Aₛ = κ·A`; with the standard section `A = 0.05 m²`, `κ = 5/6`,
> `G = 76.923 GPa` ⇒ `κGA = 3.2051e9 N`.

**H1. Cantilever, tip point load**, P = 10 000 N, L = 1 m, A = 0.05 m² — preset **trim**
(then set L = 1, A = 0.05, P = 10 000, theory = Timoshenko)
- Euler part: w_bend = PL³/3EI = **0.20833 mm**.
- Shear part: w_shear = PL/κGA = **0.00312 mm**.
- **w_tip = 0.21145 mm**; φ_tip = PL²/2EI = **0.0003125 rad**.
- M_reaction = PL = **10 000 N·m**, R = **10 000 N**.
- Shear is ~1.5 % of the total — a small but measurable Timoshenko effect.
- **Cross-check:** switch to Euler–Bernoulli and the result must drop to **0.20833 mm**
   (the shear term vanishes). This isolates the shear contribution.

**H2. Cantilever, tip load, short/deep beam**, P = 10 000 N, **L = 0.3 m**, A = 0.05 m²
- w_bend = PL³/3EI = **5.625 µm**; w_shear = PL/κGA = **0.936 µm**.
- **w_tip = 6.561 µm** — shear is ~16.6 % of the total (shear clearly significant).

**H3. Simply supported, central load, short beam**, P = 10 000 N, **L = 0.5 m**, A = 0.05 m²
- w_bend = PL³/48EI = **1.628 µm**; w_shear = PL/4κGA = **0.390 µm**.
- **w_max = 2.018 µm** at x = 0.25 m; R = P/2 = **5 000 N**; M_max = PL/4 = **1 250 N·m**.
- Shear ~23 % of total — the most pronounced shear case in the suite.

**H4. Timoshenko vs Euler agreement (slender-beam limit)** — preset **udl** with the
*standard slender* section (I = 8e-5, A = 0.01, L = 4 m ⇒ L/h ≈ 40).
- The Euler and Timoshenko w_max must agree to within the shear correction
   (≲ 0.1 %). This confirms the shear term vanishes correctly for slender beams.

---

## 6. Coverage summary

| Requirement | Cases |
|-------------|-------|
| End conditions: free, pinned, sliding, fixed | A (pinned–pinned), B (fixed–free), C (fixed–fixed), E (guided), B3/F2 (free tip w/ moment) |
| Load: point force | A1, A3, B1, C1, G1 |
| Load: point moment | B3, C3, F1, F2 |
| Load: uniform distributed | A2, B2, C2, E1, E2, G2 |
| Load: linear/triangular distributed | A4 |
| Overhang / intermediate support | D1, D2 |
| Multi-section (variable I) | G1, G1b, G2 |
| Timoshenko shear results | H1, H2, H3, H4 |
| Statics / equilibrium checks | D2, G1 (ΣR, M=0 at simple supports) |

**Total: 22 cases (A1–A4, B1–B3, C1–C3, D1–D2, E1–E2, F1–F2, G1/G1b/G2, H1–H4).**

---

## 7. Results recording template

Copy one block per case and fill in the tool's measured value and the error.

```
Case ____   (theory: Euler / Timoshenko, mesh ___ el/seg)
  Quantity            Ref.            Tool         Err.%
  Reaction R (each)   __________      __________   ______
  Reaction M          __________      __________   ______
  M_max @ x=          __________      __________   ______
  w_max @ x=          __________      __________   ______
  Max rotation        __________      __________   ______
  Max shear V         __________      __________   ______
  Max stress σ        __________      __________   ______
  PASS (<0.1%)?  [ ]   Notes: __________
```

---

## 8. Notes on the reference values

- All deflection/moment/reaction values are the standard closed-form results from the
  sources in §2, evaluated with the material/section in §4.
- Items marked **[verify]** are locations or values where the standard reference tables are
  less commonly tabulated; confirm against Roark/Gere before accepting a mismatch.
- The **shear term** in the Timoshenko cases (H) is derived for the **constant-shear-strain
  exact element** the tool uses; if a reference uses a different shear-area convention, the
  shear *coefficient* may differ — compare the **Euler part** (unambiguous) as the primary
  check and the shear contribution as a secondary one.
