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

### 1.4 Failure Criteria

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

### 3.5 Key Decisions — TC23

- **SIF model**: Full NASGRO TC23 compounding (A1 × A2 × A3) from Appendix C.
  A1 uses β_r (Bowie polynomial) and β_u (unequal crack correction).
- **Finite-width**: φ₁/φ₂ corrections for both crack-edge and hole-edge
  interactions, applied per-tip with correct near/far assignments.
- **Dual-crack tracking**: Engine independently tracks c₁ and c₂.
- **Net section yield**: Uses total section loss (D + c₁ + c₂).
- **Loading**: S₀ (remote tension) only. S₂ (bending), S₃ (pin) not yet implemented.

---

## 4. Material Properties

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

## 5. References

1. Newman, J.C. Jr. — "A crack opening stress equation for fatigue crack growth",
   Int. J. Fracture, 1984
2. Bowie, O.L. — "Analysis of an infinite plate containing radial cracks originating
   at the boundary of an internal circular hole", J. Math. Phys., 1956
3. Feddersen, C.E. — "Discussion of plane strain crack toughness testing", ASTM STP 410, 1967
4. Isida, M. — "Stress intensity factors for the tension of an eccentrically cracked
   strip", J. Appl. Mech., 1966
5. NASGRO Reference Manual, SwRI
6. Tada, H., Paris, P.C., Irwin, G.R. — "The Stress Analysis of Cracks Handbook",
   3rd ed., ASME Press, 2000
