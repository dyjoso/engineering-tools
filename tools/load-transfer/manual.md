# Fastened Joint Analysis Tool — Technical Manual

**Tool:** Fastened Joint Analysis (`load-transfer`)  
**Format:** Browser-based finite element solver  
**Units:** US Customary (lbf, inches, psi)  
**Revision:** October 2026 (beam mode: bearing springs and head/collar end fixity; severity factors added)

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Theoretical Background](#2-theoretical-background)
   - 2.1 [Problem Statement](#21-problem-statement)
   - 2.2 [Layer Elements — Axial Bar](#22-layer-elements--axial-bar)
   - 2.3 [Fastener Stiffness — Tate & Rosenfeld](#23-fastener-stiffness--tate--rosenfeld)
   - 2.4 [Fastener Modelling — Beam Element Method](#24-fastener-modelling--beam-element-method)
   - 2.5 [Bearing Springs and End Fixity](#25-bearing-springs-and-end-fixity)
3. [Finite Element Formulation](#3-finite-element-formulation)
   - 3.1 [Degrees of Freedom](#31-degrees-of-freedom)
   - 3.2 [Global Stiffness Assembly](#32-global-stiffness-assembly)
   - 3.3 [Boundary Conditions](#33-boundary-conditions)
   - 3.4 [System Solution](#34-system-solution)
   - 3.5 [Element Force Recovery](#35-element-force-recovery)
4. [Fastener Modelling Modes](#4-fastener-modelling-modes)
   - 4.1 [Spring Mode (Tate & Rosenfeld)](#41-spring-mode-tate--rosenfeld)
   - 4.2 [Beam Mode (Timoshenko + Bearing Springs)](#42-beam-mode-timoshenko--bearing-springs)
5. [Boundary Condition Assumptions](#5-boundary-condition-assumptions)
6. [Material Properties](#6-material-properties)
7. [User Guide](#7-user-guide)
   - 7.1 [Workflow Overview](#71-workflow-overview)
   - 7.2 [Model Setup](#72-model-setup)
   - 7.3 [Element Properties](#73-element-properties)
   - 7.4 [Loads and Boundary Conditions](#74-loads-and-boundary-conditions)
   - 7.5 [Solving and Interpreting Results](#75-solving-and-interpreting-results)
   - 7.6 [Severity Factors (SF)](#76-severity-factors-sf)
8. [Limitations and Assumptions](#8-limitations-and-assumptions)
9. [Worked Example](#9-worked-example)
10. [References](#10-references)

---

## 1. Introduction

The **Fastened Joint Analysis Tool** is a browser-based structural analysis tool for calculating load transfer in multi-layer joints connected by rows of fasteners. It is intended for use in airframe stress analysis and similar engineering contexts where a line of fasteners transfers in-plane shear load between two or more structural members.

The tool models each structural member (e.g., a skin, doubler, or fitting flange) as a one-dimensional **axial bar** and each fastener as either a **shear spring** (simple mode) or a **Timoshenko beam with contact springs** (advanced mode). The finite element method is used to assemble and solve the global system of equations, yielding fastener loads and member forces throughout the joint.

**Key capabilities:**
- Multi-layer, multi-fastener joints (≥ 2 layers, ≥ 1 fastener)
- Two fastener modelling approaches: direct spring (T&R) and beam element
- Mixed boundary conditions: prescribed force or prescribed displacement at the right edge of each layer
- Fixed or free condition at the left edge of each layer
- Per-element customisation of material, width, thickness, and length
- Interactive SVG visualisation with element force labelling
- Detailed results: layer forces, fastener shear loads, rotations

---

## 2. Theoretical Background

### 2.1 Problem Statement

Consider a joint consisting of $n_L$ parallel layers joined by $n_F$ columns of fasteners. Each layer is loaded in its plane (axial direction). The fasteners transfer shear between adjacent layers. The structural problem is to determine the distribution of fastener loads given the applied external loads and the relative stiffness of the layers and fasteners.

The approach taken here is the **stiffness (direct) finite element method**, following the classical framework used for bolted joint analysis in aircraft structures (see Huth, Tate & Rosenfeld).

### 2.2 Layer Elements — Axial Bar

Each layer segment between two adjacent fastener columns is modelled as a prismatic **axial bar element**. The element stiffness is:

$$k_{\text{layer}} = \frac{EA}{L} = \frac{E \cdot W \cdot t}{L}$$

where:

| Symbol | Description | Units |
|--------|-------------|-------|
| $E$ | Young's modulus of the layer material | psi |
| $W$ | Width of the layer (perpendicular to load) | in |
| $t$ | Thickness of the layer | in |
| $L$ | Length of the segment (fastener pitch or end span) | in |
| $A = W \cdot t$ | Cross-sectional area | in² |

The bar element has one translational DOF ($u$) at each end. The element stiffness matrix in local coordinates is:

$$\mathbf{k}_{\text{bar}} = \frac{EA}{L} \begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix}$$

### 2.3 Fastener Stiffness — Tate & Rosenfeld

The **Tate & Rosenfeld** (T&R) formula provides an empirical expression for the total elastic flexibility of a fastener connecting two plates. The flexibility accounts for:

- Bearing deformation of the fastener shank in each plate
- Bearing deformation of each plate under the fastener
- Shear deformation of the fastener shank
- Bending deformation of the fastener shank

The total flexibility for a two-layer interface is:

$$C_{TR} = \underbrace{\frac{0.375}{E_f t_1}}_{\text{fastener bearing, layer 1}} + \underbrace{\frac{0.375}{E_f t_2}}_{\text{fastener bearing, layer 2}} + \underbrace{\frac{0.9}{E_1 t_1}}_{\text{plate bearing, layer 1}} + \underbrace{\frac{0.9}{E_2 t_2}}_{\text{plate bearing, layer 2}} + \underbrace{\frac{32(1+\nu_f)(t_1+t_2)}{9 E_f \pi d^2}}_{\text{fastener shear}} + \underbrace{\frac{8(t_1^3 + 5t_1^2 t_2 + 5t_1 t_2^2 + t_2^3)}{5 E_f \pi d^4}}_{\text{fastener bending}}$$

where:

| Symbol | Description |
|--------|-------------|
| $E_f, \nu_f$ | Fastener Young's modulus and Poisson's ratio |
| $E_1, E_2$ | Young's modulus of the two adjacent layers |
| $t_1, t_2$ | Thickness of the two adjacent layers |
| $d$ | Fastener nominal diameter |

The equivalent fastener shear stiffness used in the **spring model** is then:

$$k_{TR} = \frac{1}{C_{TR}}$$

This formula is empirical, calibrated to test data, and is widely used in aircraft structural analysis. It correctly captures the net relative displacement between the bearing points of the two plates, incorporating all deformation mechanisms in a single scalar stiffness.

> **Reference:** Tate, M.B. and Rosenfeld, S.J., "Preliminary Investigation of the Loads Carried by Individual Bolts in Bolted Joints," NACA TN No. 1051, 1946. Also reproduced in ESDU 84044.

### 2.4 Fastener Modelling — Beam Element Method

The **beam element mode** provides a mechanistically richer representation of fastener behaviour for multi-layer joints (three or more layers). Rather than collapsing the entire fastener to a single spring, the fastener shank is modelled as a slender beam spanning continuously through all layers.

#### Motivation

In a two-layer joint the T&R formula is complete and self-consistent. However, in joints with three or more layers the simple-spring approach requires a separate stiffness for each layer-to-layer interface, and the interaction between segments (the fact that the fastener is a continuous rod) is not captured. The beam model resolves this:

1. The fastener shank is represented by a series of **Timoshenko beam segments**, one per inter-layer span.
2. The load exchange between the fastener and each layer is modelled via **contact springs** at every layer mid-plane crossing.
3. The contact springs carry the **bearing** terms of T&R for that layer alone; shank shear and bending come from the beam itself.

The formulation was checked in October 2026 against an independent reference analysis of a 5-layer, 6-fastener wing splice (section S1), reproducing its load distribution to within 0.005 lbf on every element.

#### Geometry

For each fastener column $j$ and each layer $i$, a **fastener node** is created co-located with the corresponding layer node. Fastener nodes carry two DOFs: lateral translation $u$ and rotation $\theta$.

The layer thickness $t_i$ (and modulus $E_i$) seen by the fastener at a node is the **average of the layer elements either side of that node**, or the single element at a layer end.

The length of each beam segment is taken as the **distance between adjacent layer mid-planes**:

$$L_{\text{beam}} = \frac{t_i + t_{i+1}}{2}$$

This treats the bearing load as transferred at the mid-plane of each plate, a standard assumption consistent with T&R.

#### Timoshenko Beam Stiffness Matrix

Each fastener shank segment is modelled as a **Timoshenko beam** to correctly account for shear deformation, which becomes significant for short, thick members such as fastener shanks.

The governing shear deformation parameter is:

$$\Phi = \frac{12 E_f I}{\kappa A G_f L^2}$$

where:

| Symbol | Expression | Description |
|--------|-----------|-------------|
| $I$ | $\frac{\pi d^4}{64}$ | Second moment of area (circular section) |
| $A$ | $\frac{\pi d^2}{4}$ | Cross-sectional area |
| $\kappa$ | $\frac{6(1+\nu_f)}{7+6\nu_f}$ | Shear correction factor for a solid circular section (Cowper); 0.887 for $\nu_f = 0.31$ |
| $G_f$ | $\frac{E_f}{2(1+\nu_f)}$ | Shear modulus of fastener |
| $L$ | $(t_i + t_{i+1})/2$ | Beam segment length |

For $\Phi = 0$ the element reduces to the standard Euler-Bernoulli beam. For non-zero $\Phi$ the shear deformation term reduces the effective bending stiffness.

The 4×4 element stiffness matrix in DOF order $[u_i,\ \theta_i,\ u_j,\ \theta_j]$ is:

$$\mathbf{k}_{\text{beam}} = \frac{E_f I}{L^3(1+\Phi)} \begin{bmatrix}
12 & 6L & -12 & 6L \\
6L & 4L^2\!\left(1+\frac{\Phi}{4}\right) & -6L & 2L^2\!\left(1-\frac{\Phi}{2}\right) \\
-12 & -6L & 12 & -6L \\
6L & 2L^2\!\left(1-\frac{\Phi}{2}\right) & -6L & 4L^2\!\left(1+\frac{\Phi}{4}\right)
\end{bmatrix}$$

The off-diagonal shear stiffness $k_{13} = -12EI/[L^3(1+\Phi)]$ represents the lateral force required at one end to produce unit relative lateral displacement, with rotations suppressed at both ends. In the assembled model the interior rotations are free; only the head and collar ends are restrained (§2.5).

### 2.5 Bearing Springs and End Fixity

#### Bearing (contact) springs

Each layer the fastener passes through has one contact spring between the layer node and its co-located fastener node. It represents the local bearing deformation of the fastener and the plate at that hole, i.e. the two bearing terms of T&R for that layer:

$$C_{\text{bearing},i} = \frac{C_f}{E_f t_i} + \frac{C_p}{E_i t_i}, \qquad k_{\text{bearing},i} = \frac{1}{C_{\text{bearing},i}}$$

with the compliance factors $C_f = 0.375$ (fastener) and $C_p = 0.9$ (plate), the bearing coefficients of the T&R formula (§2.3).

Shank shear and bending are **not** added to the springs: they come from the beam elements. (Before October 2026 the tool instead subtracted a guided-beam flexibility from the full T&R value and split the residual over two springs per segment. The larger differences against the reference analysis came from the end fixity below, and from rotation being clamped on fastener nodes left orphaned by element deletion rather than at the fastener's real ends.)

#### Head and collar end fixity

The shank does not stop at the outermost layer mid-plane: it continues for half that layer's thickness to the head (or collar) face, where its **rotation is clamped**. With no lateral spring at the face the stub carries no shear, only a constant moment, so it is exactly equivalent to a rotational spring on the end fastener node:

$$k_{\theta,\text{end}} = \frac{E_f I}{t_{\text{end}}/2}$$

applied at the head and at the tail of every fastener column. The head and tail are the outermost fastener nodes joined by beam elements, so a fastener that only passes through some of the layers is restrained at its real ends.

For a two-layer joint this gives very nearly the T&R flexibility (e.g. 0.063 in sheets, 0.19 in Ti fasteners: beam mode 36.32 lbf vs spring mode 36.40 lbf at the end fasteners).

---

## 3. Finite Element Formulation

### 3.1 Degrees of Freedom

The DOF assignment is as follows:

| Node type | DOFs | Description |
|-----------|------|-------------|
| Layer node | 1 ($u$) | Axial translation only |
| Fastener node (beam mode) | 2 ($u$, $\theta$) | Lateral translation and rotation |

DOF numbering is sequential: all layer node DOFs are numbered first, followed by fastener node DOF pairs.

For a model with $N_L$ layer nodes and $N_F$ fastener nodes, the system size is:

$$N_{\text{DOF}} = N_L + 2 N_F$$

### 3.2 Global Stiffness Assembly

The global stiffness matrix $\mathbf{K}$ (size $N_{\text{DOF}} \times N_{\text{DOF}}$) is assembled by the standard direct stiffness method:

1. **Layer elements:** Each axial bar element contributes its $2 \times 2$ stiffness matrix to the DOFs of its two layer nodes.

2. **Beam elements (beam mode):** Each Timoshenko beam element contributes its $4 \times 4$ stiffness matrix to the four DOFs of its two fastener nodes (2 DOFs per fastener node × 2 nodes).

3. **Bearing contact springs (beam mode):** Each bearing spring contributes a $2 \times 2$ spring matrix:
$$\mathbf{k}_{\text{spring}} = k_{\text{bearing}} \begin{bmatrix} 1 & -1 \\ -1 & 1 \end{bmatrix}$$
assembled into the layer node $u$ DOF and the fastener node $u$ DOF.

4. **End fixity (beam mode):** $k_{\theta,\text{end}}$ is added to the $\theta$ DOF of the head and tail fastener nodes of each column.

5. **Direct shear springs (spring mode):** Each T&R spring contributes a $2 \times 2$ spring matrix between the $u$ DOFs of two adjacent layer nodes at the same fastener column.

### 3.3 Boundary Conditions

Two types of boundary conditions are applied:

#### Physical Boundary Conditions (User-Defined)

These are applied to **layer nodes** at the left and right edges of each layer:

- **Fixed left edge** ($u = 0$): The leftmost node of the selected layer is fully fixed against translation.
- **Prescribed force** ($F$ applied at right edge): An external force is applied to the rightmost node of the selected layer.
- **Prescribed displacement** ($u = \delta$ at right edge): A prescribed lateral displacement is applied to the rightmost node of the selected layer.

Both fixed and prescribed-displacement BCs are implemented via the **penalty method**:

$$K_{ii} \leftarrow K_{ii} + k_p, \quad F_i \leftarrow F_i + k_p \cdot u_{\text{prescribed}}$$

where the penalty stiffness $k_p$ is set to $k_p = 10^8 \times K_{ii}^{\max}$, with $K_{ii}^{\max}$ being the maximum diagonal entry of the unmodified stiffness matrix. This approach avoids the need to partition and reorder the stiffness matrix.

#### Fastener End Fixity

The head and tail rotations are restrained by the rotational springs of §2.5 (not by a penalty clamp at the mid-plane).

#### Unconnected DOFs

Any DOF left with zero stiffness after assembly — a fastener node in a layer the fastener no longer passes through, or a layer node with no elements, both left behind when elements are deleted — is pinned with the penalty stiffness so the system stays non-singular. These nodes carry no load.

### 3.4 System Solution

The global system $\mathbf{K}\mathbf{U} = \mathbf{F}$ is solved using **LU decomposition** (via the `math.lusolve` function from the mathjs library). The solution vector $\mathbf{U}$ contains all layer node translations and fastener node translations and rotations.

### 3.5 Element Force Recovery

After solution, element forces are recovered as follows:

**Layer element axial force:**
$$F_{\text{layer}} = k_{\text{layer}} \cdot (u_{j} - u_{i})$$

A positive force indicates tension (elongation); negative indicates compression.

**Contact spring force:**
$$F_{\text{spring}} = k_{\text{bearing}} \cdot (u_F - u_L)$$

where $u_F$ is the fastener node translation and $u_L$ is the layer node translation at the same location.

**Beam element shear force:**

The shear at the head of the beam element (node $i$) is recovered from the first row of the element stiffness matrix and the displacement vector:

$$V = k_{11} u_i + k_{12} \theta_i + k_{13} u_j + k_{14} \theta_j$$

where $[k_{11}, k_{12}, k_{13}, k_{14}]$ is the first row of $\mathbf{k}_{\text{beam}}$.

**Direct spring force (spring mode):**
$$F_{\text{fastener}} = k_{TR} \cdot (u_{L2} - u_{L1})$$

where $u_{L1}$ and $u_{L2}$ are the translations of adjacent layer nodes at the fastener column.

---

## 4. Fastener Modelling Modes

### 4.1 Spring Mode (Tate & Rosenfeld)

In **Spring Mode**, each fastener interface (pair of adjacent layers at a fastener column) is replaced by a single shear spring with stiffness $k_{TR} = 1/C_{TR}$ per the Tate & Rosenfeld formula.

**Topology:**
- No fastener nodes are created; the spring connects directly between two layer nodes.
- No rotational DOFs are involved.
- System size: $N_L$ DOFs only.

**Advantages:**
- Simple and computationally efficient.
- T&R is the industry-standard formula for bolted joint flexibility.
- Directly validated against test data.

**Limitations:**
- For multi-layer joints (≥ 3 layers), the shank continuity between interfaces is ignored. Each interface is treated independently.
- Cannot recover fastener bending moments or rotations.

### 4.2 Beam Mode (Timoshenko + Bearing Springs)

In **Beam Mode**, each fastener is modelled as a continuous Timoshenko beam column spanning all the layers it passes through, with a bearing spring at each layer (§2.4–2.5).

**Topology:**
- One fastener node (2 DOFs) is created per fastener per layer.
- Beam elements connect adjacent fastener nodes within the same fastener column.
- A bearing spring connects each fastener node to its co-located layer node.
- Rotational springs $E_f I/(t/2)$ at the head and tail fastener nodes represent the shank stub to the clamped head/collar face.

**Advantages:**
- Captures inter-layer coupling through shank bending and shear.
- Recovers fastener rotation, which is useful for fatigue analysis.
- Checked against an independent reference analysis, and close to T&R for a two-layer joint.

**Limitations:**
- Results depend on the head/collar fixity assumption (§5).

---

## 5. Boundary Condition Assumptions

This section summarises all the boundary conditions assumed by the tool, both physical and structural modelling assumptions.

### Summary Table

| BC | Location | Type | Description | Effect |
|----|----------|------|-------------|--------|
| **Fixed node** | Left edge of selected layer | User-defined | $u = 0$ (axial translation fixed) | Reacts all load entering that layer |
| **Applied force** | Right edge of selected layer | User-defined | $F$ applied to rightmost node | Introduces external load |
| **Prescribed displacement** | Right edge of selected layer | User-defined | $u = \delta$ at rightmost node | Enforces a relative displacement |
| **Fastener head/collar fixity** | Head and tail of each fastener | Assumed | $\theta = 0$ at the head/collar face, $t/2$ beyond the outer layer mid-plane | Rotational spring $E_f I/(t/2)$ on the end fastener node |

### Key Modelling Assumption: Clamped Head and Collar Faces

The head and collar are assumed to clamp the shank rotation at the outer faces of the stack, not at the outer layer mid-planes. The half-thickness of shank between the mid-plane and the face can still bend, so the outer layers see a softer fastener than the inner ones. Clamping at the mid-plane instead (the pre-October 2026 assumption) over-stiffens the outer layers and pulls load into them.

---

## 6. Material Properties

The following materials are defined in the tool (all properties at room temperature):

| Material | Young's Modulus $E$ (psi) | Poisson's Ratio $\nu$ |
|----------|--------------------------|----------------------|
| Aluminum | 10,500,000 | 0.33 |
| Titanium | 16,500,000 | 0.31 |
| Steel | 29,500,000 | 0.30 |

These values are applied to both layer elements and fasteners. The shear modulus is derived internally as $G = E / [2(1+\nu)]$.

---

## 7. User Guide

### 7.1 Workflow Overview

The recommended workflow is sequential:

```
1. Model Setup   →   2. Properties   →   3. Loads & BCs   →   4. Solve   →   5. Review Results
```

Each step is described below.

### 7.2 Model Setup

In the **1. Model Setup** panel:

| Field | Description | Typical value |
|-------|-------------|---------------|
| Layers | Number of structural members (sheets, doublers, etc.) | 2–5 |
| Fasteners | Number of fastener columns in the row | 1–20 |
| Segment Length (in) | Default length of each inter-fastener segment | Fastener pitch |

Click **Generate Model** to build the model topology and draw the SVG visualisation.

- Layers are numbered 0 (top) to $n-1$ (bottom).
- Node columns are: left edge | fastener 1 | fastener 2 | … | right edge.
- Layer nodes are shown as **blue circles**; fastener nodes (beam mode) as **purple circles**.
- Beam elements are shown as **green lines**; contact springs as **amber dashed lines**.

### 7.3 Element Properties

In the **2. Properties** panel, use the **Global** sub-panel to set properties for all layers or all fasteners simultaneously.

#### Layers
- **Material:** Aluminum / Titanium / Steel
- **Width W (in):** Out-of-plane width of the layer (used to compute $A = W \cdot t$)
- **Thickness t (in):** Layer thickness (used for area and fastener flexibility)

Click **Apply to All Layers** to propagate the global values.

#### Fasteners
- **Material:** Material of the fastener shank
- **Diameter d (in):** Nominal shank diameter
- **Modeling Mode:** Beams (Timoshenko) or Springs (T&R)

Click **Apply to All Fasteners** to propagate.

#### Individual Element Editing
Click any layer element (horizontal line) or beam/spring element in the visualisation to select it. The **Edit Element** panel appears on the left. You can change material, width, thickness, or length for individual elements and check **Apply to entire Layer** to propagate within a layer.

Selecting a fastener (beam segment or spring) edits that fastener's material, diameter and **stiffness multiplier K-mult**. K-mult multiplies every stiffness of the fastener (in beam mode the beam segments, bearing springs and head/collar end fixity; in spring mode the T&R springs), so the fastener's whole load-deflection stiffness scales by K-mult. Use it where fastener spacing differs between rows across the strip: e.g. if an outer row has double spacing, take the strip width at that row's spacing and give the inner-row fasteners K-mult = 2, since two of them fall within each strip width. Default 1; saved with the model and listed in the Model Summary. The fastener loads reported are the totals for the strip, i.e. for all K-mult fasteners together. For the severity factor, K-mult = k is treated as k side-by-side strips: each fastener sits in a strip of width $W/k$ and carries $1/k$ of the bypass and transfer loads. The gross stress and $R/P$ are unchanged, while $d/W$ (and with it $K_{TG}$, $K_{TB}$, $K_{Tbend}$ and $e_2$) and the bearing term use $W/k$ (§7.6).

Segment length changes propagate to the entire column (all layers at that fastener column position share the same pitch, as physically required for proper node alignment).

### 7.4 Loads and Boundary Conditions

In the **3. Loads & BCs** panel:

#### Left Edge — Fix
Select a layer from the dropdown and click **Fix** to pin the leftmost node of that layer ($u = 0$). Click **Unfix** to release it. Fixed nodes are shown in **red** in the visualisation.

> At least one layer must be fixed to prevent rigid body motion.

#### Right Edge — Force or Displacement

Toggle between **Force** and **Disp.** modes.

- **Force mode:** Select a layer and enter a force value (lbf). Click **Apply**. The load is applied to the rightmost node of that layer. Shown as a **red arrow**.
- **Displacement mode:** Select a layer and enter a displacement value (inches). Click **Apply**. A prescribed displacement is applied to the rightmost node. Shown as a **green arrow**.

Multiple loads and/or displacement BCs can be applied to different layers simultaneously.

### 7.5 Solving and Interpreting Results

Click **Solve Analysis**. The solver will:
1. Assemble the stiffness matrix and force vector.
2. Apply boundary conditions.
3. Solve the linear system.
4. Recover element forces.
5. Update the visualisation with force labels.

The **Analysis Results** panel at the bottom displays:
- **Layer Element Forces (lbf):** Axial force in each layer segment. Note that the force varies along the layer as load is transferred to/from fasteners.
- **Fastener Beam Forces (lbf)** *(beam mode)*: Shear force at the head of each beam segment, representing load transferred across the interface.
- **Contact Spring Forces (lbf)** *(beam mode)*: Force in each bearing spring, showing the load each layer passes into the fastener.
- **Fastener Rotations (rad)** *(beam mode)*: Rotation of each fastener node, indicating fastener bending.
- **Fastener Shear Spring Forces (lbf)** *(spring mode)*: Net shear transferred by each T&R spring.

The **Model Summary** button (top right of the visualisation) lists every element with the properties and stiffnesses the solver actually uses: layer elements (E, t, W, L, EA/L), fasteners (d, Ef, nu, head and tail layer), bearing springs (t and E used, k), beam elements (L, I, kappa, Phi, shear stiffness), head/collar rotational springs, and node conditions and loads, plus forces once solved. **Copy as Text** / **Download .txt** give the same tables as a fixed-width report for checking against other analyses.

**Save / Load** write the whole model (geometry, properties, loads, BCs and any results) to a `.json` file and read it back. **Undo** (or Ctrl+Z) steps back through deletes, element edits, "apply to all" changes and loads, up to 50 steps; deletes no longer ask for confirmation. Generating a new model clears the undo history.

**Interpreting fastener loads:** The load transferred by fastener $j$ between layers $i$ and $i+1$ is reported as the contact spring force (beam mode) or the shear spring force (spring mode). In beam mode, **the total fastener load** at a given interface is most directly read from the contact spring. The beam element shear gives the internal shear in the shank, which integrates contributions from all interfaces above.

**Sign convention:** Positive layer element force = tension. Positive fastener spring/contact force = the fastener node moves further right than the layer node, i.e., the fastener is pushing the upper layer to the right (or equivalently, pulling the lower layer to the right).

---

### 7.6 Severity Factors (SF)

Section **4. Severity Factors** in the sidebar sets the defaults for every hole; **Calculate Severity Factors** (after solving) opens a table of every hole a fastener passes through. Click a row to give that hole its own settings (marked `*`); **Use defaults** removes them. The highest SF is highlighted. Restrained nodes have no SF.

**Method.** The SF is non-dimensional: it does not change with the load level. The framework is Boeing D6-29942 (JOSEF II, eqs. 2.2.6 and 2.3.4.1, with the $e_2$ load-transfer factor of Appendix E), with JOSEF II's bearing factor, calibrated $\theta$ curves and Peterson's gross-section factors:

$$SF = \alpha\beta\gamma\left\{e_2\left[GSF\cdot K_{TG}\,B\,\frac{P_{bypass}}{P_{total}} + \theta\,K_{TB}\,\frac{R}{P}\,\frac{W}{n\,d}\right] + BT\cdot K_{T,bend}\right\}$$

| Term | Source |
|------|--------|
| $\Delta P$ | load transferred at the hole = change in layer force across the node |
| $P_{total}$, $P_{bypass}$ | total load at the hole (the larger adjacent layer load) and the load that carries on past it, $P_{total}-\Delta P$ |
| $R/P$ | $\Delta P/P_{total}$ |
| $\theta$ | single shear $1+0.0833x+0.4272x^2+0.8501x^3$ for $x=t/d\le0.4754$ (the D6-29942 curve), then $0.7521+1.0148x+0.0039x^2+0.0697x^3$; double shear $1-0.0006x+0.1069x^2+0.0671x^3$. The JOSEF II program tables (2.02 at $t/d$ 0.9) over-predict the reference results by about 7% at $t/d$ 0.74. Auto shear: $	heta = 	heta_{single} + r(	heta_{double} - 	heta_{single})$, with $r$ = smaller / larger fastener shear either side of the plate at the hole ($r = 0$: all the fastener load on one side, single shear, which includes every head and tail layer; $r = 1$: equal load both sides, double shear). The SF table shows auto holes as "auto r"; single or double can be forced per hole |
| $e_2$ | D6-29942 Fig. E.3.2 nomogram, digitised from a clean redraw: $e_2 = 1 + G(\theta)\,H(\theta, d/W)\,R/P$, the nomogram's own geometry: with $c$ = bearing / bypass $= R/(P-R)$, its c-lines satisfy $(e_2-1)/H = R/P$. $H = 2E$, where $E$ is $e_2-1$ read at $c=1$. Chart range $d/W$ 0.125–0.395, extended outside it (to 0.05–0.6) as a power law through the two end points of each $	heta$ curve, $\theta$ 1.0–1.8 (extended above). $G(\theta) = 1.078\,[1 - 0.198(\theta-1)]$ scales the chart; calibrated against the reference results, whose $e_2$ rises less steeply with $\theta$ than the chart |
| $K_{TB}$ | JOSEF II program fit (D6-29942), $K_{TB} = \exp(2.08x^2 + 0.75x)$, $x = d/W$, on $P/(d t)$. (Peterson's Chart 4.67 $K_{tnb}$ is up to ~8% higher in the usual $d/W$ range; with the calibrated $e_2$ it fits the reference results less consistently.) |
| $K_{TG}$ | Peterson, infinite row of holes in tension, $3[1.002-1.016x+0.253x^2]/(1-x)$, $x=d/W$ |
| $K_{T,bend}$ | Peterson Chart 4.84, row of holes, cylindrical bending about the x-axis, $[1.849-1.741x+0.875x^2+0.081x^3]/(1-x)$ |
| $B$ | biaxial correction $1-0.3\lambda$ on the bypass term (calibrated at $\lambda$ = 0.5) |
| $BT$ | bending-to-tension stress ratio |
| $GSF$ | gross stress factor (multiplier on the bypass term) |
| $\alpha$ | hole type: standard drilled 1.00, reamed TX fit 0.92, Class I 1.00, Class II 1.10, interference 0.872 |
| $\beta$ | fastener type: open hole 1.00, rivet 0.62, Hi-Lok 0.72, CSK lock bolt 0.83, protruding-head lock bolt 0.79, close-tolerance lock bolt 0.76; or user value |
| $\gamma$ | cold worked 0.88; countersink depth factor (D6-29942 Fig. E.3.1: 1.0 up to $T_{csk}/T$ = 0.2, 1.10 at 0.5, 2.0 at 1.0); edge margin E/D: $3.078-1.987x+0.474x^2$ for $x$ = E/D in 1.0–2.0 (1.565 at 1.0, 1.164 at 1.5, 1.0 at 2.0); 0 means the default 2.0 |
| $n$ | fasteners per strip |

**Normalised SF.** The SF at each hole is relative to the gross stress at that hole, so SFs at different holes are not on a common basis. The table therefore also gives the gross stress at each hole, $\sigma_{gross} = P_{total}/(W t)$, and

$$SF_{norm} = SF\cdot\frac{\sigma_{gross}}{\sigma_{gross,max}}$$

where $\sigma_{gross,max}$ is the largest gross stress $|F|/(W t)$ in any layer element (shown above the table). The peak stress at any hole is then $SF_{norm}\cdot\sigma_{gross,max}$, so $SF_{norm}$ ranks every hole in the configuration against one reference stress. Holes are ranked by both SF and $SF_{norm}$. Rank critical holes by $SF_{norm}$: a high SF where little load passes, such as a layer end in a lightly loaded member, can be far less critical than its SF suggests. The highest SF is highlighted pink and the highest $SF_{norm}$ amber.

**SF_norm on the drawing.** **Show SF_norm** (top of the visualisation) switches the drawing from element loads to the $SF_{norm}$ value at each hole, placed up and to the left of its node; the highest is shown larger in amber, and hovering a value shows its rank, SF and R/P. The reference stress is given at the top left. The labels follow the sidebar defaults and any per-hole settings as you change them. **Show Loads** switches back.

**Calibration (October 2026).** Against 44 independent reference severity factor results (the S1 wing splice, a frame/doubler splice, and single-fastener width sweeps at $d/W$ 0.13–0.40 for $\theta$ ≈ 1.10 and 1.38) (three holes; every hole type and fastener type, double shear, cold work, CSK 0.5 and 1.0, BT, biaxial, E/D 1.0 and 1.5, and a hole at t/d 0.74) the tool is within 1.3% for $d/W \le 0.35$ and within 2.5% at $d/W$ = 0.40, the edge of the digitised chart (mean about 0.8%). Two K-mult results (0.5 and 2, putting one hole at $d/W$ 0.108 and 0.432, outside the chart) are within 0.5% with the power-law extension of $e_2$. A published example (Alteon 72-08-00, rivet, CSK, $d/W$ 0.20) gives $e_2$ = 1.33 against its own spreadsheet's 1.32. Every factor except $e_2$ matches exactly; the small remaining error comes from reading $e_2$ off the nomogram.

---

## 8. Limitations and Assumptions

| Limitation | Description |
|------------|-------------|
| **1D model** | Load transfer is assumed to occur in one direction only (along the fastener row). Out-of-plane, lateral bending, and torsion effects are not modelled. |
| **Linear elastic** | All materials behave linearly elastically. No yielding, bearing failure, or nonlinear contact. |
| **Uniform width** | Each element has a uniform rectangular cross-section; width $W$ is constant within a segment. |
| **No head/nut flexibility** | The fastener head and nut are assumed rigid (no additional axial pull-through flexibility). |
| **Symmetric row** | The model considers a single fastener row; eccentricity effects (secondary bending of laps) are not included. |
| **Small deformation** | Displacements and rotations are assumed small. |
| **No friction** | Frictional load transfer between layers at the faying surface is not modelled (joints are assumed to be in net section bearing mode). |
| **Clamped head/collar faces** | Shank rotation is clamped at the outer faces of the stack, half a layer thickness beyond the outer mid-planes. This is an approximation (see §5). |
| **Two-layer T&R** | The T&R formula is applied to each adjacent pair of layers independently; this is the standard practice and is conservative for inner plies of thick stacks. |

---

## 9. Worked Example

**Problem:** A three-layer lap splice (skin + doubler + skin) with 5 fasteners at 1.0 in pitch. Steel AN3 bolts (3/16 in diameter) through 0.063 in aluminium skin and 0.040 in aluminium doubler. Applied load: 500 lbf on the top layer. Bottom layer free (no applied load). Both left edges fixed.

**Setup:**
- Layers: 3, Fasteners: 5, Segment Length: 1.0 in
- Material: Aluminum, Width: 1.0 in
- Layer 0 (top skin): t = 0.063 in
- Layer 1 (doubler): t = 0.040 in
- Layer 2 (bottom skin): t = 0.063 in
- Fastener material: Steel, diameter: 0.1875 in
- Modeling mode: Beams

**BCs:**
- Fix: Layer 0, Layer 2
- Force: Layer 0 right edge = 500 lbf

**Expected behaviour:**
- Load enters at top right edge (Layer 0)
- Transferred to Layer 1 via upper fasteners, then to Layer 2 via lower fasteners
- Higher fastener loads at the ends (classical load distribution effect)
- Fastener rotations small but non-zero at interior locations
- Total reaction at all fixed nodes = 500 lbf (global equilibrium)

---

## 10. References

1. **Tate, M.B. and Rosenfeld, S.J.** (1946). *Preliminary Investigation of the Loads Carried by Individual Bolts in Bolted Joints*. NACA Technical Note 1051.

2. **Huth, H.** (1986). *Influence of Fastener Flexibility on the Prediction of Load Transfer and Fatigue Life for Multi-Row Joints*. ASTM STP 927, Fatigue in Mechanically Fastened Composite and Metallic Joints, pp. 221–250.

3. **Hart-Smith, L.J.** (1980). *Bonded-Bolted Composite Joints*. Douglas Aircraft Company, AFWAL-TR-81-3154.

4. **ESDU 84044** (1984). *Elastic Stress and Deformation in Circular-Section Shaft Couplings*. (Includes T&R flexibility coefficients.)

5. **Timoshenko, S.P.** (1921). *On the correction for shear of the differential equation for transverse vibrations of prismatic beams*. Philosophical Magazine Series 6, 41(245), pp. 744–746.

6. **Cook, R.D., Malkus, D.S., Plesha, M.E. and Witt, R.J.** (2002). *Concepts and Applications of Finite Element Analysis*, 4th ed. John Wiley & Sons.

7. **Boeing Commercial Airplane Division** (1969, Rev A 1974). *Stress Severity Factors for Axially Loaded Mechanically Fastened Joints with a Single Degree-of-Freedom (TES257, JOSEF II)*. Document D6-29942.

8. **Pilkey, W.D. and Pilkey, D.F.** (2008). *Peterson's Stress Concentration Factors*, 3rd ed. John Wiley & Sons. Charts 4.67 and 4.84; infinite row of holes in tension.

---

*This manual covers the mathematical derivation, element formulations, boundary condition assumptions, and operating instructions for the Fastened Joint Analysis Tool as implemented at revision date October 2026. Any modifications to the source code (`script.js`) should be reflected by an update to this document.*
