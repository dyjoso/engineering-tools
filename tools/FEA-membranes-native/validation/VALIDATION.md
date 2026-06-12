# FEA Membranes — Verification & Validation Record

This document records the automated verification performed on the FEA Membranes
native application solver and model operations. Every case below is implemented
as an xunit test in `tests/FeaCore.Tests/SolverTests.cs` and runs on every build:

```
dotnet test tests/FeaCore.Tests/FeaCore.Tests.csproj
```

A failing case fails the build, so this record stays current by construction.
Status as of 2026-06-12: **33/33 pass**.

Conventions: plane stress throughout; Y-down coordinates; units are consistent
(lb, in, psi used in test values). "Exact" means the discretised problem has a
closed-form answer the element must reproduce to the stated tolerance — these
are verification (patch-test) cases, not approximations.

---

## 1. Element verification

### 1.1 Quad4 bilinear membrane

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| E1 | `Quad_UniaxialTension_ExactForBilinear` | Single 10×10 element, E=1e7, ν=0, t=0.1, 1000 lb on the free edge. Closed form: σx = P/(t·w) = 1000 psi, u = σL/E = 1.0e-3 in. | Displacement and σx, σVM exact to 1e-6 (relative); ΣRx = −1000 to 1e-6 |
| E2 | `Plate_20x20_FarFieldStress` | 100×100 plate, 20×20 mesh, ν=0.3, clamped edge + uniform end load. St-Venant far-field σx = 210 psi at mid-plate. | Mid-plate element average within 2 % |
| E3 | `NodalStresses_UniformField_EqualElementStress` | Uniform-stress patch state on a 2×2 mesh with **consistent** edge loads (corner ½ ratio). A constant stress field must be reproduced exactly at every evaluation point. | σx = 1000, σy = 0, σVM = 1000 at all 9 averaged nodes, 4 decimals |

### 1.2 Quad8 quadratic (serendipity) membrane

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| E4 | `Quad8_PatchTest_UniaxialTensionExact` | Single Q8 patch test, consistent quadratic-edge loads (1/6, 4/6, 1/6 of edge total). | u = 1.0e-3 at all free-edge nodes (9 decimals); σx exact at centre and at **all 8** averaged node positions (4 decimals); reaction sum exact |
| E5 | `Quad8_PureBending_ExactLinearStress` | Single Q8 under pure in-plane bending via consistent linear end traction σx(y) = 200·y. The quadratic displacement field carries linear strain **exactly** — the defining capability a Q4 lacks. | σx = 200·y reproduced at every node, 3 decimals |
| E6 | `Quad8_QuarterPoint_CrackTipConfigurationSolves` | Barsoum quarter-point configuration: midside nodes adjacent to a corner moved to the ¼ positions (the isoparametric mapping then embeds the 1/√r strain singularity). | Assembles (interior Gauss points keep det J > 0), solves, all displacements/averaged stresses finite, ΣRy balances the applied load to 5 decimals |

### 1.3 Bar (axial rod) element

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| E7 | `Bar_AxialElongation_PLOverEA` | δ = PL/EA: E=1e7, A=0.1, L=10, P=1000 → δ=0.01. Includes an orthogonal bar that must carry ~zero force. | δ exact to 1e-9; P = +1000 (tension sign convention), σ = 10 000; transverse bar P = 0 to 1e-6 |

### 1.4 Spring element (XY-decoupled fastener idealisation)

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| E8 | `Spring_DecoupledXY_ForceAndDisplacement` | F = k·δ per independent direction: k=1e5, F=100 → δ=1e-3. | δ and recovered spring force exact to 1e-9 |

---

## 2. Boundary conditions & constraints

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| C1 | `EnforcedDisplacement_IsExact` | Prescribed dx = 2e-3 on an edge → σx = E·ε = 2000 psi. BCs use direct elimination, so prescribed values carry **no penalty approximation**. | Enforced displacement exact to 12 decimals; σx to 1e-3 |
| C2 | `Rbe2_TiesSelectedDofsExactly` | RBE2 (exact multipoint constraint via DOF merging) tying a loaded edge in X only. | All tied dx identical to 12 decimals; dy demonstrably independent; reaction sum transmits the full load through the tie |
| C3 | `Rbe2_ConstrainsViaIndependentNode` | A BC anywhere in a tie group holds the group; load on a dependent node acts on the group. Closed form δ = PL/EA through the tied pair. | Group displacements identical (12 dp); δ matches PL/EA (9 dp); reaction sum exact |
| C4 | `Rbe2_ConflictingPrescribedValues_Throw` | Two different enforced displacements inside one tie group are physically contradictory. | Clear solver error, never silent garbage |

---

## 3. Solution diagnostics (error-trapping verification)

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| D1 | `OrphanNode_ThrowsWithNodeId` | A node with no attached stiffness makes K singular. Pre-solve diagnostic names the offending node(s). | Error message contains the orphan node id |
| D2 | `UnderConstrained_ThrowsInsteadOfSilentGarbage` | Rigid-body modes: CSparse LU does **not** throw on a singular matrix — it can return zeros. A post-solve residual check ‖K·u − f‖ ≤ 1e-6·‖f‖ guards every solution. | Under-constrained model raises a clear "add constraints" error |

---

## 4. Stress recovery (nodal averaging)

| ID | Test | Basis | Acceptance |
|----|------|-------|------------|
| S1 | `NodalStresses_UniformField_EqualElementStress` | (also E3) A constant field must survive corner extrapolation + averaging unchanged; contributing-element counts verified (interior node = 4, corner = 1). | Exact at all nodes, 4 decimals |
| S2 | `NodalStresses_StepChange_AveragesAtSharedNodes` | Two elements in series with different thickness → σx steps 500/1000 psi. Averaged value at the shared nodes must be the arithmetic mean (750). | Per-node values 500 / 750 / 1000 to 3 decimals |

---

## 5. Model-operation verification (mesher & editing integrity)

These verify the *operations* preserve a valid, solvable model — element
references intact, no duplicate ids, no dangling entities.

| ID | Test | What it proves |
|----|------|----------------|
| M1 | `Mesher_FlatQuad_NodeAndElementCounts` | Structured mesh node/element counts; corner FE nodes coincide with geometry; **re-mesh fully replaces** the old mesh (no duplicates, unique ids, valid references); meshed plate solves |
| M2 | `Mesher_ArcEdge_MatchesWebtoolSample` | Circular-arc edge geometry matches the webtool's mesher to 4 decimals (cross-tool consistency) |
| M3 | `Quad8_Mesher_CountsAndMidsides` | Serendipity grid count (2M+1)(2N+1)−MN; midside nodes exactly at edge midpoints; Quad4↔Quad8 re-mesh switches cleanly |
| M4 | `Mesher_MoveGeometryPoint_RemeshesAffectedSurfaces` | Geometry edits re-mesh affected surfaces with stored divisions; mesh follows the geometry; unmeshed surfaces untouched |
| M5 | `Mesher_DeleteElements_RemovesOrphanNodes` | Element deletion removes newly-unreferenced nodes (keeps the orphan diagnostic clean) |
| M6 | `Mesher_DeleteNodes_CascadesToAttachedEntities` | Node deletion cascades to elements/springs/bars/RBE2s; remaining references intact |
| M7 | `Mesher_DeleteSurface_RemovesMeshAndOrphanGeometry` | Surface deletion removes its mesh, attached bars, and unshared geometry points |
| M8 | `Mesher_ClearMesh_KeepsNodesSharedWithOtherSurfaces` | After stitching, clearing one surface's mesh keeps seam nodes another surface still references |
| M9 | `Mesher_MergeCoincidentNodes_StitchesTwoSurfacesIntoContinuousPlate` | **Physics check**: two separately-meshed half-plates merged at the seam solve as one continuous plate with the exact uniaxial answer (σx exact, reactions balance) |
| M10 | `Mesher_MergeCoincidentNodes_PreservesSpringPairsAndBcs` | Spring-joined coincident pairs are never merged (fastener idealisation preserved); BCs carry to the surviving node; degenerate bars removed; selection-scoped merge leaves out-of-scope nodes alone |
| M11 | `Mesher_MergeCoincidentNodes_NegativeCoordinates` | Spatial hash correct for negative / origin-straddling coordinates |
| M12 | `Mesher_AddSurface_SharedPoints` | Snap-shared corner points: surfaces genuinely share geometry; moving a shared point re-meshes both; duplicate corners rejected |
| M13 | `Mesher_SpringPointGrid_CountsAndSpacing` | Grid counts, pitch, collapsed single-row/column behaviour |
| M14 | `Mesher_SpringsAtSpringPoints_ExactlyTwoVisibleNodesRule` | One spring per point only when exactly 2 nodes in range; >2 skipped; duplicates skipped on re-run |
| M15 | `Mesher_SpringsAtSpringPoints_OnlyVisibleNodesConsidered` | Hidden surfaces excluded: a 3-layer stack connects outer-to-inner when the middle layer is hidden, and no spring touches the hidden layer |
| M16 | `Rbe2_CleanupOnMeshAndMergeOperations` | RBE2s pruned on re-mesh; node references remapped through coincident merges |

---

## 6. System-level / file integrity

| ID | Test | What it proves |
|----|------|----------------|
| F1 | `SampleModel_LoadsAndSolves` | A real webtool-exported model (curved edge, BCs, bars) loads, solves, satisfies equilibrium (ΣRx = −applied load to 4 dp), all displacements finite and bounded |
| F2 | `WebtoolJson_RoundTrip` | Webtool JSON format compatibility: camelCase fields, edge radii, BCs, springs, bars survive load → save → load |

---

## 7. Independent cross-checks performed during development

Not in the automated suite, but recorded here for completeness:

- The webtool's solver (same element formulation, independent JavaScript
  implementation) passes the equivalent of E1, E7, E8, C1, D1 and E2 in its
  own headless Node.js harness — two independent implementations agreeing on
  the same closed-form answers.
- The native and webtool meshers were verified to produce numerically
  identical meshes for the same curved-edge model (M2 pins this permanently).

## 8. Known gaps — recommended additions for a formal validation suite

Verification above is largely on rectangular, undistorted elements with
closed-form targets. A formal validation suite should add:

1. **Distorted-element patch tests** — constant-stress patch on an irregular
   (non-rectangular, non-parallelogram) Q4 and Q8 assembly; the standard
   Irons patch test. The isoparametric formulation should pass; it is untested.
2. **Convergence studies against handbook solutions** — e.g. plate with a
   central circular hole (Kt → 3.0 with refinement), and Q8 vs Q4 convergence
   rate comparison on the same problem.
3. **Quarter-point SIF benchmark** — once SIF extraction lands: centre-cracked
   and edge-cracked plates vs handbook K_I (Tada/Rooke & Cartwright), mesh
   refinement sensitivity, and quarter-point vs mid-point comparison.
4. **ν ≠ 0 single-element checks** — current single-element exactness cases use
   ν = 0 to keep closed forms simple; add a biaxial case with Poisson coupling.
5. **Aspect-ratio / shape-sensitivity sweep** — document accuracy degradation
   for high-aspect and skewed elements to set modelling guidance.
6. **Large-model conditioning** — solve time and residual-check headroom on a
   representative large model (e.g. 100k+ DOF).
7. **Reaction recovery under enforced displacement** — reactions at enforced
   (non-zero) supports against a closed form.
8. **Spring/bar + membrane interaction** — a doubler load-transfer case with a
   closed-form or independently computed (e.g. Nastran) fastener load
   distribution, exercising the full intended workflow end to end.
