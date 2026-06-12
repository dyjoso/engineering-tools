namespace FeaCore;

/// <summary>
/// 8-node serendipity quadrilateral, plane stress, isoparametric with 3x3 Gauss
/// integration. Node order: 4 corners counter-perimeter (1,2,3,4) then midsides
/// (5 between 1-2, 6 between 2-3, 7 between 3-4, 8 between 4-1).
///
/// Because the formulation is fully isoparametric, a crack-tip variant needs no
/// new element: moving the two midside nodes adjacent to a crack-tip corner to
/// the quarter points produces the 1/sqrt(r) strain singularity used for stress
/// intensity factor extraction (Barsoum quarter-point element).
/// </summary>
public static class Quad8
{
    // Natural coordinates of the 8 nodes (corner order then midsides)
    public static readonly (double Xi, double Eta)[] NodeXiEta =
    {
        (-1, -1), (1, -1), (1, 1), (-1, 1),
        (0, -1), (1, 0), (0, 1), (-1, 0)
    };

    // 2x2 REDUCED integration (the standard for serendipity Q8 membranes - what
    // Nastran's QUAD8 and Abaqus's CPS8R use). Full 3x3 integration carries mild
    // shear stiffening in thin-beam bending: measured -1.76% on MacNeal's straight
    // cantilever (6x1 rectangular mesh), which 2x2 reduces to well under 1%.
    // The lone spurious zero-energy mode of a single reduced Q8 is non-communicable
    // in meshes and is guarded by the solver's residual equilibrium check.
    private static readonly double[] G2 = { -1.0 / Math.Sqrt(3.0), 1.0 / Math.Sqrt(3.0) };

    /// <summary>Shape function derivatives wrt (xi, eta) - 8 rows of (dN/dxi, dN/deta).</summary>
    public static void ShapeDerivs(double xi, double eta, double[,] dN)
    {
        // Corners
        dN[0, 0] = (1 - eta) * (2 * xi + eta) / 4; dN[0, 1] = (1 - xi) * (xi + 2 * eta) / 4;
        dN[1, 0] = (1 - eta) * (2 * xi - eta) / 4; dN[1, 1] = (1 + xi) * (2 * eta - xi) / 4;
        dN[2, 0] = (1 + eta) * (2 * xi + eta) / 4; dN[2, 1] = (1 + xi) * (2 * eta + xi) / 4;
        dN[3, 0] = (1 + eta) * (2 * xi - eta) / 4; dN[3, 1] = (1 - xi) * (2 * eta - xi) / 4;
        // Midsides
        dN[4, 0] = -xi * (1 - eta); dN[4, 1] = -(1 - xi * xi) / 2;
        dN[5, 0] = (1 - eta * eta) / 2; dN[5, 1] = -eta * (1 + xi);
        dN[6, 0] = -xi * (1 + eta); dN[6, 1] = (1 - xi * xi) / 2;
        dN[7, 0] = -(1 - eta * eta) / 2; dN[7, 1] = -eta * (1 - xi);
    }

    /// <summary>16x16 plane-stress stiffness. xy is 8x2 nodal coordinates in node order.</summary>
    public static double[,] Stiffness(double[,] xy, double e, double nu, double t)
    {
        var ke = new double[16, 16];
        double c = e / (1 - nu * nu);
        double d11 = c, d12 = c * nu, d33 = c * (1 - nu) / 2;

        var b = new double[3, 16];
        var dN = new double[8, 2];
        for (int gi = 0; gi < 2; gi++)
            for (int gj = 0; gj < 2; gj++)
            {
                double detJ = BMatrix(xy, G2[gi], G2[gj], b, dN);
                if (detJ <= 0)
                    throw new InvalidOperationException("Quad8 Jacobian is non-positive at a Gauss point (badly shaped element).");
                double w = t * detJ; // 2x2 Gauss weights are 1

                for (int i = 0; i < 16; i++)
                {
                    double b0i = b[0, i], b1i = b[1, i], b2i = b[2, i];
                    double db0 = d11 * b0i + d12 * b1i;
                    double db1 = d12 * b0i + d11 * b1i;
                    double db2 = d33 * b2i;
                    for (int j = 0; j < 16; j++)
                        ke[i, j] += (db0 * b[0, j] + db1 * b[1, j] + db2 * b[2, j]) * w;
                }
            }
        return ke;
    }

    public static (double sx, double sy, double sxy) StressAtCenter(double[,] xy, double[] ue, double e, double nu)
        => StressAt(xy, ue, e, nu, 0, 0);

    /// <summary>
    /// Stress at the 8 node positions (for nodal averaging). At a quarter-point
    /// crack-tip element the Jacobian is singular at the tip node - the evaluation
    /// point is nudged inward in that case (the true tip stress is singular anyway;
    /// SIF extraction uses displacements, not tip stresses).
    /// </summary>
    public static (double sx, double sy, double sxy)[] StressAtNodes(double[,] xy, double[] ue, double e, double nu)
    {
        var result = new (double, double, double)[8];
        for (int a = 0; a < 8; a++)
        {
            var (xi, eta) = NodeXiEta[a];
            result[a] = StressAtGuarded(xy, ue, e, nu, xi, eta);
        }
        return result;
    }

    private static (double, double, double) StressAtGuarded(double[,] xy, double[] ue, double e, double nu, double xi, double eta)
    {
        for (double shrink = 1.0; shrink > 0.9; shrink -= 0.02)
        {
            var b = new double[3, 16];
            var dN = new double[8, 2];
            double detJ = BMatrix(xy, xi * shrink, eta * shrink, b, dN);
            if (Math.Abs(detJ) < 1e-10) continue; // singular (quarter-point tip) - nudge inward
            return Stress(b, ue, e, nu);
        }
        return (0, 0, 0);
    }

    private static (double sx, double sy, double sxy) StressAt(double[,] xy, double[] ue, double e, double nu, double xi, double eta)
    {
        var b = new double[3, 16];
        var dN = new double[8, 2];
        BMatrix(xy, xi, eta, b, dN);
        return Stress(b, ue, e, nu);
    }

    private static (double, double, double) Stress(double[,] b, double[] ue, double e, double nu)
    {
        double ex = 0, ey = 0, gxy = 0;
        for (int i = 0; i < 16; i++)
        {
            ex += b[0, i] * ue[i];
            ey += b[1, i] * ue[i];
            gxy += b[2, i] * ue[i];
        }
        double c = e / (1 - nu * nu);
        return (c * (ex + nu * ey), c * (ey + nu * ex), c * (1 - nu) / 2 * gxy);
    }

    /// <summary>Fills the 3x16 strain-displacement matrix; returns detJ (not validated).</summary>
    private static double BMatrix(double[,] xy, double xi, double eta, double[,] b, double[,] dN)
    {
        ShapeDerivs(xi, eta, dN);

        double j11 = 0, j12 = 0, j21 = 0, j22 = 0;
        for (int a = 0; a < 8; a++)
        {
            j11 += dN[a, 0] * xy[a, 0]; j12 += dN[a, 0] * xy[a, 1];
            j21 += dN[a, 1] * xy[a, 0]; j22 += dN[a, 1] * xy[a, 1];
        }
        double detJ = j11 * j22 - j12 * j21;
        if (detJ == 0) return 0;

        double i11 = j22 / detJ, i12 = -j12 / detJ, i21 = -j21 / detJ, i22 = j11 / detJ;
        Array.Clear(b, 0, b.Length);
        for (int a = 0; a < 8; a++)
        {
            double dNx = i11 * dN[a, 0] + i12 * dN[a, 1];
            double dNy = i21 * dN[a, 0] + i22 * dN[a, 1];
            b[0, 2 * a] = dNx;
            b[1, 2 * a + 1] = dNy;
            b[2, 2 * a] = dNy;
            b[2, 2 * a + 1] = dNx;
        }
        return detJ;
    }
}

/// <summary>Perimeter/topology helpers shared by the solver, mesher and renderer.</summary>
public static class ElementTopology
{
    public static bool IsQuad4(FeElement el) => el.Type == "quad" && el.NodeIds.Count == 4;
    public static bool IsQuad8(FeElement el) => el.Type == "quad8" && el.NodeIds.Count == 8;
    public static bool IsSupported(FeElement el) => IsQuad4(el) || IsQuad8(el);

    /// <summary>Node ids around the element boundary in perimeter order.</summary>
    public static int[] BoundaryNodeIds(FeElement el)
    {
        if (IsQuad8(el))
        {
            var n = el.NodeIds;
            return new[] { n[0], n[4], n[1], n[5], n[2], n[6], n[3], n[7] };
        }
        return el.NodeIds.ToArray();
    }

    /// <summary>Consecutive perimeter segments as node-id pairs (8 for quad8, 4 for quad4).</summary>
    public static IEnumerable<(int a, int b)> PerimeterEdges(FeElement el)
    {
        var ring = BoundaryNodeIds(el);
        for (int i = 0; i < ring.Length; i++)
            yield return (ring[i], ring[(i + 1) % ring.Length]);
    }
}
