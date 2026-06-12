using CSparse;
using CSparse.Double;
using CSparse.Double.Factorization;
using CSparse.Storage;

namespace FeaCore;

public sealed class NodeResult
{
    public int NodeId { get; init; }
    public double Dx { get; init; }
    public double Dy { get; init; }
}

public sealed class ElementStress
{
    public int ElementId { get; init; }
    public double Sxx { get; init; }
    public double Syy { get; init; }
    public double Sxy { get; init; }
    public double SigmaVM { get; init; }
}

/// <summary>Stress components averaged at a node from all attached elements' corner values.</summary>
public sealed class NodalStress
{
    public int NodeId { get; init; }
    public double Sxx { get; init; }
    public double Syy { get; init; }
    public double Sxy { get; init; }
    public double SigmaVM { get; init; }   // from the AVERAGED components
    public int ElementCount { get; init; } // how many elements contributed
}

public sealed class SpringLoad
{
    public int Id { get; init; }
    public double Fx { get; init; }
    public double Fy { get; init; }
}

public sealed class BarLoad
{
    public int Id { get; init; }
    public double P { get; init; }       // axial force, +ve tension
    public double Stress { get; init; }
    public double Length { get; init; }
}

public sealed class Reaction
{
    public int NodeId { get; init; }
    public double Rx { get; init; }
    public double Ry { get; init; }
}

/// <summary>Stress intensity factors extracted at a crack tip (displacement correlation).</summary>
public sealed class CrackSif
{
    public int CrackId { get; init; }
    public int TipNodeId { get; init; }
    public double K1 { get; init; }          // opening mode
    public double K2 { get; init; }          // sliding mode
    public double FaceElementLength { get; init; } // L of the quarter-point face element
}

public sealed class SolveResult
{
    public required IReadOnlyList<NodeResult> Displacements { get; init; }
    public required IReadOnlyList<ElementStress> ElementStresses { get; init; }
    public required IReadOnlyList<NodalStress> NodalStresses { get; init; }
    public required IReadOnlyList<SpringLoad> SpringLoads { get; init; }
    public required IReadOnlyList<BarLoad> BarLoads { get; init; }
    public required IReadOnlyList<Reaction> Reactions { get; init; }
    public required IReadOnlyList<CrackSif> CrackSifs { get; init; }
    public int DofCount { get; init; }
    public int NonZeros { get; init; }
    public int ConstrainedDofs { get; init; }
    public TimeSpan Elapsed { get; init; }
}

/// <summary>
/// Linear-static 2D solver: bilinear Q4 plane-stress membranes (2x2 Gauss),
/// XY-decoupled springs (fastener idealisation, matching the webtool), and
/// axial bar elements. Fixed and enforced displacements are applied by direct
/// elimination (partitioned solve), so prescribed values are exact - no penalty.
/// </summary>
public static class Solver
{
    public static SolveResult Solve(FeModel model)
    {
        var sw = System.Diagnostics.Stopwatch.StartNew();

        var nodes = model.FeNodes;
        int n = nodes.Count;
        int nDof = 2 * n;
        var dofOf = new Dictionary<int, int>(n); // node id -> first ORIGINAL DOF index
        for (int i = 0; i < n; i++) dofOf[nodes[i].Id] = 2 * i;

        var membById = model.Membranes.ToDictionary(m => m.Id);
        var nodeById = model.FeNodes.ToDictionary(nd => nd.Id);

        // ---- RBE2 multipoint constraints: tie DOFs together exactly by giving
        // dependent DOFs the same solve index as the independent DOF ----
        var dofParent = new int[nDof];
        for (int i = 0; i < nDof; i++) dofParent[i] = i;
        int FindDof(int x)
        {
            while (dofParent[x] != x) { dofParent[x] = dofParent[dofParent[x]]; x = dofParent[x]; }
            return x;
        }
        void UnionDof(int a, int b)
        {
            int ra = FindDof(a), rb = FindDof(b);
            if (ra != rb) dofParent[Math.Max(ra, rb)] = Math.Min(ra, rb);
        }
        foreach (var r in model.Rbe2s)
        {
            if (!dofOf.TryGetValue(r.IndependentNodeId, out int mi))
                throw new InvalidOperationException($"RBE2 {r.Id}: independent node {r.IndependentNodeId} not found.");
            foreach (var dep in r.DependentNodeIds)
            {
                if (!dofOf.TryGetValue(dep, out int di))
                    throw new InvalidOperationException($"RBE2 {r.Id}: dependent node {dep} not found.");
                if (r.TieX) UnionDof(mi, di);
                if (r.TieY) UnionDof(mi + 1, di + 1);
            }
        }
        // Compact solve-space numbering: tied DOFs share one index
        var dofMap = new int[nDof];
        var rootToCompact = new Dictionary<int, int>();
        int nC = 0;
        for (int i = 0; i < nDof; i++)
        {
            int root = FindDof(i);
            if (!rootToCompact.TryGetValue(root, out int c2)) rootToCompact[root] = c2 = nC++;
            dofMap[i] = c2;
        }

        // ---- Assemble global triplets (in solve space) ----
        var coo = new CoordinateStorage<double>(nC, nC, Math.Max(16, 64 * model.FeElements.Count + 16 * (model.FeSprings.Count + model.FeBars.Count)));
        var diag = new double[nC];

        void Add(int r, int c, double v)
        {
            int mr = dofMap[r], mc = dofMap[c];
            coo.At(mr, mc, v);
            if (mr == mc) diag[mr] += v;
        }

        foreach (var el in model.FeElements)
        {
            if (!ElementTopology.IsSupported(el)) continue;
            var memb = el.MembraneId.HasValue && membById.TryGetValue(el.MembraneId.Value, out var mm) ? mm : null;
            double e = el.PropE ?? memb?.MaterialE ?? throw new InvalidOperationException($"Element {el.Id}: no E available.");
            double nu = el.PropNu ?? memb?.MaterialNu ?? 0.0;
            double t = el.PropT ?? memb?.MaterialT ?? throw new InvalidOperationException($"Element {el.Id}: no thickness available.");

            int nn = el.NodeIds.Count;
            var xy = new double[nn, 2];
            var edof = new int[2 * nn];
            for (int a = 0; a < nn; a++)
            {
                var nd = nodeById[el.NodeIds[a]];
                xy[a, 0] = nd.X; xy[a, 1] = nd.Y;
                edof[2 * a] = dofOf[nd.Id];
                edof[2 * a + 1] = dofOf[nd.Id] + 1;
            }

            var ke = ElementTopology.IsQuad8(el)
                ? Quad8.Stiffness(xy, e, nu, t)
                : Quad4.Stiffness(xy, e, nu, t);
            int ndof2 = 2 * nn;
            for (int r = 0; r < ndof2; r++)
                for (int c = 0; c < ndof2; c++)
                    if (ke[r, c] != 0.0) Add(edof[r], edof[c], ke[r, c]);
        }

        foreach (var s in model.FeSprings)
        {
            int i = dofOf[s.FeNodeId1], j = dofOf[s.FeNodeId2];
            double k = s.Stiffness;
            // Decoupled X and Y springs (NOT axial) - intentional fastener idealisation
            foreach (int d in new[] { 0, 1 })
            {
                Add(i + d, i + d, k); Add(j + d, j + d, k);
                Add(i + d, j + d, -k); Add(j + d, i + d, -k);
            }
        }

        foreach (var b in model.FeBars)
        {
            var n1 = nodeById[b.FeNodeId1];
            var n2 = nodeById[b.FeNodeId2];
            double dx = n2.X - n1.X, dy = n2.Y - n1.Y;
            double len = Math.Sqrt(dx * dx + dy * dy);
            if (len <= 0) throw new InvalidOperationException($"Bar {b.Id} has zero length.");
            double cx = dx / len, cy = dy / len;
            double k = b.E * b.A / len;
            int i = dofOf[b.FeNodeId1], j = dofOf[b.FeNodeId2];
            int[] d = { i, i + 1, j, j + 1 };
            double[] g = { -cx, -cy, cx, cy }; // axial direction row
            for (int r = 0; r < 4; r++)
                for (int c = 0; c < 4; c++)
                {
                    double v = k * g[r] * g[c];
                    if (v != 0.0) Add(d[r], d[c], v);
                }
        }

        // ---- Loads and constraints (in solve space; loads on tied DOFs accumulate) ----
        var f = new double[nC];
        var prescribed = new double?[nC];     // non-null => solve DOF has a prescribed value
        var prescriberDof = new int[nC];      // original DOF that prescribed it (reaction reporting)
        Array.Fill(prescriberDof, -1);
        void Prescribe(int origDof, double value, int nodeId)
        {
            int c2 = dofMap[origDof];
            if (prescribed[c2] is { } existing)
            {
                if (Math.Abs(existing - value) > 1e-12)
                    throw new InvalidOperationException(
                        $"Node {nodeId}: prescribed displacement conflicts with another constraint " +
                        "in the same RBE2 tie group.");
                return; // duplicate identical constraint - first prescriber keeps the reaction
            }
            prescribed[c2] = value;
            prescriberDof[c2] = origDof;
        }
        foreach (var nd in nodes)
        {
            if (nd.Bc is null) continue;
            int i = dofOf[nd.Id];
            switch (nd.Bc.Type)
            {
                case "fixed":
                    if (nd.Bc.Value.FixX) Prescribe(i, 0.0, nd.Id);
                    if (nd.Bc.Value.FixY) Prescribe(i + 1, 0.0, nd.Id);
                    break;
                case "load":
                    f[dofMap[i]] += nd.Bc.Value.Fx ?? 0.0;
                    f[dofMap[i + 1]] += nd.Bc.Value.Fy ?? 0.0;
                    break;
                case "enforced":
                    if (nd.Bc.Value.Dx.HasValue) Prescribe(i, nd.Bc.Value.Dx.Value, nd.Id);
                    if (nd.Bc.Value.Dy.HasValue) Prescribe(i + 1, nd.Bc.Value.Dy.Value, nd.Id);
                    break;
                default:
                    throw new InvalidOperationException($"Node {nd.Id}: unknown BC type '{nd.Bc.Type}'.");
            }
        }

        // ---- Orphan diagnostic: free DOFs with no stiffness ----
        var orphans = nodes
            .Where(nd =>
            {
                int i = dofOf[nd.Id];
                return (prescribed[dofMap[i]] is null && diag[dofMap[i]] == 0.0) ||
                       (prescribed[dofMap[i + 1]] is null && diag[dofMap[i + 1]] == 0.0);
            })
            .Select(nd => nd.Id)
            .ToList();
        if (orphans.Count > 0)
            throw new InvalidOperationException(
                $"FE node(s) with no stiffness attached: {string.Join(", ", orphans)}. " +
                "Attach elements/springs/bars to them or delete them.");

        // ---- Partition: solve K_ff u_f = f_f - K_fc u_c ----
        var freeIndex = new int[nC];
        int nFree = 0;
        for (int i = 0; i < nC; i++) freeIndex[i] = prescribed[i] is null ? nFree++ : -1;
        int nCon = nC - nFree;

        var u = new double[nC];
        for (int i = 0; i < nC; i++) if (prescribed[i] is { } v) u[i] = v;

        var full = (SparseMatrix)SparseMatrix.OfIndexed(coo); // duplicates summed
        var rhs = new double[nFree];
        for (int i = 0; i < nC; i++) if (freeIndex[i] >= 0) rhs[freeIndex[i]] = f[i];

        // Reduced matrix + RHS correction for prescribed values, built from the full CSC
        var cooFF = new CoordinateStorage<double>(nFree, nFree, full.NonZerosCount);
        var ap = full.ColumnPointers; var ai = full.RowIndices; var ax = full.Values;
        for (int col = 0; col < nC; col++)
        {
            int fc = freeIndex[col];
            for (int p = ap[col]; p < ap[col + 1]; p++)
            {
                int row = ai[p];
                int fr = freeIndex[row];
                if (fr >= 0 && fc >= 0) cooFF.At(fr, fc, ax[p]);
                else if (fr >= 0 && fc < 0 && u[col] != 0.0) rhs[fr] -= ax[p] * u[col];
            }
        }
        var kff = (SparseMatrix)SparseMatrix.OfIndexed(cooFF);

        if (nFree > 0)
        {
            var uf = new double[nFree];
            try
            {
                var lu = SparseLU.Create(kff, ColumnOrdering.MinimumDegreeAtPlusA, 1.0);
                lu.Solve(rhs, uf);
            }
            catch (Exception ex)
            {
                throw new InvalidOperationException(
                    "Stiffness matrix is singular - the model is under-constrained " +
                    "(add constraints to prevent rigid-body motion).", ex);
            }

            // Residual check: a numerically singular K can "solve" to garbage or zeros
            // without throwing. ||K_ff u_f - rhs|| must be small relative to the loads.
            var residual = new double[nFree];
            kff.Multiply(uf, residual);
            double resNorm = 0, rhsNorm = 0;
            for (int i = 0; i < nFree; i++)
            {
                double r = residual[i] - rhs[i];
                resNorm += r * r;
                rhsNorm += rhs[i] * rhs[i];
            }
            if (rhsNorm > 0 && Math.Sqrt(resNorm) > 1e-6 * Math.Sqrt(rhsNorm))
                throw new InvalidOperationException(
                    "Solve failed the equilibrium check - the model is under-constrained or ill-conditioned " +
                    "(add constraints to prevent rigid-body motion).");

            for (int i = 0; i < nC; i++) if (freeIndex[i] >= 0) u[i] = uf[freeIndex[i]];
        }

        // ---- Reactions: r = K u - f_applied, reported at the node whose BC prescribed
        // the solve DOF (one reporter per RBE2 tie group keeps the sums meaningful) ----
        var ku = new double[nC];
        full.Multiply(u, ku);
        var reactions = new List<Reaction>();
        foreach (var nd in nodes)
        {
            int i = dofOf[nd.Id];
            int cx = dofMap[i], cy = dofMap[i + 1];
            bool px = prescriberDof[cx] == i, py = prescriberDof[cy] == i + 1;
            if (!px && !py) continue;
            reactions.Add(new Reaction
            {
                NodeId = nd.Id,
                Rx = px ? ku[cx] - f[cx] : 0.0,
                Ry = py ? ku[cy] - f[cy] : 0.0
            });
        }

        // ---- Results ----
        var disps = nodes.Select(nd => new NodeResult
        {
            NodeId = nd.Id,
            Dx = u[dofMap[dofOf[nd.Id]]],
            Dy = u[dofMap[dofOf[nd.Id] + 1]]
        }).ToList();

        var stresses = new List<ElementStress>(model.FeElements.Count);
        // Nodal averaging accumulators: sum of each element's corner stress at the node
        var nodalSum = new Dictionary<int, (double sx, double sy, double sxy, int n)>();
        foreach (var el in model.FeElements)
        {
            if (!ElementTopology.IsSupported(el)) continue;
            var memb = el.MembraneId.HasValue && membById.TryGetValue(el.MembraneId.Value, out var mm) ? mm : null;
            double e = el.PropE ?? memb?.MaterialE ?? 0.0;
            double nu = el.PropNu ?? memb?.MaterialNu ?? 0.0;

            int nn = el.NodeIds.Count;
            var xy = new double[nn, 2];
            var ue = new double[2 * nn];
            for (int a = 0; a < nn; a++)
            {
                var nd = nodeById[el.NodeIds[a]];
                xy[a, 0] = nd.X; xy[a, 1] = nd.Y;
                ue[2 * a] = u[dofMap[dofOf[nd.Id]]];
                ue[2 * a + 1] = u[dofMap[dofOf[nd.Id] + 1]];
            }
            bool q8 = ElementTopology.IsQuad8(el);
            var (sx, sy, sxy) = q8 ? Quad8.StressAtCenter(xy, ue, e, nu) : Quad4.StressAtCenter(xy, ue, e, nu);
            double vm = Math.Sqrt(sx * sx + sy * sy - sx * sy + 3 * sxy * sxy);
            stresses.Add(new ElementStress { ElementId = el.Id, Sxx = sx, Syy = sy, Sxy = sxy, SigmaVM = vm });

            // Per-node stresses for nodal averaging (all 8 nodes for quad8)
            var atNodes = q8 ? Quad8.StressAtNodes(xy, ue, e, nu) : Quad4.StressAtCorners(xy, ue, e, nu);
            for (int a = 0; a < nn; a++)
            {
                int nid = el.NodeIds[a];
                var acc = nodalSum.GetValueOrDefault(nid);
                nodalSum[nid] = (acc.sx + atNodes[a].sx, acc.sy + atNodes[a].sy, acc.sxy + atNodes[a].sxy, acc.n + 1);
            }
        }

        // Average components per node, then form von Mises from the averaged components
        var nodalStresses = nodalSum.Select(kv =>
        {
            var (sx, sy, sxy, count) = kv.Value;
            sx /= count; sy /= count; sxy /= count;
            return new NodalStress
            {
                NodeId = kv.Key,
                Sxx = sx, Syy = sy, Sxy = sxy,
                SigmaVM = Math.Sqrt(sx * sx + sy * sy - sx * sy + 3 * sxy * sxy),
                ElementCount = count
            };
        }).ToList();

        var springLoads = model.FeSprings.Select(s =>
        {
            int i = dofOf[s.FeNodeId1], j = dofOf[s.FeNodeId2];
            return new SpringLoad
            {
                Id = s.Id,
                Fx = s.Stiffness * (u[dofMap[j]] - u[dofMap[i]]),
                Fy = s.Stiffness * (u[dofMap[j + 1]] - u[dofMap[i + 1]])
            };
        }).ToList();

        var barLoads = model.FeBars.Select(b =>
        {
            var n1 = nodeById[b.FeNodeId1];
            var n2 = nodeById[b.FeNodeId2];
            double dx = n2.X - n1.X, dy = n2.Y - n1.Y;
            double len = Math.Sqrt(dx * dx + dy * dy);
            double cx = dx / len, cy = dy / len;
            int i = dofOf[b.FeNodeId1], j = dofOf[b.FeNodeId2];
            double elong = (u[dofMap[j]] - u[dofMap[i]]) * cx + (u[dofMap[j + 1]] - u[dofMap[i + 1]]) * cy;
            double p = b.E * b.A / len * elong;
            return new BarLoad { Id = b.Id, P = p, Stress = p / b.A, Length = len };
        }).ToList();

        // ---- Stress intensity factors: displacement correlation with quarter-point
        // elements. With face nodes at r = L/4 (quarter point) and r = L (corner),
        // the sqrt(r) coefficient of the relative face displacement gives
        //   K = (E'/8) * sqrt(2*pi/L) * (4*delta(L/4) - delta(L))
        // where delta is the relative displacement resolved normal (K1) or
        // tangential (K2) to the crack. E' = E for plane stress. ----
        var crackSifs = new List<CrackSif>();
        foreach (var crack in model.Cracks)
        {
            if (!nodeById.TryGetValue(crack.TipNodeId, out var tip)) continue;
            if (!nodeById.TryGetValue(crack.FaceAQuarterNodeId, out var mA) ||
                !nodeById.TryGetValue(crack.FaceACornerNodeId, out var cA) ||
                !nodeById.TryGetValue(crack.FaceBQuarterNodeId, out var mB) ||
                !nodeById.TryGetValue(crack.FaceBCornerNodeId, out var cB)) continue;

            // Material from an element containing the tip
            var tipEl = model.FeElements.FirstOrDefault(e2 => e2.NodeIds.Contains(crack.TipNodeId));
            if (tipEl is null) continue;
            var tipMemb = tipEl.MembraneId.HasValue && membById.TryGetValue(tipEl.MembraneId.Value, out var tm) ? tm : null;
            double eMod = tipEl.PropE ?? tipMemb?.MaterialE ?? 0.0;
            if (eMod <= 0) continue;
            double ePrime = eMod; // plane stress

            double faceL = Math.Sqrt((cA.X - tip.X) * (cA.X - tip.X) + (cA.Y - tip.Y) * (cA.Y - tip.Y));
            if (faceL <= 0) continue;
            // Crack-local axes: t along the face away from the tip, n = stored B->A normal
            double tx = (cA.X - tip.X) / faceL, ty = (cA.Y - tip.Y) / faceL;
            double nx = crack.NormalX, ny = crack.NormalY;

            (double dxr, double dyr) Rel(FeNode a, FeNode b)
            {
                int ia = dofOf[a.Id], ib = dofOf[b.Id];
                return (u[dofMap[ia]] - u[dofMap[ib]], u[dofMap[ia + 1]] - u[dofMap[ib + 1]]);
            }
            var (dq_x, dq_y) = Rel(mA, mB); // relative displacement at r = L/4
            var (dc_x, dc_y) = Rel(cA, cB); // relative displacement at r = L

            double dv1 = dq_x * nx + dq_y * ny, dv2 = dc_x * nx + dc_y * ny; // opening
            double du1 = dq_x * tx + dq_y * ty, du2 = dc_x * tx + dc_y * ty; // sliding

            double factor = ePrime / 8.0 * Math.Sqrt(2 * Math.PI / faceL);
            crackSifs.Add(new CrackSif
            {
                CrackId = crack.Id,
                TipNodeId = crack.TipNodeId,
                K1 = factor * (4 * dv1 - dv2),
                K2 = factor * (4 * du1 - du2),
                FaceElementLength = faceL
            });
        }

        sw.Stop();
        return new SolveResult
        {
            Displacements = disps,
            ElementStresses = stresses,
            NodalStresses = nodalStresses,
            SpringLoads = springLoads,
            BarLoads = barLoads,
            Reactions = reactions,
            CrackSifs = crackSifs,
            DofCount = nC,
            NonZeros = full.NonZerosCount,
            ConstrainedDofs = nCon,
            Elapsed = sw.Elapsed
        };
    }
}

/// <summary>Bilinear 4-node quadrilateral, plane stress, 2x2 Gauss integration.</summary>
public static class Quad4
{
    private static readonly double G = 1.0 / Math.Sqrt(3.0);
    private static readonly (double xi, double eta)[] GaussPoints =
        { (-1, -1), (1, -1), (1, 1), (-1, 1) };

    public static double[,] Stiffness(double[,] xy, double e, double nu, double t)
    {
        var ke = new double[8, 8];
        double c = e / (1 - nu * nu);
        // Plane stress constitutive matrix
        double d11 = c, d12 = c * nu, d33 = c * (1 - nu) / 2;

        foreach (var (gxi, geta) in GaussPoints)
        {
            double xi = gxi * G, eta = geta * G;
            var (b, detJ) = BMatrix(xy, xi, eta);
            double w = t * detJ; // Gauss weights are 1 for 2x2

            // ke += B^T D B * w   (D has the 3x3 plane-stress structure)
            for (int i = 0; i < 8; i++)
            {
                double b0i = b[0, i], b1i = b[1, i], b2i = b[2, i];
                double db0 = d11 * b0i + d12 * b1i;
                double db1 = d12 * b0i + d11 * b1i;
                double db2 = d33 * b2i;
                for (int j = 0; j < 8; j++)
                    ke[i, j] += (db0 * b[0, j] + db1 * b[1, j] + db2 * b[2, j]) * w;
            }
        }
        return ke;
    }

    public static (double sx, double sy, double sxy) StressAtCenter(double[,] xy, double[] ue, double e, double nu)
        => StressAt(xy, ue, e, nu, 0, 0);

    /// <summary>
    /// Stress at each element corner (natural coordinates +-1), in node order.
    /// Used for nodal averaging: corner values from all attached elements are
    /// averaged per node.
    /// </summary>
    public static (double sx, double sy, double sxy)[] StressAtCorners(double[,] xy, double[] ue, double e, double nu)
    {
        var result = new (double, double, double)[4];
        // Natural corner coordinates matching node order: (-1,-1) (1,-1) (1,1) (-1,1)
        result[0] = StressAt(xy, ue, e, nu, -1, -1);
        result[1] = StressAt(xy, ue, e, nu, 1, -1);
        result[2] = StressAt(xy, ue, e, nu, 1, 1);
        result[3] = StressAt(xy, ue, e, nu, -1, 1);
        return result;
    }

    private static (double sx, double sy, double sxy) StressAt(double[,] xy, double[] ue, double e, double nu, double xi, double eta)
    {
        var (b, _) = BMatrix(xy, xi, eta);
        double ex = 0, ey = 0, gxy = 0;
        for (int i = 0; i < 8; i++)
        {
            ex += b[0, i] * ue[i];
            ey += b[1, i] * ue[i];
            gxy += b[2, i] * ue[i];
        }
        double c = e / (1 - nu * nu);
        return (c * (ex + nu * ey), c * (ey + nu * ex), c * (1 - nu) / 2 * gxy);
    }

    private static (double[,] b, double detJ) BMatrix(double[,] xy, double xi, double eta)
    {
        // Shape function derivatives wrt (xi, eta)
        var dN = new double[4, 2]
        {
            { -(1 - eta) / 4, -(1 - xi) / 4 },
            {  (1 - eta) / 4, -(1 + xi) / 4 },
            {  (1 + eta) / 4,  (1 + xi) / 4 },
            { -(1 + eta) / 4,  (1 - xi) / 4 }
        };

        double j11 = 0, j12 = 0, j21 = 0, j22 = 0;
        for (int a = 0; a < 4; a++)
        {
            j11 += dN[a, 0] * xy[a, 0]; j12 += dN[a, 0] * xy[a, 1];
            j21 += dN[a, 1] * xy[a, 0]; j22 += dN[a, 1] * xy[a, 1];
        }
        double detJ = j11 * j22 - j12 * j21;
        if (detJ <= 0)
            throw new InvalidOperationException("Element Jacobian is non-positive (badly shaped or wrongly ordered quad).");

        double i11 = j22 / detJ, i12 = -j12 / detJ, i21 = -j21 / detJ, i22 = j11 / detJ;

        var b = new double[3, 8];
        for (int a = 0; a < 4; a++)
        {
            double dNx = i11 * dN[a, 0] + i12 * dN[a, 1];
            double dNy = i21 * dN[a, 0] + i22 * dN[a, 1];
            b[0, 2 * a] = dNx;
            b[1, 2 * a + 1] = dNy;
            b[2, 2 * a] = dNy;
            b[2, 2 * a + 1] = dNx;
        }
        return (b, detJ);
    }
}
