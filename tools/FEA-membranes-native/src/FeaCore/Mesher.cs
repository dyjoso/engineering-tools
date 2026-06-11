namespace FeaCore;

/// <summary>
/// Structured (Coons patch) meshing of 4-sided membranes with optional circular-arc
/// edges, matching the webtool's generateStructuredMesh/getArcPoint behaviour so the
/// two tools produce identical meshes for the same model.
/// Edge i runs from corner i to corner (i+1)%4; positive radius bulges outward
/// (convex), negative inward (concave). Y-down coordinates.
/// </summary>
public static class Mesher
{
    public static (double X, double Y) ArcPoint(double x0, double y0, double x1, double y1, double r, double t)
    {
        if (r == 0 || !double.IsFinite(r))
            return (x0 + t * (x1 - x0), y0 + t * (y1 - y0));

        double dx = x1 - x0, dy = y1 - y0;
        double len = Math.Sqrt(dx * dx + dy * dy);
        double absR = Math.Abs(r);
        if (absR < len / 2) { r = Math.Sign(r) * len / 2; absR = len / 2; } // clamp to half-chord

        double mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
        double h = Math.Sqrt(Math.Max(0, absR * absR - len * len / 4));
        double nx = dy / len, ny = -dx / len;

        double cx = mx - (r > 0 ? h : -h) * nx;
        double cy = my - (r > 0 ? h : -h) * ny;

        double a0 = Math.Atan2(y0 - cy, x0 - cx);
        double a1 = Math.Atan2(y1 - cy, x1 - cx);
        double diff = a1 - a0;
        if (r > 0)
        {
            while (diff > 0) diff -= 2 * Math.PI;
            while (diff < -Math.PI) diff += 2 * Math.PI;
        }
        else
        {
            while (diff < 0) diff += 2 * Math.PI;
            while (diff > Math.PI) diff -= 2 * Math.PI;
        }
        double a = a0 + t * diff;
        return (cx + absR * Math.Cos(a), cy + absR * Math.Sin(a));
    }

    /// <summary>Remove all FE nodes/elements belonging to a membrane (springs/bars attached to them too).</summary>
    public static void ClearMesh(FeModel model, int membraneId)
    {
        var doomedNodes = model.FeNodes.Where(n => n.MembraneId == membraneId).Select(n => n.Id).ToHashSet();
        model.FeElements.RemoveAll(e => e.MembraneId == membraneId);
        model.FeSprings.RemoveAll(s => doomedNodes.Contains(s.FeNodeId1) || doomedNodes.Contains(s.FeNodeId2));
        model.FeBars.RemoveAll(b => doomedNodes.Contains(b.FeNodeId1) || doomedNodes.Contains(b.FeNodeId2));
        model.FeNodes.RemoveAll(n => n.MembraneId == membraneId);
    }

    /// <summary>
    /// Mesh a 4-sided membrane M x N (re-meshing replaces any existing mesh).
    /// Returns (nodesCreated, elementsCreated).
    /// </summary>
    public static (int nodes, int elements) MeshMembrane(FeModel model, Membrane membrane, int m, int n)
    {
        if (membrane.NodeIds.Count != 4)
            throw new InvalidOperationException($"Surface {membrane.Id} is not 4-sided.");
        if (m < 1 || n < 1) throw new ArgumentOutOfRangeException(nameof(m), "Divisions must be >= 1.");

        var corners = membrane.NodeIds
            .Select(id => model.Nodes.FirstOrDefault(g => g.Id == id)
                ?? throw new InvalidOperationException($"Surface {membrane.Id}: geometry node {id} missing."))
            .ToArray();

        ClearMesh(model, membrane.Id);

        int nextNodeId = model.FeNodes.Count == 0 ? 1 : model.FeNodes.Max(x => x.Id) + 1;
        int nextElId = model.FeElements.Count == 0 ? 1 : model.FeElements.Max(x => x.Id) + 1;

        (double X, double Y) Boundary(int edge, double t)
        {
            var a = corners[edge];
            var b = corners[(edge + 1) % 4];
            double r = edge < membrane.EdgeRadii.Count ? membrane.EdgeRadii[edge] : 0;
            return ArcPoint(a.X, a.Y, b.X, b.Y, r, t);
        }

        var grid = new int[m + 1, n + 1];
        int created = 0;
        for (int i = 0; i <= m; i++)
        {
            for (int j = 0; j <= n; j++)
            {
                double u = (double)i / m, v = (double)j / n;

                var c1 = Boundary(0, u);       // bottom (v=0)
                var c2 = Boundary(2, 1 - u);   // top (v=1), reversed
                var d1 = Boundary(3, 1 - v);   // left (u=0), reversed
                var d2 = Boundary(1, v);       // right (u=1)

                double sx = (1 - v) * c1.X + v * c2.X + (1 - u) * d1.X + u * d2.X
                    - ((1 - u) * (1 - v) * corners[0].X + u * (1 - v) * corners[1].X + u * v * corners[2].X + (1 - u) * v * corners[3].X);
                double sy = (1 - v) * c1.Y + v * c2.Y + (1 - u) * d1.Y + u * d2.Y
                    - ((1 - u) * (1 - v) * corners[0].Y + u * (1 - v) * corners[1].Y + u * v * corners[2].Y + (1 - u) * v * corners[3].Y);

                var node = new FeNode { Id = nextNodeId++, X = sx, Y = sy, MembraneId = membrane.Id };
                model.FeNodes.Add(node);
                grid[i, j] = node.Id;
                created++;
            }
        }

        int els = 0;
        for (int i = 0; i < m; i++)
            for (int j = 0; j < n; j++)
            {
                model.FeElements.Add(new FeElement
                {
                    Id = nextElId++,
                    Type = "quad",
                    NodeIds = { grid[i, j], grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1] },
                    MembraneId = membrane.Id
                });
                els++;
            }

        membrane.MeshM = m;
        membrane.MeshN = n;
        return (created, els);
    }

    /// <summary>
    /// Move a geometry (corner) point. Meshed surfaces using the point are re-meshed
    /// with their stored divisions so the mesh follows the geometry. Returns a
    /// human-readable summary of what was updated.
    /// </summary>
    public static string MoveGeometryPoint(FeModel model, int pointId, double x, double y)
    {
        var point = model.Nodes.FirstOrDefault(g => g.Id == pointId)
            ?? throw new InvalidOperationException($"Point {pointId} not found.");
        point.X = x;
        point.Y = y;

        var affected = model.Membranes.Where(s => s.NodeIds.Contains(pointId)).ToList();
        var remeshed = new List<int>();
        var cleared = new List<int>();
        foreach (var s in affected)
        {
            bool isMeshed = model.FeElements.Any(e => e.MembraneId == s.Id);
            if (!isMeshed) continue;
            if (s.MeshM is { } m && s.MeshN is { } n)
            {
                MeshMembrane(model, s, m, n); // clears old mesh first
                remeshed.Add(s.Id);
            }
            else
            {
                ClearMesh(model, s.Id);
                cleared.Add(s.Id);
            }
        }

        var parts = new List<string> { $"Point {pointId} moved to ({x:G6}, {y:G6})" };
        if (remeshed.Count > 0) parts.Add($"surface(s) {string.Join(", ", remeshed)} re-meshed");
        if (cleared.Count > 0) parts.Add($"surface(s) {string.Join(", ", cleared)} mesh cleared (unknown divisions)");
        return string.Join("; ", parts) + ".";
    }

    /// <summary>
    /// Delete elements, then remove FE nodes that are no longer referenced by any
    /// element, spring, or bar (so the solver's orphan check stays clean).
    /// Returns (elementsDeleted, orphanNodesDeleted).
    /// </summary>
    public static (int elements, int orphanNodes) DeleteElements(FeModel model, IReadOnlyCollection<int> elementIds)
    {
        var doomed = elementIds.ToHashSet();
        int before = model.FeElements.Count;
        model.FeElements.RemoveAll(e => doomed.Contains(e.Id));
        int removed = before - model.FeElements.Count;

        var referenced = new HashSet<int>();
        foreach (var e in model.FeElements) referenced.UnionWith(e.NodeIds);
        foreach (var s in model.FeSprings) { referenced.Add(s.FeNodeId1); referenced.Add(s.FeNodeId2); }
        foreach (var b in model.FeBars) { referenced.Add(b.FeNodeId1); referenced.Add(b.FeNodeId2); }
        int beforeNodes = model.FeNodes.Count;
        model.FeNodes.RemoveAll(n => !referenced.Contains(n.Id));
        return (removed, beforeNodes - model.FeNodes.Count);
    }

    /// <summary>Create a 4-sided surface (membrane) from corner coordinates. Returns the new membrane.</summary>
    public static Membrane AddSurface(FeModel model, (double X, double Y)[] corners, double e, double nu, double t)
    {
        if (corners.Length != 4) throw new ArgumentException("Exactly 4 corners required.");
        int nextGeoId = model.Nodes.Count == 0 ? 1 : model.Nodes.Max(x => x.Id) + 1;
        int nextMemId = model.Membranes.Count == 0 ? 1 : model.Membranes.Max(x => x.Id) + 1;

        var membrane = new Membrane { Id = nextMemId, MaterialE = e, MaterialNu = nu, MaterialT = t };
        foreach (var (x, y) in corners)
        {
            model.Nodes.Add(new GeometryNode { Id = nextGeoId, X = x, Y = y });
            membrane.NodeIds.Add(nextGeoId++);
        }
        model.Membranes.Add(membrane);
        return membrane;
    }

    /// <summary>Delete a surface, its geometry nodes (if unshared) and its mesh.</summary>
    public static void DeleteSurface(FeModel model, int membraneId)
    {
        var membrane = model.Membranes.FirstOrDefault(x => x.Id == membraneId);
        if (membrane is null) return;
        ClearMesh(model, membraneId);
        var sharedIds = model.Membranes.Where(x => x.Id != membraneId).SelectMany(x => x.NodeIds).ToHashSet();
        model.Nodes.RemoveAll(g => membrane.NodeIds.Contains(g.Id) && !sharedIds.Contains(g.Id));
        model.Membranes.Remove(membrane);
    }

    /// <summary>
    /// Create bar elements chaining the given FE nodes, ordered along their dominant axis
    /// (same behaviour as the webtool's Create Bars). Two nodes give a single bar.
    /// </summary>
    public static List<FeBar> CreateBarsAlongNodes(FeModel model, IReadOnlyList<int> nodeIds, double e, double a)
    {
        if (nodeIds.Count < 2) throw new InvalidOperationException("Select at least 2 nodes for bars.");
        var nodes = nodeIds.Select(id => model.FeNodes.First(n => n.Id == id)).ToList();
        double spanX = nodes.Max(n => n.X) - nodes.Min(n => n.X);
        double spanY = nodes.Max(n => n.Y) - nodes.Min(n => n.Y);
        var ordered = spanX >= spanY ? nodes.OrderBy(n => n.X).ToList() : nodes.OrderBy(n => n.Y).ToList();

        int nextId = model.FeBars.Count == 0 ? 1 : model.FeBars.Max(b => b.Id) + 1;
        var bars = new List<FeBar>();
        for (int i = 0; i + 1 < ordered.Count; i++)
        {
            var bar = new FeBar { Id = nextId++, FeNodeId1 = ordered[i].Id, FeNodeId2 = ordered[i + 1].Id, E = e, A = a };
            model.FeBars.Add(bar);
            bars.Add(bar);
        }
        return bars;
    }
}
