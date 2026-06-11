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

public sealed class SolveResult
{
    public required IReadOnlyList<NodeResult> Displacements { get; init; }
    public required IReadOnlyList<ElementStress> ElementStresses { get; init; }
    public required IReadOnlyList<SpringLoad> SpringLoads { get; init; }
    public required IReadOnlyList<BarLoad> BarLoads { get; init; }
    public required IReadOnlyList<Reaction> Reactions { get; init; }
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
        var dofOf = new Dictionary<int, int>(n); // node id -> first DOF index
        for (int i = 0; i < n; i++) dofOf[nodes[i].Id] = 2 * i;

        var membById = model.Membranes.ToDictionary(m => m.Id);
        var nodeById = model.FeNodes.ToDictionary(nd => nd.Id);

        // ---- Assemble global triplets ----
        var coo = new CoordinateStorage<double>(nDof, nDof, Math.Max(16, 64 * model.FeElements.Count + 16 * (model.FeSprings.Count + model.FeBars.Count)));
        var diag = new double[nDof];

        void Add(int r, int c, double v)
        {
            coo.At(r, c, v);
            if (r == c) diag[r] += v;
        }

        foreach (var el in model.FeElements)
        {
            if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
            var memb = el.MembraneId.HasValue && membById.TryGetValue(el.MembraneId.Value, out var mm) ? mm : null;
            double e = el.PropE ?? memb?.MaterialE ?? throw new InvalidOperationException($"Element {el.Id}: no E available.");
            double nu = el.PropNu ?? memb?.MaterialNu ?? 0.0;
            double t = el.PropT ?? memb?.MaterialT ?? throw new InvalidOperationException($"Element {el.Id}: no thickness available.");

            var xy = new double[4, 2];
            var edof = new int[8];
            for (int a = 0; a < 4; a++)
            {
                var nd = nodeById[el.NodeIds[a]];
                xy[a, 0] = nd.X; xy[a, 1] = nd.Y;
                edof[2 * a] = dofOf[nd.Id];
                edof[2 * a + 1] = dofOf[nd.Id] + 1;
            }

            var ke = Quad4.Stiffness(xy, e, nu, t);
            for (int r = 0; r < 8; r++)
                for (int c = 0; c < 8; c++)
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

        // ---- Loads and constraints ----
        var f = new double[nDof];
        var prescribed = new double?[nDof]; // non-null => DOF has a prescribed value
        foreach (var nd in nodes)
        {
            if (nd.Bc is null) continue;
            int i = dofOf[nd.Id];
            switch (nd.Bc.Type)
            {
                case "fixed":
                    if (nd.Bc.Value.FixX) prescribed[i] = 0.0;
                    if (nd.Bc.Value.FixY) prescribed[i + 1] = 0.0;
                    break;
                case "load":
                    f[i] += nd.Bc.Value.Fx ?? 0.0;
                    f[i + 1] += nd.Bc.Value.Fy ?? 0.0;
                    break;
                case "enforced":
                    if (nd.Bc.Value.Dx.HasValue) prescribed[i] = nd.Bc.Value.Dx.Value;
                    if (nd.Bc.Value.Dy.HasValue) prescribed[i + 1] = nd.Bc.Value.Dy.Value;
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
                return (prescribed[i] is null && diag[i] == 0.0) ||
                       (prescribed[i + 1] is null && diag[i + 1] == 0.0);
            })
            .Select(nd => nd.Id)
            .ToList();
        if (orphans.Count > 0)
            throw new InvalidOperationException(
                $"FE node(s) with no stiffness attached: {string.Join(", ", orphans)}. " +
                "Attach elements/springs/bars to them or delete them.");

        // ---- Partition: solve K_ff u_f = f_f - K_fc u_c ----
        var freeIndex = new int[nDof];
        int nFree = 0;
        for (int i = 0; i < nDof; i++) freeIndex[i] = prescribed[i] is null ? nFree++ : -1;
        int nCon = nDof - nFree;

        var u = new double[nDof];
        for (int i = 0; i < nDof; i++) if (prescribed[i] is { } v) u[i] = v;

        var full = (SparseMatrix)SparseMatrix.OfIndexed(coo); // duplicates summed
        var rhs = new double[nFree];
        for (int i = 0; i < nDof; i++) if (freeIndex[i] >= 0) rhs[freeIndex[i]] = f[i];

        // Reduced matrix + RHS correction for prescribed values, built from the full CSC
        var cooFF = new CoordinateStorage<double>(nFree, nFree, full.NonZerosCount);
        var ap = full.ColumnPointers; var ai = full.RowIndices; var ax = full.Values;
        for (int col = 0; col < nDof; col++)
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

            for (int i = 0; i < nDof; i++) if (freeIndex[i] >= 0) u[i] = uf[freeIndex[i]];
        }

        // ---- Reactions: r = K u - f_applied, reported at prescribed DOFs ----
        var ku = new double[nDof];
        full.Multiply(u, ku);
        var reactions = new List<Reaction>();
        foreach (var nd in nodes)
        {
            int i = dofOf[nd.Id];
            bool px = prescribed[i] is not null, py = prescribed[i + 1] is not null;
            if (!px && !py) continue;
            reactions.Add(new Reaction
            {
                NodeId = nd.Id,
                Rx = px ? ku[i] - f[i] : 0.0,
                Ry = py ? ku[i + 1] - f[i + 1] : 0.0
            });
        }

        // ---- Results ----
        var disps = nodes.Select(nd => new NodeResult
        {
            NodeId = nd.Id,
            Dx = u[dofOf[nd.Id]],
            Dy = u[dofOf[nd.Id] + 1]
        }).ToList();

        var stresses = new List<ElementStress>(model.FeElements.Count);
        foreach (var el in model.FeElements)
        {
            if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
            var memb = el.MembraneId.HasValue && membById.TryGetValue(el.MembraneId.Value, out var mm) ? mm : null;
            double e = el.PropE ?? memb?.MaterialE ?? 0.0;
            double nu = el.PropNu ?? memb?.MaterialNu ?? 0.0;

            var xy = new double[4, 2];
            var ue = new double[8];
            for (int a = 0; a < 4; a++)
            {
                var nd = nodeById[el.NodeIds[a]];
                xy[a, 0] = nd.X; xy[a, 1] = nd.Y;
                ue[2 * a] = u[dofOf[nd.Id]];
                ue[2 * a + 1] = u[dofOf[nd.Id] + 1];
            }
            var (sx, sy, sxy) = Quad4.StressAtCenter(xy, ue, e, nu);
            double vm = Math.Sqrt(sx * sx + sy * sy - sx * sy + 3 * sxy * sxy);
            stresses.Add(new ElementStress { ElementId = el.Id, Sxx = sx, Syy = sy, Sxy = sxy, SigmaVM = vm });
        }

        var springLoads = model.FeSprings.Select(s =>
        {
            int i = dofOf[s.FeNodeId1], j = dofOf[s.FeNodeId2];
            return new SpringLoad
            {
                Id = s.Id,
                Fx = s.Stiffness * (u[j] - u[i]),
                Fy = s.Stiffness * (u[j + 1] - u[i + 1])
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
            double elong = (u[j] - u[i]) * cx + (u[j + 1] - u[i + 1]) * cy;
            double p = b.E * b.A / len * elong;
            return new BarLoad { Id = b.Id, P = p, Stress = p / b.A, Length = len };
        }).ToList();

        sw.Stop();
        return new SolveResult
        {
            Displacements = disps,
            ElementStresses = stresses,
            SpringLoads = springLoads,
            BarLoads = barLoads,
            Reactions = reactions,
            DofCount = nDof,
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
    {
        var (b, _) = BMatrix(xy, 0, 0);
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
