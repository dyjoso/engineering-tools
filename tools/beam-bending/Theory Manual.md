# Beam Calculator — Theory Manual

Finite-element transverse-beam solver implemented in `index.html`. It solves the
Euler–Bernoulli (classical) and Timoshenko (shear-deformable) beam equations by a
two-node FEM, reports deflection, slope/rotation, shear force, bending moment,
reactions and bending stress, and runs entirely offline in a single HTML file.

This manual describes **what the code does**. The companion **Validation Manual**
gives a suite of analytical reference cases to check it against.

---

## 1. Scope and assumptions

- **Plane transverse loading** only: loads are transverse forces, point moments, and
  distributed (linearly-varying) forces. No axial loading.
- **Straight, prismatic-within-a-section** beam. Stiffness may vary from one
  *section* to the next (variable `E`, `I`, `A`, `ν`, `G`, `κ`); within a section the
  material/section properties are constant.
- **Linear-elastic, small-deflection.** Superposition holds; the solution is
  independent of load magnitude.
- **Static**, no dynamics or large-deflection effects.
- A model with no vertical/rotational restraint (e.g. all ends free with no intermediate
  support) is a **rigid-body mechanism** and is reported as *unstable* (the solver refuses
  it). At least one translation or rotation must be restrained.

---

## 2. Governing theory

The beam has two nodal degrees of freedom per node:

- **w** — transverse deflection (positive **down**),
- **θ / φ** — rotation of the cross-section (positive **counter-clockwise**).
  In Euler–Bernoulli theory θ = dw/dx (slope). In Timoshenko theory φ is the
  cross-section rotation, which differs from the slope dw/dx because of shear.

### 2.1 Euler–Bernoulli (classical)

No shear deformation: the cross-section stays plane and normal to the deflection curve,
so φ = dw/dx and the displacement field is a single cubic per element.

Governing equation:

    d²/dx² ( EI · d²w/dx² ) = q(x)

with the moment–curvature relation M = EI·w'' and shear V = dM/dx.

### 2.2 Timoshenko (shear-deformable)

Adds shear deformation through the shear area Aₛ = κ·A and shear modulus G. The
cross-section rotation φ and the slope w' are independent, related by the shear strain:

    κGA · ( dw/dx − φ ) = V

with M = EI·φ'. This is the **shear-rigid / exact** formulation with **constant shear
strain** within each element, so a single element spans a distributed load exactly
(no spurious shear locking, no "soft" single-element UDL as in the classical element).

`G` is derived as `E / (2(1+ν))` when left blank; `κ` defaults to `5/6` (rectangular
section) when blank.

---

## 3. Finite-element formulation

### 3.1 Element and degrees of freedom

Two-node element, 4 DOF `[w₀, θ₀, w₁, θ₁]`. The node numbering is sequential along the
beam; global DOF index of node *n* is `[2n]` (w) and `[2n+1]` (rotation).

### 3.2 Shape functions

**Euler–Bernoulli** — cubic Hermite (standard), in local coordinate `s = (x−x₀)/L`:

```
N₁ = 1 − 3s² + 2s³
N₂ = L·s·(1−s)²
N₃ = 3s² − 2s³
N₄ = L·s²·(s−1)
```

Curvature is `w'' = N₁''·w₀ + N₂''·θ₀ + N₃''·w₁ + N₄''·θ₁` (the second derivatives of
the shape functions times the nodal DOF), which yields the classical beam element.

**Timoshenko** — exact (shear-corrected) shape functions. The code inverts a 4×4 system
(`timoShapes`) to obtain the deflection and rotation shape coefficients, then integrates
them to form the stiffness matrix (`timoKe`). The closed-form stiffness is:

```
bend  = EI·[ (4/3)·aᵢaⱼ·L³ + (aᵢbⱼ + aⱼbᵢ)·L² + bᵢbⱼ·L ]
shear = 4·EI²·aᵢaⱼ·L / (κGA)
Kᵢⱼ  = bend + shear
```

where `aᵢ, bᵢ` are the first two coefficients of the exact shape function for DOF *i*.
This is the **exact Timoshenko element**: it reproduces the continuous Timoshenko solution
to machine precision at any mesh.

### 3.3 Element stiffness

**Euler–Bernoulli** — the classical 4×4 (scaled by `EI/L³`):

```
[ 12,   6L, −12,   6L ]
[  6L, 4L², −6L,  2L² ]
[ −12, −6L,  12, − 6L ]
[  6L, 2L², −6L,  4L² ]
```

### 3.4 Load vector

- **Point force `P`** and **point moment `M`** are applied at the node nearest their
  location `x` (`nearestNode`).
- **Distributed load** `q(x)` (linear from `q_a` at `a` to `q_b` at `b`) is condensed to
  equivalent nodal forces by **Gauss quadrature** (5-point by default) over the overlap
  of the load span and the element, using the appropriate shape functions (`eulerShapeW`
  or `timoShapeWvals`). `q(x) = q_a + (q_b−q_a)(x−a)/(b−a)`.

All loads are **downward-positive**.

### 3.5 Assembly

Global stiffness `K` and load `F` are assembled element-by-element into a banded system
(half-bandwidth 3, i.e. 6 DOF). `K` and `F` are snapshotted (`Korig`, `Forig`) before the
boundary conditions are applied, so reactions can be recovered afterwards.

### 3.6 Boundary conditions

Each end and each intermediate support carries one of four conditions:

| Condition        | Restrained DOF                |
|------------------|-------------------------------|
| `free`           | none                          |
| `pinned` (roller/hinge) | w only               |
| `sliding` (guided)      | rotation only            |
| `fixed` (clamp)         | w and rotation         |

A restrained DOF `d` is imposed by the **penalty/unit-diagonal** method: the row/column of
`K` is zeroed and `K[d][d] = 1`, `F[d] = 0`, and `d` is recorded in `constrained`.

### 3.7 Solver

`bandedCholesky(K, F, half)` solves the symmetric positive-definite banded system with an
in-place Cholesky factorisation (only the lower half-band stored, `half = 3`), followed by
forward and back substitution. It throws *unstable* if any diagonal is non-positive, which
flags a rigid-body mechanism (insufficient restraint).

---

## 4. Post-processing

### 4.1 Field values — `fieldAt(x)`

Locates the element containing `x` and evaluates, from the solved nodal DOF:

- **deflection `w`** (down-positive),
- **slope `dw/dx`** (Euler–Bernoulli) — reported as `slope`/`phi`,
- **section rotation `φ`** (Timoshenko).

The UI plots these and also reports the value at a user-chosen `x` (the "Value at a point"
card).

### 4.2 Reactions — `computeReactions`

For every constrained DOF `c`:

```
R_c = Forig[c] − Σⱼ Korig[c][j] · d[j]
```

i.e. the reaction is the *unconstrained* residual force at the restrained DOF. Reactions are
grouped by location; the **Reactions** table shows, per support, the vertical force
(labelled `+ up`) and the moment (labelled `+ CCW`).

> **Sign note.** The internal sign of a reaction in the solver is the sign *in the DOF
> direction* (w is +down, rotation +CCW). The Reactions-table headers label vertical as
> `+ up` and moment as `+ CCW`; when comparing to a reference, match **magnitude and the
> physical direction** (e.g. "R = P/2 upward") rather than the raw printed sign.

### 4.3 Internal forces — `vmAt` / `computeVM`

Shear `V(x)` and bending moment `M(x)` are computed by **statics (method of sections)**
from the reactions and applied loads to the *left* of `x` — not from the element
interpolation — so they are exact across the beam and independent of mesh density:

- vertical reactions add to `V` and to `M` (moment arm `x − x_r`),
- a reaction *moment* is added to `M` for `x` to its right (its sign is negated in
  `reactionsByLocation`, the standard reaction/acting-moment duality),
- distributed and point loads subtract from `V` and add their moment to `M`,
- a point moment contributes to `M` for `x` to its right.

`M` is therefore **sagging-positive** (tension on the *lower* fibre); `V` follows the
standard beam sign. The curves are sampled at 600 points.

> **Documentation discrepancy.** The in-app Help text states that "sagging is *negative*."
> The code as written produces **sagging-positive** `M`. Treat the code (sagging-positive)
> as authoritative and flag the Help text for correction.

### 4.4 Bending stress — `bendingStress`

    σ = M · c / I

where `c` is the distance from the neutral axis to the outer fibre: `c = h/2` if a section
height `h` is supplied, otherwise a rectangular estimate `c = √(3I/A)`. `σ` is reported at
the location of maximum `|M|`. It returns *null* when `I ≤ 0` or `c` is undefined (the UI
shows "needs h or A").

---

## 5. Sign conventions (summary)

| Quantity         | Positive direction                        |
|------------------|-------------------------------------------|
| Load `P`, `q`    | **downward**                              |
| Point moment `M` | **counter-clockwise**                     |
| Deflection `w`   | **downward**                              |
| Slope / rotation | **counter-clockwise**                     |
| Reaction vertical| labelled `+ up` (see §4.2 sign note)      |
| Reaction moment  | `+ CCW`                                   |
| Internal `V`     | standard beam sign                        |
| Internal `M`     | **sagging** (tension on lower fibre)      |
| Bending stress σ | tensile = `M·c/I` at the loaded fibre     |

---

## 6. Units

The **model and solver are always in SI** (m, N, N·m, N/m, Pa, m⁴, m²). Conversion to
imperial (in, lbf, lbf·in, lbf/in, psi) happens **only at the display boundary** via
`conv`/`toSI`; the numbers in the model state are never stored in imperial.

Key factors: `1 in = 0.0254 m`, `1 lbf = 4.44822 N`, `1 psi = 6894.76 Pa`,
`1 lbf·in = 0.1129848 N·m`, `1 lbf/in = 175.126 N/m`.

---

## 7. Meshing and break points — `buildModel`

The beam is divided into elements. **Break points** are inserted automatically at:

- the two ends and every section boundary,
- the location of every point force / point moment,
- the start and end of every distributed load,
- every intermediate support.

Each break *segment* is then subdivided into `meshPerSeg` elements (default 24). The
exact Timoshenko element and the Gauss-4/5-point load condensation make the result
insensitive to `meshPerSeg` for these load types, so 1 element/segment is already near-
exact; higher counts only matter for very steep load gradients.

The element's section is chosen by the element's midpoint (`cx`), so a load that straddles a
section boundary is split and each part uses the correct section stiffness.

---

## 8. Numerical notes and limitations

- **Stability:** an unrestrained model (no fixed/guided end and no intermediate support) is
  a rigid-body mechanism; the Cholesky factor reports *unstable* and the UI asks for a
  restraint.
- **Exact elements:** both element types are exact for their governing equation at any mesh,
  so deflection/moment/slope are essentially mesh-independent. Distributed loads are
  condensed with 5-point Gauss (exact for the linear load profile).
- **Shear coupling:** Timoshenko results depend on `κ` and `A`; a slender beam
  (`L/h` large) makes the shear term negligible, so Euler and Timoshenko agree to within the
  shear correction — a useful internal check.
- **Stress:** `σ = M·c/I` uses `c = h/2` (rectangular) or the `√(3I/A)` estimate; for
  non-rectangular sections supply `h` = 2·c explicitly.
- **Point loads at a break:** point loads and moments are placed at the nearest node; a break
  is forced at their location so they sit exactly on a node.

---

## 9. Reference for the element math

- Euler–Bernoulli: standard 2-node beam element (e.g. Cook, Malkus, Plesha, Witt,
  *Concepts and Applications of Finite Element Analysis*).
- Exact Timoshenko element: constant-shear-strain / shear-flexible 2-node element
  (e.g. Reddy, *Introduction to Continuum Mechanics*; Timoshenko & Winkler, *Theory of
  Beams*).
- Internal forces by statics (method of sections): any mechanics-of-materials text.
