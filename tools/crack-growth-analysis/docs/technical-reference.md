# SCT-CG1 Technical Reference
## Crack Growth Analysis — Formulae & Key Decisions

This document records all stress intensity factor (SIF) solutions, NASGRO equation
components, and key engineering decisions used in the SCT-CG1 crack growth tool.

---

## 1. NASGRO Crack Growth Equation

The growth rate per cycle is:

```
da/dN = C · [ (1-f)/(1-R) · ΔK ]ⁿ · [ (1 - ΔKth/ΔK)ᵖ / (1 - Kmax/Kc)ᵠ ]
```

| Symbol | Description | Units |
|--------|-------------|-------|
| C, n   | Paris-law constants (material-dependent) | in/cycle, — |
| p, q   | Exponents controlling threshold and instability tails | — |
| R      | Stress ratio (σ_min / σ_max) | — |
| ΔK     | Stress intensity factor range = Kmax(1-R) | ksi√in |
| Kmax   | Maximum SIF at peak load | ksi√in |
| ΔKth   | Threshold SIF range (no growth below this) | ksi√in |
| Kc     | Fracture toughness at thickness t | ksi√in |
| f      | Newman crack opening ratio (Kop/Kmax) | — |

### 1.1 Newman Crack Closure Function

Determines the effective stress range by accounting for crack-face contact:

```
For R ≥ 0:   f = max(R, A₀ + A₁·R + A₂·R² + A₃·R³)
For R < 0:   f = max(A₀ + A₁·R, 0)
```

Coefficients (functions of constraint factor α and stress level Smax/σ₀):

```
A₀ = (0.825 - 0.34α + 0.05α²) · cos^(1/α)(π·Smax_σ₀ / 2)
A₁ = (0.415 - 0.071α) · Smax_σ₀
A₃ = 2A₀ + A₁ - 1
A₂ = 1 - A₀ - A₁ - A₃
```

**Key decision**: α ranges from 1 (plane stress) to 3 (plane strain). For thin
aircraft sheet (t < 0.125 in), α ≈ 2.0 is typical. For thick plate, α → 3.

### 1.2 R-Dependent Threshold (ΔKth)

The threshold fans with R-ratio:

```
ΔKth = ΔK₁ · [ (1-f) / (1-A₀) ]^(1 + Cth·R)
```

where:
- ΔK₁ = threshold at high R (material property)
- Cth = Cth+ for R ≥ 0, Cth- for R < 0
- R is clamped to [-2, 0.7] for this calculation
- f and A₀ are from the Newman closure function

### 1.3 Thickness-Dependent Fracture Toughness (Kc)

Plane-strain toughness K₁c is adjusted for actual thickness:

```
Kc = K₁c · (1 + Bk · exp(-(Ak·t / t₀)²))

t₀ = 2.5 · (K₁c / σys)²
```

where Ak, Bk are material parameters controlling the thinning effect.
For thin sheet, Kc > K₁c (less constraint → more toughness).

### 1.4 Plastic Zone Correction Modes

The Irwin correction (rₑ = K²/(2απσ_flow²), two fixed-point iterations on the
effective crack length) has three modes:

- **On at ligament yield** (default): the correction activates per crack tip
  only once the net-section stress in the ligament between that tip and the
  free edge it grows toward reaches the material yield stress. For TC23-type
  geometries the per-tip ligament stress is σ·m/(m−R−c₂) (right) and
  σ·B/(B−R−c₁) (left), with σ the gross stress including the bearing
  contribution. Activation is marked in the log (`PZC ON`). This matches the
  observed end-of-life-only plasticity treatment of the external benchmark
  code.
- **Always on**: correction applied at every cycle (previous behaviour;
  conservative, ≈9% life reduction in the benchmark cases).
- **Off**: pure LEFM.

### 1.5 Failure Criteria

The analysis terminates when any of:
1. **Fracture**: Kmax ≥ Kc at either crack tip
2. **Net section yield**: Net-section stress ≥ σys
3. **Geometry limit**: Crack exceeds 95% of available ligament
4. **Max cycles**: Analysis reaches the user-specified cycle limit

---

## 2. TC01 — Through Crack at Center of Plate

### 2.1 Geometry

A center through-thickness crack of total length 2a in a flat plate of width W.

```
    ├──────────── W ────────────┤
    │                           │
    │         ←── 2a ──→        │
    │        ┼╌╌╌╌╌╌╌╌╌┼       │
    │                           │
    │           ↑ σ ↑           │
```

### 2.2 SIF Solution (Feddersen / Isida)

```
K = σ · √(πa) · β

β = √[ sec(πa / W) ]
```

This is the Feddersen secant correction to the infinite-plate solution.
Valid for a/W < 0.95 (within 0.3% of Isida's exact solution up to a/W ≈ 0.8).

### 2.3 Net Section Stress

```
σ_net = σ · W / (W - 2a)
```

### 2.4 Key Decisions — TC01

- **Isida vs Feddersen**: Feddersen secant formula chosen for simplicity. At a/W = 0.8
  the error vs Isida exact is < 0.3%. Sufficient for DTA.
- **Geometry limit**: Analysis stops at a/W = 0.95 (single-sided).
- **Loading**: S0 (remote tension) only. S1 (bending) to be added in future.

---

## 3. TC23 — Unequal Through Cracks at Offset Hole

*Reference: NASGRO Reference Manual, Appendix C — Crack Case TC23*

### 3.1 Geometry

Two diametric through-thickness cracks of sizes c₁ (left) and c₂ (right),
measured from hole edges, at a possibly offset hole in a finite-width plate.

```
    ├──────────────── W ────────────────┤
    │                                   │
    │       ← c₁ →  ○─○  ← c₂ →       │
    │    ├── B ──→   (D)                │
    │                                   │
    │           ↑ σ (S₀) ↑              │
```

| Parameter | Formula |
|-----------|---------|
| R         | D / 2 |
| B         | W/2 + e₀  (hole center to left plate edge) |
| c₀        | (c₁ + D + c₂) / 2  (half total flaw, tip-to-tip) |
| b         | B + (c₂ − c₁) / 2  (flaw center to left edge) |

### 3.2 SIF Solution — Compounding Scheme (Solution A, S₀ Loading)

```
K_i = β_i^A · S₀ · √(π·c_i)

β_i^A = β_i^{A1} · β_i^{A2} · β_i^{A3}
```

#### Solution A1 — Unequal Cracks at Hole in Infinite Plate

Closed-form fit of Tweed & Rooke solution (NRC of Canada, ref [C58]):

```
β_i^{A1} = β_r(ρ_i) · β_u(γ_other, γ_this) · √(2c₀ / (c_i + D))

γ_i = c_i / R          ρ_i = c_i / (c_i + R) = γ_i / (γ_i + 1)
```

**β_r(ρ)** — Bowie solution for two equal symmetric cracks (7-term polynomial):

```
β_r(ρ) = Σ R_k · ρ^k,  k = 0..6

R = { 3.364500, -7.209304, 8.230965, -3.500286, -2.923363, 4.306705, -1.562110 }
```

- ρ → 0 (short cracks): β_r → 3.3645 ≈ Kt for a hole
- ρ → 1 (long cracks): β_r → 0.707 (center crack limit)

**β_u(γ_a, γ_b)** — Unequal crack correction (15-coefficient rational function):

```
β_u = (D₀ + D₁γ_a + D₂γ_a² + D₃γ_b + D₄γ_b² + D₅γ_aγ_b + D₆γ_a²γ_b + D₇γ_aγ_b²)
    / (1 + D₈γ_a + D₉γ_a² + D₁₀γ_b + D₁₁γ_b² + D₁₂γ_aγ_b + D₁₃γ_a²γ_b + D₁₄γ_aγ_b²)
```

For tip i:  γ_a = γ_other (opposing crack),  γ_b = γ_this.
Error < 1% for c/R ≤ 500, < 2.7% for c/R ≤ 6400.

#### Solutions A2, A3 — Finite-Width Corrections

Corrections for crack-edge (A2) and hole-edge (A3) interaction, using φ₁ (near-edge)
and φ₂ (far-edge) functions:

```
φ₁(μ,ω) = [λ_s + (1−λ_s)/4·(1 + cos^0.25(λ₁))²] · √sec(λ₁)
φ₂(μ,ω) = 1 + (√sec(λ₁₂) − 1) / (1 + 0.21·sin(8·arctan(|λ₁−λ₂|/(λ₁+λ₂))^0.9))

λ₁ = πμ/(2ω),  λ₂ = πμ/(2W−2ω),  λ₁₂ = 4λ₁/7 + 3λ₂/7,  λ_s = sin(πλ₂/(λ₁+λ₂))
```

A2 (crack-edge): μ = c₀, ω = b.
A3 (hole-edge): μ = R, ω = B.  Tip assignments per NASGRO Appendix C.

### 3.3 Net Section Stress

Uses total material removed from the cross-section:

```
σ_net = σ · W / (W − D − c₁ − c₂)
```

Both cracks and the hole reduce the load-bearing width.
Failure when σ_net ≥ σys.

### 3.4 Dual-Crack Growth

When c₁ ≠ c₂ or e₀ ≠ 0, the two crack tips grow at different rates:

1. Compute K₁, K₂ independently each cycle (compounded β per tip)
2. Compute da/dN₁, da/dN₂ from NASGRO equation
3. Use adaptive Δc increment (based on proximity to fracture)
4. Advance each crack: cᵢ_new = cᵢ + (da/dN_i) · ΔN
5. Failure when either Kᵢ ≥ Kc

### 3.5 Post-Link-Up SENT Phase — SIF Solutions

When the right ligament fails (c₂ reaches the plate edge), the geometry transitions
to a single-edge-notch tension (SENT) crack growing from the right plate edge.
The total edge crack length is:

```
a_edge = c₁ + D + (W/2 − e₀ − R)
```

Three load contributions are superposed via K_total = K_tension + K_bending + K_bearing.

#### Tension (S₀) and Bearing (S₃)

Both use the membrane SENT beta (Tada/TPI, η-interpolated):

```
K_tension = S₀ · √(πa) · β_SENT(a/W, η)
K_bearing = (D/W) · S₃ · √(πa) · β_SENT(a/W, η)
```

#### In-plane Bending (S₂) — NASGRO TC02 Solution B

S₂ is treated as an in-plane bending stress (extreme-fibre value at the cracked
cross-section, = 6M/BW²) using the NASGRO TC02 Solution B beta factor:

```
K_bending = S₂ · √(πa) · F_B(a/W)

F_B(λ) = 1.122 − 1.40λ + 7.33λ² − 13.08λ³ + 14.0λ⁴
```

Attributed to Gross & Srawley (1965), NASA TN D-2603, via Tada, Paris & Irwin.
The formula integrates the linear bending stress distribution across the section
internally; S₂ (the extreme-fibre value) is passed in directly.

**Sign convention (per NASGRO TC02)**: S₂ > 0 puts tension at the crack mouth,
opening the crack. After link-up, the SENT crack mouth is at the right plate edge.
The TC23 two-crack-phase convention (S₂ > 0 = tension on right face) is directly
consistent: positive S₂ opens the SENT crack for any e₀. S₂ is therefore passed
with its sign and always added (positive S₂ increases K).

**Why F_B is separate from β_SENT**: Bending produces a linear stress distribution;
membrane tension is uniform. F_B integrates the linear distribution and is a
different function of a/W from the membrane β_SENT. The two must not be conflated.
A previous (incorrect) implementation folded S₂ into the membrane stress with a
hardcoded subtraction, which was wrong in sign for offset geometries and wrong in
magnitude in all cases.

### 3.6 Bearing β Model Options (Solution C)

Two selectable models for the pin-load/bearing beta (`Bearing β Model` input):

**NASGRO TC23 Solution C** (default): the Appendix C compounding
βC = ½(βC1+βC2+βC3) with the C2 chain modelling the pin load as a point
wedge force on the crack faces (the W/πc₀ term in C2:3). Verified
term-by-term against the NASGRO 8.2 Appendix C manual (pp. C-41…C-43),
including the e = W/2 − B eccentricity convention. The point-force
idealisation is asymptotically correct for cracks long relative to the hole
(c ≳ 2D) but **conservative at short cracks** — the real distributed
bore-pressure field decays much faster than the point-force field. Industry
FEM benchmarking shows the same signature for analytical bearing betas
(AFGROW 2016 European workshop, Harter & Litvinov: analytical β ≈ 3× FEM at
c = 0.2D, converging with crack growth).

**Hybrid TC05 FEM → TC23**: uses the NASGRO TC05 FEM pin-load beta tables
(Table C7, two cracks at a loaded hole) at short cracks, where the FEM data
correctly captures the local bore-field decay, blending linearly in c/D to
the TC23 Solution C between c = 0.5D and c = D, beyond which the point-force
model takes over and carries the offset-hole/finite-width effects absent
from the TC05 geometry:

```
bp(c) = (1−T)·F3_TC05(c/(W−D), D/W) + T·(D/W)·βC_TC23(c),
T = clamp((c/D − 0.5)/0.5, 0, 1)
(band override: params.blendLo / params.blendHi, in c/D)
```

The strip of width W is mapped to the TC05 hole row at pitch H = W (the
standard strip↔row equivalence); D/H and x are clamped to the table ranges.
Continuity of bp(c) through the transition band is regression-tested.

**Effective width (W_eff = 7D)**: treats the transferred load as reacted
locally — applied loads spread from the hole at ~35° (Inglis), so the
bearing load is carried across an effective width of a few diameters rather
than the full panel:

```
bp(c) = (D/W_eff)·βA(c),   W_eff = min(kBrg·D, W),   kBrg = 7 (override via params.kBrg)
```

This reproduces the bearing betas of the external benchmark code (V1Aerospace)
within a few percent at short-to-mid crack lengths in two benchmark cases
(W=2/m=0.4 and W=4/m=1.5: BP/BS ≈ 0.143 ≈ 1/7, width-independent), and is
consistent with the local-reaction guidance in the AFGROW 2016 workshop
(hole within ~6D of edges for bearing). The benchmark's beta decays somewhat
faster than βA·(D/W_eff) at longer cracks, so lives agree within ~4–15%.

### 3.7 Key Decisions — TC23

- **SIF model**: Full NASGRO TC23 compounding (A1 × A2 × A3) from Appendix C.
  A1 uses β_r (Bowie polynomial) and β_u (unequal crack correction).
- **Finite-width**: φ₁/φ₂ corrections for both crack-edge and hole-edge
  interactions, applied per-tip with correct near/far assignments.
- **Dual-crack tracking**: Engine independently tracks c₁ and c₂.
- **Net section yield**: Uses total section loss (D + c₁ + c₂).
- **Loading**: S₀ (remote tension), S₂ (bending), S₃ (pin/bearing) all implemented.
- **SENT bending beta**: Uses NASGRO TC02 Solution B polynomial F_B(a/W)
  (Gross & Srawley 1965 / Tada-Paris-Irwin) for the S₂ contribution in the
  post-link-up phase.  F_B is physically distinct from the membrane β_SENT and
  must be applied separately.  S₂ enters with a positive sign (S₂ > 0 opens the
  SENT crack, per TC02 convention, consistent with the TC23 two-crack-phase sign).

---

## 4. TC23B — Cracked Stringer at Hole with Skin Bridging

*Extends TC23 for a stringer (modelled by its unfolded width) attached to a
fuselage skin by a single vertical row of fasteners through the critical hole.*

### 4.1 Configuration

The cracked plate is the stringer; the crack is at a fastener hole in the
attachment row. The fasteners run in the load direction at user-defined pitch
p, connecting the stringer to a background **infinite** skin. As the crack
opens, fasteners above and below the crack plane transfer load into the intact
skin, restraining the crack-opening displacement and retarding growth.

```
        │ σ (stringer)
   ╔════╪════╗
   ║    ●    ║   ● fasteners at pitch p (vertical line
   ║    ●    ║     through the critical hole), attached
   ║ ──╴○╶── ║     to a background infinite skin
   ║    ●    ║   ○ critical hole + cracks c₁, c₂
   ║    ●    ║
   ╚════╪════╝
        │ σ
```

### 4.2 Method — Swift Displacement Compatibility

The bridging analysis follows the displacement-compatibility method of Swift
(stiffened panel / repair analysis). With fastener pair forces F (one fastener
above and its mirror below the crack plane, by symmetry), compatibility at
each fastener location requires:

```
[ f·I + G_str + G_sk ] · F  =  V₀ · σ
```

| Term | Meaning |
|------|---------|
| f | fastener shear flexibility (modified Tate & Rosenfeld, §4.3) |
| V₀(y_j) | crack-induced opening of the stringer at fastener j under remote σ (Westergaard field, plane stress) |
| G_str(i,j) | reduction of stringer opening at i per unit restraining pair at j, in the cracked sheet |
| G_sk(i,j) | stretch of the intact infinite skin at i per unit reacted pair at j (2-D Kelvin point-force field) |

The cracked-sheet influence G_str is computed exactly as the sum of the
uncracked Kelvin field and a crack-release correction obtained from the
Betti/Rice weight-function identity:

```
v_corr(i,j) = −(t₁/E₁) · ∫₀^a [ K₊ᵢ(a′)K₊ⱼ(a′) + K₋ᵢ(a′)K₋ⱼ(a′) ] da′
```

where K±ⱼ(a′) is the centre-crack SIF Green's function of fastener pair j,
evaluated by Bueckner superposition of the Kelvin crack-line stress through
the centre-crack weight functions:

```
K± = (1/√(πa)) ∫ σ_yy^pair(x,0) · (a ± x)/√(a² − x²) dx
```

Kelvin self-influence uses a cutoff radius d/2 (deformation inside the cutoff
is represented by the empirical fastener flexibility).

**SIF reduction — load bypass.** The displacement-compatibility solve gives
the equilibrium fastener loads F_j. The bridging then reduces K through the
load-bypass mechanism: the load shed into the skin bypasses the crack
section, so the membrane stress reaching the crack is the bypass stress.

```
P_applied = S_gross · W · t                 (total stringer load, S_gross = σ + (D/W)·S₃)
P_total   = Σ_j F_j(a) − Σ_j F_j(0)          (crack-driven bypassed load, one side)
S_bypass  = S_gross · (P_applied − P_total) / P_applied
R_bypass  = S_bypass / S_gross = 1 − P_total / (S_gross · W · t)   (clamped [0.05, 2])

K_bridged = R_bypass · K_tension + K_bending + K_bearing
```

Only the membrane (tension) contribution to K is scaled by R_bypass; the
in-plane bending (S₂) and pin-bearing (S₃) contributions are separate load
paths and are not bypassed. Because the fastener loads scale with the remote
stress, P_total/(S_gross·W·t) is stress-independent, so R_bypass and the
constant-amplitude life are stress-independent. Each F_j is the upper fastener
of pair j (the lower returns the load below the crack), so Σ_j F_j is the
one-sided transferred load. R_bypass > 1 (load attraction) is admitted when the
skin is strained more than the stringer.

**No-crack baseline.** P_total subtracts the no-crack value Σ_j F_j(0). The
far-field strain mismatch (biaxial/hoop skin stress, §4.4) drives distributed
stringer↔skin load-sharing that exists with **no crack present** and therefore
does not bypass the crack — it is a global load-share already represented in the
input stringer stress. Subtracting the baseline leaves only the crack-driven
increment as the bypassed load (and removes a finite-fastener-row artefact, in
which the raw Σ_j F_j grows with the number of modelled fasteners). The baseline
is identically zero in strain-matched mode.

This replaces the earlier weight-function crack-face-traction reduction
(R = (√(πc₀) + Σ F_j·K_tip,j)/√(πc₀)), which is still computed in bridging.js
as a diagnostic. Applying both would double-count the same fastener loads:
the bypass route is the global load-path statement, the weight-function route
is the local crack-tip-shielding statement, and they account for the *same*
F_j. The compatibility solve itself is unchanged — it uses the rigorous
crack-release compliance to obtain the correct equilibrium F_j; only the
K-from-F_j step changed.

- **Two-crack phase**: effective centre crack 2c₀ = c₁ + D + c₂; the fastener
  line is taken through the flaw centre (exact for c₁ = c₂).
- **SENT phase**: the edge crack a_edge is modelled as a half centre crack
  (model centre at the right plate edge) with the fastener line at depth m and
  free-edge image sources at −m; the skin sees the real forces only. P_applied
  still uses the full stringer section W·t.

**Reporting convention.** The bypass is applied to the membrane *stress*, not
folded into β: the analysis-log β columns are the pure TC23 geometry SIF
factors, and the reduction appears in a separate `Sbyp/S₀` column, so that
K = β · (Sbyp/S₀)·S₀ · √(πc) on the membrane term. This matches standard DTA
practice (β = geometry factor, stress carries the load magnitude) and keeps the
bypass visible.

### 4.3 Fastener Flexibility — Modified Tate & Rosenfeld

```
f = 0.375/(Ef·t₁) + 0.375/(Ef·t₂)              (fastener bearing on holes)
  + 0.9/(E₁·t₁)   + 0.9/(E₂·t₂)                (sheet hole compliance)
  + 32(1+νf)(t₁+t₂)/(9·Ef·π·d²)                (fastener shear)
  + 8(t₁³+5t₁²t₂+5t₁t₂²+t₂³)/(5·Ef·π·d⁴)       (fastener bending)
```

Units: ksi, in → f in in/kip. Sheet 1 = stringer, sheet 2 = skin.

### 4.4 Biaxial Skin Stress (Poisson Mismatch)

The skin may carry an off-axis biaxial far-field stress state (e.g., fuselage
hoop + longitudinal). The skin's longitudinal strain is then

```
ε_skin,y = (σ_L − ν_skin·σ_H) / E_skin
```

so tensile hoop stress σ_H contracts the skin longitudinally (Poisson),
creating a far-field strain mismatch with the stringer that increases the
fastener load transfer. The mismatch enters the compatibility system as an
additional relative slip, measured from the crack plane (symmetric datum):

```
[ f·I + G_str + G_sk ] · F  =  V₀·σ + Δε·y

Δε/σ = 1/E_str − (σ_L − ν_skin·σ_H)/(E_skin·σ̂_max)
```

**Proportional loading assumption**: σ_L and σ_H are specified at the peak
stringer stress σ̂_max and are assumed to scale proportionally with the
stringer stress through the cycle (the standard pressurization-cycle
assumption). This keeps fastener loads linear in σ and the restraint ratio
stress-independent, consistent with the constant-amplitude engine.

Modes:
- **Strain-matched** (default): Δε = 0, bridging from crack opening only —
  the stringer and skin far-field edges are effectively coincident.
- **Strain-matched + hoop (Poisson)**: longitudinal strain compatibility is
  retained and only the hoop stress is specified:
  Δε/σ = ν_skin·σ_H/(E_skin·σ̂). This is the intended fuselage case — hoop
  tension contracts the skin via Poisson, increasing fastener load transfer
  and crack restraint.
- **Fully specified (σ_L, σ_H absolute)**: Δε/σ = 1/E_str −
  (σ_L − ν_skin·σ_H)/(E_skin·σ̂). Use when the skin operates at a known,
  different stress level. Equivalent to the hoop mode when
  σ_L = σ̂·E_skin/E_str. A skin strained *more* than the stringer (large σ_L)
  reverses the mismatch sign.

**Interaction with the load-bypass K reduction (important).** Under the
load-bypass model (§4.2), the strain mismatch enters only through the
crack-driven increment P_total = Σ_j F_j(a) − Σ_j F_j(0). The mismatch's
*primary* action is a uniform far-field load-share between stringer and skin
that exists with no crack — this is the no-crack baseline that is subtracted,
because it is already represented in the input stringer stress σ̂. What remains
(the coupling between crack opening and the mismatch field) is a small,
second-order effect. **Consequently, under the bypass route the biaxial/hoop
skin stress has only a minor effect on predicted crack-growth life** — within a
few percent in typical cases — in contrast to its large apparent effect under
the earlier weight-function reduction. If a designer wants the hoop/biaxial
load-share to retard the crack as a first-order effect, that must be applied as
a reduction of the input far-field stringer stress σ̂ (a separate stiffness-ratio
load-sharing calculation this tool does not perform), not through the
crack-bypass mechanism.

Note: with a mismatch present, the *outermost* fasteners of the finite row
carry joint end-transfer loads that depend on the row length n; the
near-crack loads and the SIF restraint are insensitive to n. Size n to cover
the physical joint when the biaxial option is used with a fastener allowable.

### 4.5 Outputs and Checks

- Fastener pair loads F_j·σ are reported in the analysis log at the final
  crack size, with the peak load over the whole run.
- An optional fastener shear allowable flags exceedance. **Fastener failure
  is not progressively modelled** — beyond first exceedance the bridging
  restraint is unconservative; bound the result with bridging off.

### 4.6 Assumptions / Key Decisions — TC23B

- Bridging influence functions use **infinite-sheet** elastic fields for the
  stringer; finite width enters through the TC23 β factors (standard
  compounding approximation).
- In strain-matched mode the skin and stringer share the same far-field
  strain (no pre-existing joint load transfer) and bridging forces arise from
  crack opening only; the biaxial option (§4.4) adds the Poisson-driven
  far-field mismatch. Bearing load transfer at the critical hole can still
  be applied via S₃.
- The fastener in the cracked hole lies on the crack plane and transfers no
  bridging load; the row is j = 1..n each side at y = ±j·p.
- Plane stress throughout; restraint ratio is identical at both tips
  (two-crack phase, symmetric model).
- Net-section yield checks ignore the load shed to the skin (conservative).
- Verified against: central wedge-force limit of the SIF Green's function,
  half-plane equilibrium of the Kelvin field, strain-consistency of the
  Kelvin displacement field, Betti reciprocity of the influence matrix, and
  an independent closed-form ↔ K-integral cross-check of the opening
  displacement (see `tests/run-tests.mjs`).

---

## 5. Material Properties

Default materials stored in Imperial units (ksi, in):

| Property | 2024-T3 Sheet | 7075-T6 Sheet | Description |
|----------|:---:|:---:|-------------|
| C | 8.0e-9 | 4.0e-9 | Paris coefficient (in/cycle) |
| n | 3.2 | 3.1 | Paris exponent |
| p | 0.25 | 0.25 | Threshold exponent |
| q | 1.0 | 0.5 | Instability exponent |
| ΔK₁ | 1.2 | 1.5 | Threshold at high R (ksi√in) |
| Cth+ | 2.0 | 1.5 | Threshold fanning coeff (R ≥ 0) |
| Cth- | 0.1 | 0.1 | Threshold fanning coeff (R < 0) |
| K₁c | 30 | 26 | Plane-strain fracture toughness (ksi√in) |
| Ak | 1.0 | 1.0 | Kc thickness parameter |
| Bk | 1.5 | 1.0 | Kc thickness parameter |
| σys | 53 | 68 | Yield strength (ksi) |
| σult | 70 | 78 | Ultimate strength (ksi) |
| α | 2.0 | 2.5 | Constraint factor |
| Smax/σ₀ | 0.3 | 0.3 | Max stress / flow stress ratio |

---

## 6. References

1. Newman, J.C. Jr. — "A crack opening stress equation for fatigue crack growth",
   Int. J. Fracture, 1984
2. Bowie, O.L. — "Analysis of an infinite plate containing radial cracks originating
   at the boundary of an internal circular hole", J. Math. Phys., 1956
3. Feddersen, C.E. — "Discussion of plane strain crack toughness testing", ASTM STP 410, 1967
4. Isida, M. — "Stress intensity factors for the tension of an eccentrically cracked
   strip", J. Appl. Mech., 1966
5. NASGRO Reference Manual, SwRI — Crack Case TC02 (Through Crack at Edge,
   Solutions A/B/C for tension, bending, and bearing)
6. Tada, H., Paris, P.C., Irwin, G.R. — "The Stress Analysis of Cracks Handbook",
   3rd ed., ASME Press, 2000
7. Gross, B., Srawley, J.E. — "Stress-Intensity Factors for Single-Edge-Notch
   Specimens in Bending or Combined Bending and Tension by Boundary Collocation
   of a Stress Function", NASA TN D-2603, 1965
8. Swift, T. — "Fracture Analysis of Stiffened Structure", in Damage Tolerance
   of Metallic Structures, ASTM STP 842, 1984 (displacement-compatibility
   method for fastener-bridged cracks)
9. Swift, T. — "Repairs to Damage Tolerant Aircraft", FAA-AIR-90-01, 1990
10. Tate, M.B., Rosenfeld, S.J. — "Preliminary Investigation of the Loads
    Carried by Individual Bolts in Bolted Joints", NACA TN-1051, 1946
    (fastener flexibility; the modified form with 0.375/0.9 hole-compliance
    numerators is used here)
11. Muskhelishvili, N.I. — "Some Basic Problems of the Mathematical Theory of
    Elasticity" (point-force potentials used for the Kelvin influence fields)
12. Rice, J.R. — "Some Remarks on Elastic Crack-Tip Stress Fields", Int. J.
    Solids Structures, 1972 (weight-function relation used for the
    crack-release compliance integrals)
