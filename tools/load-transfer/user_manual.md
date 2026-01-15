# User Manual: Fastened Joint Analysis Tool

This manual provides a comprehensive guide to understanding the theoretical methodology and the technical implementation of the Fastened Joint Analysis Tool.

---

## 1. Introduction

The **Fastened Joint Analysis Tool** is a web-based engineering application designed for the structural analysis of multi-layer fastened joints. It enables engineers to determine load distribution across multiple fasteners and layers, accounting for material properties, geometry, and joint flexibility.

### Key Capabilities:
- **Multi-Layer Analysis**: Supports models with 2 or more stacked layers.
- **Multiple Fasteners**: Analyzes load transfer across a series of fasteners.
- **Advanced Flexibility Modeling**: Uses the **Tate & Rosenfeld** method for empirical joint flexibility.
- **US Units**: All calculations are performed in inches (in), pounds-force (lbf), and pounds per square inch (psi).

---

## 2. Analysis Methodology

### 2.1 Finite Element Approach
The tool represents the joint as a 1D Finite Element (FE) system. It combines axial spring elements for the layers with hybrid beam-spring elements for the fasteners.

#### Topological Components:
- **Layer Nodes**: These nodes represent discrete points along each layer. Each layer node has one degree of freedom (DOF): axial translation ($u$).
- **Layer Elements**: 1D axial springs connecting layer nodes. The stiffness $k_{layer}$ is calculated as:
  $$k_{layer} = \frac{E \cdot A}{L}$$
  Where $E$ is the Young's Modulus, $A$ is the cross-sectional area ($Width \times Thickness$), and $L$ is the segment length.
- **Fastener Nodes**: "Shadow" nodes coincident with the layer nodes at fastener locations. These nodes have two DOFs: translation ($u$) and rotation ($\theta$).

### 2.2 Joint Flexibility (Tate & Rosenfeld)
The tool calculates a unique joint flexibility for every interface between adjacent layers. This is handled by the `calculateTateRosenfeldFlexibility()` function, which is invoked for each fastener-layer interaction during the global stiffness assembly.

The **Tate & Rosenfeld** formula used is:
$$C_{TR} = \frac{1}{E_f t_1} + \frac{1}{E_f t_2} + \frac{1}{E_1 t_1} + \frac{1}{E_2 t_2} + \frac{32(1+\nu_f)(t_1+t_2)}{9E_f \pi d^2} + \frac{8(t_1^3 + 5t_1^2 t_2 + 5t_1 t_2^2 + t_2^3)}{5E_f \pi d^4}$$

Components of the total flexibility:
1. **Terms 1 & 2**: Fastener bearing in layers 1 and 2.
2. **Terms 3 & 4**: Plate bearing in layers 1 and 2.
3. **Term 5**: Shear deformation of the fastener.
4. **Term 6**: Bending deformation of the fastener.

### 2.3 Fastener Model: Timoshenko Beam & Residual Springs
The tool employs a high-fidelity topological model for fasteners, splitting the total joint compliance between a physical beam segment and "residual" contact springs.

#### Fastener Beam Flexibility ($C_{beam}$)
Each segment of the fastener between two layer mid-planes is modeled as a Timoshenko beam. The flexibility of this segment is extracted based on **guided-guided boundary conditions** (fixed against rotation but free to translate at both ends):
$$C_{beam} = C_{bending} + C_{shear}$$
$$C_{bending} = \frac{L^3}{12 E_f I}, \quad C_{shear} = \frac{L}{G_f A_s}$$
Where $L = (t_1 + t_2)/2$ is the distance between mid-planes of adjacent layers.

#### Residual Contact Stiffness ($k_{contact}$)
To ensure the total joint flexibility matches the empirical T&R prediction, the tool calculates a **residual flexibility**:
$$C_{resid} = C_{TR} - C_{beam}$$
If $C_{resid} > 0$, it is converted into stiffness for the contact springs that connect the layer nodes to the fastener nodes. This stiffness is split between two springs at the ends of the beam segment:
$$k_{contact} = \frac{2}{C_{resid}}$$

#### Modelling Assumptions:
- **Timoshenko Theory**: Includes shear deformation, which is significant for short, stout fasteners.
- **Guided-Guided Assumption**: Assumes that the rotation is constrained at the layer mid-planes during the flexibility extraction phase.
- **Mid-Plane Connectivity**: Fastener segments (beams) connect the mid-points of layer thicknesses.
- **Small Displacements**: High-order geometric effects are neglected.
- **Linear Elasticity**: Materials follow Hooke's Law; no plasticity or hole-yielding is modeled.
- **Hole Clearance**: The model assumes a "perfect fit" (neat-fit) condition; hole clearance or interference is not modeled.
- **Rotational Restraint**: The hole bore provides a localized rotational restraint ($k_\theta$) representing the resistance of the plate to fastener tilting.

### 2.4 Mathematical Solver
- **Global Assembly**: The global stiffness matrix $K$ is assembled from layer, beam, contact, and rotational elements.
- **Boundary Conditions**: Applied using the **Penalty Method**, allowing for both "Fixed" (zero displacement) and "Prescribed Displacement" conditions.
- **Solution**: The linear system $KU = F$ is solved using **LU Decomposition** via the `mathjs` library.

---

## 3. Implementation Details

### 3.1 Data Structure (`script.js`)
The internal state is managed in a `model` object:
- `nodes[]`: Array of layer nodes.
- `fastenerNodes[]`: Array of high-fidelity fastener DOFs.
- `layerElements[]`: Stores $E, A, L$ and calculated force.
- `beamElements[]`: Stores Timoshenko beam properties.
- `contactSpringElements[]`: Stores the interface stiffness.

### 3.2 Key Functions
- `calculateTateRosenfeldFlexibility()`: Implements the empirical flexibility math.
- `calculateBeamElementStiffnessMatrix()`: Generates the 4x4 Timoshenko matrix for the fastener segment.
- `solve()`: The main loop that mapping DOFs, assembles $K$ and $F$, and solves the system.
- `updateVisualization()`: A dynamic SVG engine that scales the model and overlays results.

---

## 4. How to Use the Tool

### Step 1: Model Setup
1. Define the number of **Layers** and **Fasteners**.
2. Set the **Segment Length** (distance between fasteners).
3. Click **Generate Model**. This creates the base topology.

### Step 2: Define Properties
1. **Global Properties**: Use the sidebar to set default materials (Aluminum, Steel, Titanium), Width, Thickness, and Fastener Diameter. Click "Apply to All" to mass-update.
2. **Individual Elements**: Click any element (Layer or Fastener) in the visualizer to open the **Element Editor**. Here you can override properties for specific segments.

### Step 3: Loads & Boundary Conditions
1. **Left Edge (Fix)**: Select a layer and click **Fix** to ground the left end.
2. **Right Edge (Load/Disp)**: 
   - Select **Force** to apply a point load (lbf) to the rightmost node of a layer.
   - Select **Disp.** to apply a prescribed displacement (in).
3. Click **Apply** for each condition.

### Step 4: Solve and Analyze
1. Click **Solve Analysis**.
2. **Visual Results**:
   - **Arrows**: Show applied loads (Red) and displacements (Green).
   - **Labels**: Show axial forces in layer elements.
   - **Colored Lines**: Green lines represent the fastener shank; Orange dashed lines represent the contact interface.
3. **Results Panel**: Scroll through the bottom panel for detailed force breakdowns and fastener rotations.

---

## 5. Technical Support
For further inquiries or technical issues, please refer to the project repository or contact the engineering tools development team.
