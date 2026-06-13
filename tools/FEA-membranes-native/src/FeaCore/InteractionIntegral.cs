namespace FeaCore;

/// <summary>
/// Domain (equivalent domain integral) interaction integral for 2D plane-stress
/// crack tips - the standard route to mesh-insensitive K_I / K_II with 1-2%
/// accuracy, independent of tip element shape:
///
///   I = Int_A [ s1_ij du2_i/dx1 + s2_ij du1_i/dx1 - W12 d_1j ] dq/dx_j dA
///   K_mode = (E'/2) * I_mode      (auxiliary field with K_mode = 1)
///
/// where (1) is the FE solution, (2) the Williams auxiliary field for unit K_I or
/// K_II, W12 = s1:e2 the interaction strain energy, q a weight equal to 1 at the
/// tip ramping radially to 0 at the domain boundary, and x1 the crack-forward
/// direction. All quantities are evaluated in the crack-local frame.
/// </summary>
public static class InteractionIntegral
{
    private static readonly double[] G3 = { -Math.Sqrt(0.6), 0, Math.Sqrt(0.6) };
    private static readonly double[] W3 = { 5.0 / 9.0, 8.0 / 9.0, 5.0 / 9.0 };

    public sealed record Result(double K1, double K2, int DomainElements);

    /// <summary>
    /// Evaluate K_I / K_II for a crack using elements within domainRadius of the tip.
    /// disp maps node id to its solved displacement. Returns null if no usable
    /// domain elements exist (e.g. the mesh around the tip is not Quad8).
    /// </summary>
    public static Result? Compute(FeModel model, Crack crack,
        IReadOnlyDictionary<int, (double dx, double dy)> disp, double domainRadius)
    {
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        if (!nodeById.TryGetValue(crack.TipNodeId, out var tip) ||
            !nodeById.TryGetValue(crack.FaceACornerNodeId, out var faceCorner)) return null;

        // Crack-local frame: e1 = forward (ahead of the tip), e2 = e1 rotated +90deg
        double bx = faceCorner.X - tip.X, by = faceCorner.Y - tip.Y;
        double bl = Math.Sqrt(bx * bx + by * by);
        if (bl <= 0) return null;
        double e1x = -bx / bl, e1y = -by / bl;
        double e2x = -e1y, e2y = e1x;

        // Material from an element containing the tip
        var tipEl = model.FeElements.FirstOrDefault(e => e.NodeIds.Contains(crack.TipNodeId));
        if (tipEl is null) return null;
        var memb = tipEl.MembraneId.HasValue
            ? model.Membranes.FirstOrDefault(m => m.Id == tipEl.MembraneId.Value) : null;
        double eMod = tipEl.PropE ?? memb?.MaterialE ?? 0;
        double nu = tipEl.PropNu ?? memb?.MaterialNu ?? 0;
        if (eMod <= 0) return null;
        double mu = eMod / (2 * (1 + nu));
        double kappa = (3 - nu) / (1 + nu); // plane stress
        double ePrime = eMod;               // plane stress

        // Domain: Quad8 elements with at least one node inside the radius
        bool InR(FeNode n) =>
            (n.X - tip.X) * (n.X - tip.X) + (n.Y - tip.Y) * (n.Y - tip.Y) <= domainRadius * domainRadius;
        var domain = model.FeElements
            .Where(ElementTopology.IsQuad8)
            .Where(e => e.NodeIds.All(nodeById.ContainsKey))
            .Where(e => e.NodeIds.Any(id => InR(nodeById[id])))
            .ToList();
        if (domain.Count == 0) return null;

        // Plane-stress D matrix for the actual stress recovery
        double c = eMod / (1 - nu * nu);
        double d11 = c, d12 = c * nu, d33 = c * (1 - nu) / 2;

        double i1 = 0, i2 = 0; // interaction integrals for aux modes I and II
        var dN = new double[8, 2];
        var nv = new double[8];

        foreach (var el in domain)
        {
            var xs = new double[8];
            var ys = new double[8];
            var ux = new double[8];
            var uy = new double[8];
            var qn = new double[8];
            for (int a = 0; a < 8; a++)
            {
                var nd = nodeById[el.NodeIds[a]];
                xs[a] = nd.X; ys[a] = nd.Y;
                var d = disp.GetValueOrDefault(nd.Id);
                ux[a] = d.dx; uy[a] = d.dy;
                double r = Math.Sqrt((nd.X - tip.X) * (nd.X - tip.X) + (nd.Y - tip.Y) * (nd.Y - tip.Y));
                qn[a] = Math.Clamp(1 - r / domainRadius, 0, 1);
            }
            if (qn.All(v => v <= 0)) continue;

            for (int gi = 0; gi < 3; gi++)
                for (int gj = 0; gj < 3; gj++)
                {
                    double xi = G3[gi], eta = G3[gj];
                    Quad8.ShapeDerivs(xi, eta, dN);
                    Quad8.Shape(xi, eta, nv);

                    // Jacobian and global shape gradients
                    double j11 = 0, j12 = 0, j21 = 0, j22 = 0;
                    for (int a = 0; a < 8; a++)
                    {
                        j11 += dN[a, 0] * xs[a]; j12 += dN[a, 0] * ys[a];
                        j21 += dN[a, 1] * xs[a]; j22 += dN[a, 1] * ys[a];
                    }
                    double detJ = j11 * j22 - j12 * j21;
                    if (detJ <= 0) continue;
                    double inv11 = j22 / detJ, inv12 = -j12 / detJ, inv21 = -j21 / detJ, inv22 = j11 / detJ;

                    // Gauss point position, q, gradients of u and q (global)
                    double gx = 0, gy = 0, q = 0;
                    double duxdx = 0, duxdy = 0, duydx = 0, duydy = 0, dqdx = 0, dqdy = 0;
                    for (int a = 0; a < 8; a++)
                    {
                        double dNx = inv11 * dN[a, 0] + inv12 * dN[a, 1];
                        double dNy = inv21 * dN[a, 0] + inv22 * dN[a, 1];
                        gx += nv[a] * xs[a]; gy += nv[a] * ys[a]; q += nv[a] * qn[a];
                        duxdx += dNx * ux[a]; duxdy += dNy * ux[a];
                        duydx += dNx * uy[a]; duydy += dNy * uy[a];
                        dqdx += dNx * qn[a]; dqdy += dNy * qn[a];
                    }
                    if (Math.Abs(dqdx) < 1e-30 && Math.Abs(dqdy) < 1e-30) continue;

                    // Rotate everything to the crack-local frame
                    double xl = (gx - tip.X) * e1x + (gy - tip.Y) * e1y;
                    double yl = (gx - tip.X) * e2x + (gy - tip.Y) * e2y;
                    double r2 = Math.Sqrt(xl * xl + yl * yl);
                    if (r2 < 1e-12) continue;
                    double theta = Math.Atan2(yl, xl);

                    // Actual displacement gradient in local frame: G_loc = R G R^T
                    double g11 = duxdx, g12 = duxdy, g21 = duydx, g22 = duydy;
                    double l11 = e1x * (g11 * e1x + g12 * e1y) + e1y * (g21 * e1x + g22 * e1y);
                    double l12 = e1x * (g11 * e2x + g12 * e2y) + e1y * (g21 * e2x + g22 * e2y);
                    double l21 = e2x * (g11 * e1x + g12 * e1y) + e2y * (g21 * e1x + g22 * e1y);
                    double l22 = e2x * (g11 * e2x + g12 * e2y) + e2y * (g21 * e2x + g22 * e2y);

                    // Actual stresses in local frame (from local strains, plane stress)
                    double exx = l11, eyy = l22, gxy = l12 + l21;
                    double s1xx = d11 * exx + d12 * eyy;
                    double s1yy = d12 * exx + d11 * eyy;
                    double s1xy = d33 * gxy;

                    // q gradient in local frame
                    double dq1 = dqdx * e1x + dqdy * e1y;
                    double dq2 = dqdx * e2x + dqdy * e2y;

                    double w = W3[gi] * W3[gj] * detJ;

                    for (int mode = 1; mode <= 2; mode++)
                    {
                        var (s2xx, s2yy, s2xy) = AuxStress(mode, r2, theta);
                        var (du2_1d1, du2_2d1) = AuxDispGradX1(mode, xl, yl, mu, kappa);

                        // Interaction strain energy: s1 : e2(aux), engineering shear
                        double e2xx = (s2xx - nu * s2yy) / eMod;
                        double e2yy = (s2yy - nu * s2xx) / eMod;
                        double g2xy = s2xy / mu;
                        double w12 = s1xx * e2xx + s1yy * e2yy + s1xy * g2xy;

                        // F_j = s1_ij du2_i/dx1 + s2_ij du1_i/dx1 - W12 d1j
                        double f1 = s1xx * du2_1d1 + s1xy * du2_2d1
                                  + s2xx * l11 + s2xy * l21 - w12;
                        double f2 = s1xy * du2_1d1 + s1yy * du2_2d1
                                  + s2xy * l11 + s2yy * l21;

                        double contrib = (f1 * dq1 + f2 * dq2) * w;
                        if (mode == 1) i1 += contrib; else i2 += contrib;
                    }
                }
        }

        return new Result(ePrime / 2 * i1, ePrime / 2 * i2, domain.Count);
    }

    /// <summary>Williams near-tip stresses for unit K of the given mode (crack-local frame).</summary>
    private static (double sxx, double syy, double sxy) AuxStress(int mode, double r, double theta)
    {
        double f = 1.0 / Math.Sqrt(2 * Math.PI * r);
        double c2 = Math.Cos(theta / 2), s2 = Math.Sin(theta / 2);
        double c32 = Math.Cos(3 * theta / 2), s32 = Math.Sin(3 * theta / 2);
        if (mode == 1)
            return (f * c2 * (1 - s2 * s32),
                    f * c2 * (1 + s2 * s32),
                    f * c2 * s2 * c32);
        return (-f * s2 * (2 + c2 * c32),
                 f * s2 * c2 * c32,
                 f * c2 * (1 - s2 * s32));
    }

    /// <summary>Williams near-tip displacements for unit K (crack-local frame).</summary>
    private static (double u1, double u2) AuxDisp(int mode, double x, double y, double mu, double kappa)
    {
        double r = Math.Sqrt(x * x + y * y);
        double theta = Math.Atan2(y, x);
        double f = Math.Sqrt(r / (2 * Math.PI)) / (2 * mu);
        double c2 = Math.Cos(theta / 2), s2 = Math.Sin(theta / 2), ct = Math.Cos(theta);
        if (mode == 1)
            return (f * c2 * (kappa - ct), f * s2 * (kappa - ct));
        return (f * s2 * (kappa + 2 + ct), -f * c2 * (kappa - 2 + ct));
    }

    /// <summary>
    /// d(u_aux)/dx1 by central finite difference on the closed-form displacement -
    /// avoids hand-derived gradient formulas (a classic source of sign errors).
    /// </summary>
    private static (double du1, double du2) AuxDispGradX1(int mode, double x, double y, double mu, double kappa)
    {
        double r = Math.Sqrt(x * x + y * y);
        double h = Math.Max(1e-8, 1e-6 * r);
        var (u1p, u2p) = AuxDisp(mode, x + h, y, mu, kappa);
        var (u1m, u2m) = AuxDisp(mode, x - h, y, mu, kappa);
        return ((u1p - u1m) / (2 * h), (u2p - u2m) / (2 * h));
    }
}
