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

    /// <summary>
    /// Remove a membrane's mesh. Nodes still referenced by another membrane's elements
    /// (e.g. after a coincident-node merge stitched two meshes together) are kept;
    /// springs/bars attached only to removed nodes go with them.
    /// </summary>
    public static void ClearMesh(FeModel model, int membraneId)
    {
        model.FeElements.RemoveAll(e => e.MembraneId == membraneId);

        // Nodes of this membrane survive only if something else still references them
        var referenced = new HashSet<int>();
        foreach (var e in model.FeElements) referenced.UnionWith(e.NodeIds);

        var doomedNodes = model.FeNodes
            .Where(n => n.MembraneId == membraneId && !referenced.Contains(n.Id))
            .Select(n => n.Id).ToHashSet();
        model.FeSprings.RemoveAll(s => doomedNodes.Contains(s.FeNodeId1) || doomedNodes.Contains(s.FeNodeId2));
        model.FeBars.RemoveAll(b => doomedNodes.Contains(b.FeNodeId1) || doomedNodes.Contains(b.FeNodeId2));
        PruneRbe2s(model, doomedNodes);
        PruneCracks(model, doomedNodes);
        model.FeNodes.RemoveAll(n => doomedNodes.Contains(n.Id));
    }

    /// <summary>Drop removed nodes from RBE2s; delete RBE2s whose independent node is gone or with no dependents left.</summary>
    private static void PruneRbe2s(FeModel model, HashSet<int> doomedNodes)
    {
        foreach (var r in model.Rbe2s)
            r.DependentNodeIds.RemoveAll(doomedNodes.Contains);
        model.Rbe2s.RemoveAll(r => doomedNodes.Contains(r.IndependentNodeId) || r.DependentNodeIds.Count == 0);
    }

    /// <summary>
    /// Create an RBE2 tying the selected nodes' X and/or Y DOFs to the independent
    /// node (the lowest selected id). Translational only - the membrane model has no
    /// rotational DOFs.
    /// </summary>
    public static Rbe2 CreateRbe2(FeModel model, IReadOnlyCollection<int> nodeIds, bool tieX, bool tieY)
    {
        if (nodeIds.Count < 2) throw new InvalidOperationException("Select at least 2 nodes for an RBE2.");
        if (!tieX && !tieY) throw new InvalidOperationException("Tie at least one direction (X and/or Y).");
        foreach (var id in nodeIds)
            if (model.FeNodes.All(n => n.Id != id))
                throw new InvalidOperationException($"RBE2: node {id} not found.");

        int independent = nodeIds.Min();
        int nextId = model.Rbe2s.Count == 0 ? 1 : model.Rbe2s.Max(r => r.Id) + 1;
        var rbe2 = new Rbe2
        {
            Id = nextId,
            IndependentNodeId = independent,
            DependentNodeIds = nodeIds.Where(id => id != independent).OrderBy(id => id).ToList(),
            TieX = tieX,
            TieY = tieY
        };
        model.Rbe2s.Add(rbe2);
        return rbe2;
    }

    /// <summary>
    /// Merge FE nodes that lie within 'tol' of each other (FEMAP-style coincident-node
    /// merge, used to stitch adjacent meshed surfaces together). The lowest node id in
    /// each cluster survives; element/spring/bar references are remapped.
    /// Pairs connected to each other by a spring are NEVER merged - coincident
    /// spring-joined nodes are this tool's intentional fastener idealisation.
    /// If 'onlyNodeIds' is given, merging is restricted to those nodes.
    /// Returns (nodesMerged, degenerateSpringsRemoved, degenerateBarsRemoved).
    /// </summary>
    public static (int merged, int springsRemoved, int barsRemoved) MergeCoincidentNodes(
        FeModel model, double tol, IReadOnlyCollection<int>? onlyNodeIds = null)
    {
        if (tol <= 0) throw new ArgumentOutOfRangeException(nameof(tol), "Tolerance must be positive.");

        var candidates = onlyNodeIds is null
            ? model.FeNodes
            : model.FeNodes.Where(n => onlyNodeIds.Contains(n.Id)).ToList();

        // Pairs directly joined by a spring are exempt from merging, as are crack-face
        // node pairs (coincident BY DESIGN - merging them would heal the crack)
        var springPairs = new HashSet<long>();
        foreach (var s in model.FeSprings)
        {
            int a = Math.Min(s.FeNodeId1, s.FeNodeId2), b = Math.Max(s.FeNodeId1, s.FeNodeId2);
            springPairs.Add((long)a << 32 | (uint)b);
        }
        var crackNodes = new HashSet<int>();
        foreach (var c in model.Cracks)
        {
            crackNodes.Add(c.FaceAQuarterNodeId); crackNodes.Add(c.FaceACornerNodeId);
            crackNodes.Add(c.FaceBQuarterNodeId); crackNodes.Add(c.FaceBCornerNodeId);
            crackNodes.Add(c.TipNodeId);
        }
        bool SpringJoined(int a, int b) =>
            springPairs.Contains((long)Math.Min(a, b) << 32 | (uint)Math.Max(a, b)) ||
            crackNodes.Contains(a) || crackNodes.Contains(b);

        // Union-find over candidate nodes (lowest id becomes the cluster root)
        var parent = new Dictionary<int, int>();
        foreach (var n in candidates) parent[n.Id] = n.Id;
        int Find(int x)
        {
            while (parent[x] != x) { parent[x] = parent[parent[x]]; x = parent[x]; }
            return x;
        }
        void Union(int a, int b)
        {
            int ra = Find(a), rb = Find(b);
            if (ra == rb) return;
            if (ra < rb) parent[rb] = ra; else parent[ra] = rb;
        }

        // Spatial hash so large models stay O(n)
        var cells = new Dictionary<(long cx, long cy), List<FeNode>>();
        foreach (var n in candidates)
        {
            var key = ((long)Math.Floor(n.X / tol), (long)Math.Floor(n.Y / tol));
            if (!cells.TryGetValue(key, out var list)) cells[key] = list = new List<FeNode>();
            list.Add(n);
        }
        double tol2 = tol * tol;
        foreach (var n in candidates)
        {
            long cx = (long)Math.Floor(n.X / tol), cy = (long)Math.Floor(n.Y / tol);
            for (long dx = -1; dx <= 1; dx++)
                for (long dy = -1; dy <= 1; dy++)
                {
                    if (!cells.TryGetValue((cx + dx, cy + dy), out var list)) continue;
                    foreach (var m in list)
                    {
                        if (m.Id <= n.Id) continue;
                        double ddx = m.X - n.X, ddy = m.Y - n.Y;
                        if (ddx * ddx + ddy * ddy > tol2) continue;
                        if (SpringJoined(n.Id, m.Id)) continue;
                        Union(n.Id, m.Id);
                    }
                }
        }

        // Build remap and apply
        var remap = new Dictionary<int, int>();
        foreach (var n in candidates)
        {
            int root = Find(n.Id);
            if (root != n.Id) remap[n.Id] = root;
        }
        if (remap.Count == 0) return (0, 0, 0);

        var keptById = model.FeNodes.ToDictionary(n => n.Id);
        foreach (var (gone, kept) in remap)
        {
            // Carry the BC over if the surviving node has none
            var goneNode = keptById[gone];
            var keptNode = keptById[kept];
            keptNode.Bc ??= goneNode.Bc;
            keptNode.IsSpringConnectionPoint |= goneNode.IsSpringConnectionPoint;
        }
        int Mapped(int id) => remap.GetValueOrDefault(id, id);
        foreach (var e in model.FeElements)
            for (int i = 0; i < e.NodeIds.Count; i++) e.NodeIds[i] = Mapped(e.NodeIds[i]);
        foreach (var s in model.FeSprings) { s.FeNodeId1 = Mapped(s.FeNodeId1); s.FeNodeId2 = Mapped(s.FeNodeId2); }
        foreach (var b in model.FeBars) { b.FeNodeId1 = Mapped(b.FeNodeId1); b.FeNodeId2 = Mapped(b.FeNodeId2); }

        int springsRemoved = model.FeSprings.RemoveAll(s => s.FeNodeId1 == s.FeNodeId2);
        int barsRemoved = model.FeBars.RemoveAll(b => b.FeNodeId1 == b.FeNodeId2);

        // RBE2s: remap, dedupe dependents, drop self-references and emptied ties
        foreach (var r in model.Rbe2s)
        {
            r.IndependentNodeId = Mapped(r.IndependentNodeId);
            r.DependentNodeIds = r.DependentNodeIds
                .Select(Mapped)
                .Where(id => id != r.IndependentNodeId)
                .Distinct().ToList();
        }
        model.Rbe2s.RemoveAll(r => r.DependentNodeIds.Count == 0);

        model.FeNodes.RemoveAll(n => remap.ContainsKey(n.Id));

        return (remap.Count, springsRemoved, barsRemoved);
    }

    /// <summary>
    /// Map a uniform division index to a biased parameter in [0,1] using a geometric
    /// grading: element lengths form a geometric progression whose largest/smallest
    /// ratio is <paramref name="bias"/>. bias=1 is uniform; bias&gt;1 concentrates fine
    /// elements toward t=0; bias&lt;1 toward t=1.
    /// </summary>
    public static double BiasedT(int i, int n, double bias)
    {
        if (n <= 0) return 0;
        if (bias <= 0 || bias == 1.0 || !double.IsFinite(bias) || n == 1) return (double)i / n;
        double g = Math.Pow(bias, 1.0 / (n - 1));      // common ratio of successive elements
        return (Math.Pow(g, i) - 1) / (Math.Pow(g, n) - 1);
    }

    // Biased parameter for a Quad8 fine-grid index (fi in [0,2n]): corners take the
    // biased node parameter; a midside sits at the parameter midpoint of its element.
    // The uniform case returns fi/(2n) directly so an unbiased Quad8 mesh is bit-for-bit
    // identical to the pre-grading mesher (no spurious coordinate churn).
    private static double FineBiasedT(int fi, int n, double bias)
    {
        if (n <= 1 || bias <= 0 || bias == 1.0 || !double.IsFinite(bias)) return (double)fi / (2 * n);
        int k = fi / 2;
        return fi % 2 == 0 ? BiasedT(k, n, bias)
                           : 0.5 * (BiasedT(k, n, bias) + BiasedT(k + 1, n, bias));
    }

    /// <summary>
    /// Mesh a 4-sided membrane M x N (re-meshing replaces any existing mesh).
    /// quadratic=true creates 8-node serendipity quads (corner + midside nodes).
    /// biasM/biasN apply a geometric grading along edge 1-2 / edge 2-3 respectively
    /// (1 = uniform; &gt;1 fine toward corner 1 / corner 2, &lt;1 fine toward the far end).
    /// Returns (nodesCreated, elementsCreated).
    /// </summary>
    public static (int nodes, int elements) MeshMembrane(FeModel model, Membrane membrane, int m, int n,
        bool quadratic = false, double biasM = 1.0, double biasN = 1.0)
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

        (double X, double Y) Coons(double u, double v)
        {
            var c1 = Boundary(0, u);       // bottom (v=0)
            var c2 = Boundary(2, 1 - u);   // top (v=1), reversed
            var d1 = Boundary(3, 1 - v);   // left (u=0), reversed
            var d2 = Boundary(1, v);       // right (u=1)
            double sx = (1 - v) * c1.X + v * c2.X + (1 - u) * d1.X + u * d2.X
                - ((1 - u) * (1 - v) * corners[0].X + u * (1 - v) * corners[1].X + u * v * corners[2].X + (1 - u) * v * corners[3].X);
            double sy = (1 - v) * c1.Y + v * c2.Y + (1 - u) * d1.Y + u * d2.Y
                - ((1 - u) * (1 - v) * corners[0].Y + u * (1 - v) * corners[1].Y + u * v * corners[2].Y + (1 - u) * v * corners[3].Y);
            return (sx, sy);
        }

        int created = 0, els = 0;
        if (!quadratic)
        {
            var grid = new int[m + 1, n + 1];
            for (int i = 0; i <= m; i++)
                for (int j = 0; j <= n; j++)
                {
                    var (sx, sy) = Coons(BiasedT(i, m, biasM), BiasedT(j, n, biasN));
                    var node = new FeNode { Id = nextNodeId++, X = sx, Y = sy, MembraneId = membrane.Id };
                    model.FeNodes.Add(node);
                    grid[i, j] = node.Id;
                    created++;
                }

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
        }
        else
        {
            // Serendipity grid: a (2M+1) x (2N+1) fine grid without the element-centre
            // points (both indices odd)
            int fm = 2 * m, fn = 2 * n;
            var grid = new int[fm + 1, fn + 1];
            for (int i = 0; i <= fm; i++)
                for (int j = 0; j <= fn; j++)
                {
                    if (i % 2 == 1 && j % 2 == 1) { grid[i, j] = -1; continue; }
                    var (sx, sy) = Coons(FineBiasedT(i, m, biasM), FineBiasedT(j, n, biasN));
                    var node = new FeNode { Id = nextNodeId++, X = sx, Y = sy, MembraneId = membrane.Id };
                    model.FeNodes.Add(node);
                    grid[i, j] = node.Id;
                    created++;
                }

            for (int i = 0; i < m; i++)
                for (int j = 0; j < n; j++)
                {
                    int ci = 2 * i, cj = 2 * j;
                    model.FeElements.Add(new FeElement
                    {
                        Id = nextElId++,
                        Type = "quad8",
                        NodeIds =
                        {
                            grid[ci, cj], grid[ci + 2, cj], grid[ci + 2, cj + 2], grid[ci, cj + 2],     // corners
                            grid[ci + 1, cj], grid[ci + 2, cj + 1], grid[ci + 1, cj + 2], grid[ci, cj + 1] // midsides
                        },
                        MembraneId = membrane.Id
                    });
                    els++;
                }
        }

        membrane.MeshM = m;
        membrane.MeshN = n;
        membrane.MeshQuadratic = quadratic;
        membrane.MeshBiasM = biasM;
        membrane.MeshBiasN = biasN;
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
                MeshMembrane(model, s, m, n, s.MeshQuadratic, s.MeshBiasM, s.MeshBiasN); // clears old mesh first
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
    /// Delete FE nodes and everything that references them: elements containing the
    /// node, springs/bars touching it, RBE2 references. Returns counts of what went.
    /// </summary>
    public static (int nodes, int elements, int springs, int bars) DeleteNodes(
        FeModel model, IReadOnlyCollection<int> nodeIds)
    {
        var doomed = nodeIds.ToHashSet();
        int els = model.FeElements.RemoveAll(e => e.NodeIds.Any(doomed.Contains));
        int springs = model.FeSprings.RemoveAll(s => doomed.Contains(s.FeNodeId1) || doomed.Contains(s.FeNodeId2));
        int bars = model.FeBars.RemoveAll(b => doomed.Contains(b.FeNodeId1) || doomed.Contains(b.FeNodeId2));
        PruneRbe2s(model, doomed);
        PruneCracks(model, doomed);
        int nodes = model.FeNodes.RemoveAll(n => doomed.Contains(n.Id));
        return (nodes, els, springs, bars);
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
        var doomedNodes = model.FeNodes.Where(n => !referenced.Contains(n.Id)).Select(n => n.Id).ToHashSet();
        PruneRbe2s(model, doomedNodes);
        PruneCracks(model, doomedNodes);
        model.FeNodes.RemoveAll(n => doomedNodes.Contains(n.Id));
        return (removed, beforeNodes - model.FeNodes.Count);
    }

    /// <summary>Create a 4-sided surface (membrane) from corner coordinates. Returns the new membrane.</summary>
    public static Membrane AddSurface(FeModel model, (double X, double Y)[] corners, double e, double nu, double t)
        => AddSurface(model, corners.Select(c => (c.X, c.Y, (int?)null)).ToArray(), e, nu, t);

    /// <summary>
    /// Create a 4-sided surface. A corner with ExistingPointId set reuses that geometry
    /// point (surfaces then share it - moving it updates both); otherwise a new point is
    /// created at (X, Y).
    /// </summary>
    public static Membrane AddSurface(FeModel model, (double X, double Y, int? ExistingPointId)[] corners, double e, double nu, double t)
    {
        if (corners.Length != 4) throw new ArgumentException("Exactly 4 corners required.");
        var resolvedIds = new int[4];
        int nextGeoId = model.Nodes.Count == 0 ? 1 : model.Nodes.Max(x => x.Id) + 1;
        for (int i = 0; i < 4; i++)
        {
            if (corners[i].ExistingPointId is { } pid)
            {
                if (model.Nodes.All(g => g.Id != pid))
                    throw new InvalidOperationException($"Corner {i + 1}: point {pid} does not exist.");
                resolvedIds[i] = pid;
            }
            else resolvedIds[i] = -1;
        }
        if (resolvedIds.Where(id => id > 0).GroupBy(id => id).Any(g => g.Count() > 1))
            throw new InvalidOperationException("The same point was picked for two corners - pick 4 distinct corners.");

        int nextMemId = model.Membranes.Count == 0 ? 1 : model.Membranes.Max(x => x.Id) + 1;
        var membrane = new Membrane { Id = nextMemId, MaterialE = e, MaterialNu = nu, MaterialT = t };
        for (int i = 0; i < 4; i++)
        {
            if (resolvedIds[i] < 0)
            {
                model.Nodes.Add(new GeometryNode { Id = nextGeoId, X = corners[i].X, Y = corners[i].Y });
                resolvedIds[i] = nextGeoId++;
            }
            membrane.NodeIds.Add(resolvedIds[i]);
        }
        model.Membranes.Add(membrane);
        return membrane;
    }

    /// <summary>Which pair of opposite edges a surface split bisects.</summary>
    public enum SplitAxis
    {
        /// <summary>Bisect edges 1-2 and 3-4; the cut runs in the N direction (halves M).</summary>
        HalveM,
        /// <summary>Bisect edges 2-3 and 4-1; the cut runs in the M direction (halves N).</summary>
        HalveN
    }

    public sealed record SplitResult(
        Membrane A, Membrane B, int NodesMerged, int NeighbourStitchNodes, bool Remeshed, bool WasMeshed);

    /// <summary>
    /// Split a 4-sided membrane into two 4-sided membranes by bisecting a pair of
    /// opposite edges and joining the two edge midpoints with a new straight internal
    /// edge. The two halves SHARE the two new midpoint geometry points, so the cut
    /// stays connected at the geometry level (moving a midpoint re-meshes both halves).
    ///
    /// Arc (radius) edges are preserved on the half-edges - an edge midpoint sits ON
    /// its arc and the two sub-edges keep the parent's effective (post-clamp) radius,
    /// so they trace the same circle; the new internal edge is straight. Material,
    /// thickness and visibility are copied to both halves.
    ///
    /// If the original was meshed with known divisions, both halves are re-meshed
    /// (preserving the Quad4/Quad8 type; element size is preserved exactly for an even
    /// division and approximately otherwise - a 1-division axis is refined to 2) and
    /// the coincident nodes are merged so the result is a single conformal mesh. The
    /// merge also re-fuses the halves to any neighbouring surface this one was
    /// previously coincident-merge STITCHED to, so the split never silently opens a
    /// hidden free edge (NeighbourStitchNodes reports how many such nodes were rejoined).
    /// Re-meshing replaces the original surface's mesh, so any loads/constraints,
    /// springs, bars, RBE2s or cracks carried by those FE nodes are lost (the same
    /// behaviour as moving a geometry point).
    /// </summary>
    public static SplitResult SplitMembrane(FeModel model, int membraneId, SplitAxis axis)
    {
        var membrane = model.Membranes.FirstOrDefault(m => m.Id == membraneId)
            ?? throw new InvalidOperationException($"Surface {membraneId} not found.");
        if (membrane.NodeIds.Count != 4)
            throw new InvalidOperationException($"Surface {membraneId} is not 4-sided.");

        var corners = membrane.NodeIds
            .Select(id => model.Nodes.FirstOrDefault(g => g.Id == id)
                ?? throw new InvalidOperationException($"Surface {membraneId}: geometry node {id} missing."))
            .ToArray();
        double R(int i) => i < membrane.EdgeRadii.Count ? membrane.EdgeRadii[i] : 0;

        // Signed radius to store on a sub-edge (x0,y0)->(x1,y1) of parent edge so it
        // traces the SAME circle as the parent arc. Naively copying the parent radius
        // fails for clamped/strongly-curved edges: ArcPoint reconstructs a circle from
        // two points + a radius, and the sub-chord's different orientation can flip
        // which of the two candidate centres the sign selects. We therefore compute the
        // parent's (post-clamp) centre and pick the sub-edge sign that reproduces it.
        double SubR(int parentEdge, double x0, double y0, double x1, double y1)
        {
            double r = R(parentEdge);
            if (r == 0) return 0;
            var pa = corners[parentEdge]; var pb = corners[(parentEdge + 1) % 4];
            double dx = pb.X - pa.X, dy = pb.Y - pa.Y, len = Math.Sqrt(dx * dx + dy * dy);
            double absR = Math.Abs(r);
            if (absR < len / 2) { r = Math.Sign(r) * len / 2; absR = len / 2; } // parent clamp
            double mx = (pa.X + pb.X) / 2, my = (pa.Y + pb.Y) / 2;
            double hh = Math.Sqrt(Math.Max(0, absR * absR - len * len / 4));
            double nx = dy / len, ny = -dx / len;
            double cx = mx - (r > 0 ? hh : -hh) * nx, cy = my - (r > 0 ? hh : -hh) * ny; // parent centre
            double sdx = x1 - x0, sdy = y1 - y0, sl = Math.Sqrt(sdx * sdx + sdy * sdy);
            double smx = (x0 + x1) / 2, smy = (y0 + y1) / 2;
            double snx = sdy / sl, sny = -sdx / sl;
            return (smx - cx) * snx + (smy - cy) * sny >= 0 ? absR : -absR;
        }

        // The two opposite edges that receive a midpoint. Each midpoint lies on its
        // (possibly curved) edge at the arc-length midpoint.
        (int eP, int eQ) = axis == SplitAxis.HalveM ? (0, 2) : (1, 3);
        (double X, double Y) MidOf(int edge)
        {
            var a = corners[edge];
            var b = corners[(edge + 1) % 4];
            return ArcPoint(a.X, a.Y, b.X, b.Y, R(edge), 0.5);
        }
        var (px, py) = MidOf(eP);
        var (qx, qy) = MidOf(eQ);

        int nextGeoId = model.Nodes.Count == 0 ? 1 : model.Nodes.Max(g => g.Id) + 1;
        var midP = new GeometryNode { Id = nextGeoId++, X = px, Y = py };
        var midQ = new GeometryNode { Id = nextGeoId++, X = qx, Y = qy };
        model.Nodes.Add(midP);
        model.Nodes.Add(midQ);

        int nextMemId = model.Membranes.Count == 0 ? 1 : model.Membranes.Max(m => m.Id) + 1;
        Membrane Make(int id, int[] cornerIds, double[] radii) => new()
        {
            Id = id,
            NodeIds = cornerIds.ToList(),
            EdgeRadii = radii.ToList(),
            MaterialE = membrane.MaterialE,
            MaterialNu = membrane.MaterialNu,
            MaterialT = membrane.MaterialT,
            Visible = membrane.Visible
        };

        int c0 = corners[0].Id, c1 = corners[1].Id, c2 = corners[2].Id, c3 = corners[3].Id;
        Membrane a, b;
        var k0 = corners[0]; var k1 = corners[1]; var k2 = corners[2]; var k3 = corners[3];
        if (axis == SplitAxis.HalveM)
        {
            // midP on edge0 (c0->c1), midQ on edge2 (c2->c3). Internal edge midP->midQ.
            a = Make(nextMemId, new[] { c0, midP.Id, midQ.Id, c3 },
                new[] { SubR(0, k0.X, k0.Y, px, py), 0.0, SubR(2, qx, qy, k3.X, k3.Y), R(3) });
            b = Make(nextMemId + 1, new[] { midP.Id, c1, c2, midQ.Id },
                new[] { SubR(0, px, py, k1.X, k1.Y), R(1), SubR(2, k2.X, k2.Y, qx, qy), 0.0 });
        }
        else
        {
            // midP on edge1 (c1->c2), midQ on edge3 (c3->c0). Internal edge midQ->midP.
            a = Make(nextMemId, new[] { c0, c1, midP.Id, midQ.Id },
                new[] { R(0), SubR(1, k1.X, k1.Y, px, py), 0.0, SubR(3, qx, qy, k0.X, k0.Y) });
            b = Make(nextMemId + 1, new[] { midQ.Id, midP.Id, c2, c3 },
                new[] { 0.0, SubR(1, px, py, k2.X, k2.Y), R(2), SubR(3, k3.X, k3.Y, qx, qy) });
        }

        bool wasMeshed = model.FeElements.Any(e => e.MembraneId == membrane.Id);
        bool canRemesh = wasMeshed && membrane.MeshM is not null && membrane.MeshN is not null;

        // FE nodes referenced by the original surface's mesh. After ClearMesh, the
        // survivors among these are exactly the boundary nodes a coincident-merge
        // previously STITCHED to a neighbour (kept because the neighbour still
        // references them); re-fusing the halves to them keeps the split from silently
        // un-stitching the neighbour into a hidden free edge.
        var originalMeshNodeIds = model.FeElements
            .Where(e => e.MembraneId == membrane.Id)
            .SelectMany(e => e.NodeIds).ToHashSet();

        // Replace the original surface: drop its mesh but keep its corner geometry
        // points (the halves reference them); then install the two halves.
        ClearMesh(model, membrane.Id);
        // The original-mesh nodes ClearMesh KEPT are exactly the boundary nodes a prior
        // coincident-merge stitched to a neighbour. Capture them now, before re-meshing
        // reuses any freed ids (MeshMembrane always allocates above the current max, so
        // these captured ids can never collide with the halves' new nodes).
        var stitchSurvivorIds = model.FeNodes
            .Where(n => originalMeshNodeIds.Contains(n.Id)).Select(n => n.Id).ToList();
        model.Membranes.Remove(membrane);
        model.Membranes.Add(a);
        model.Membranes.Add(b);

        int merged = 0, neighbourStitch = 0;
        bool remeshed = false;
        if (canRemesh)
        {
            int mDiv = membrane.MeshM!.Value, nDiv = membrane.MeshN!.Value;
            bool q8 = membrane.MeshQuadratic;
            double bm = membrane.MeshBiasM, bn = membrane.MeshBiasN;
            if (axis == SplitAxis.HalveM)
            {
                MeshMembrane(model, a, Math.Max(1, (mDiv + 1) / 2), nDiv, q8, bm, bn);
                MeshMembrane(model, b, Math.Max(1, mDiv / 2), nDiv, q8, bm, bn);
            }
            else
            {
                MeshMembrane(model, a, mDiv, Math.Max(1, (nDiv + 1) / 2), q8, bm, bn);
                MeshMembrane(model, b, mDiv, Math.Max(1, nDiv / 2), q8, bm, bn);
            }

            // Merge the two halves' nodes (fuses the internal seam) together with the
            // surviving stitched-neighbour boundary nodes (re-fuses the stitch). Scope
            // is restricted to exactly these so untouched coincidences are preserved.
            var mergeScope = model.FeNodes
                .Where(n => n.MembraneId == a.Id || n.MembraneId == b.Id)
                .Select(n => n.Id)
                .Concat(stitchSurvivorIds)
                .ToList();
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
            double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
            foreach (var g in new[] { corners[0], corners[1], corners[2], corners[3], midP, midQ })
            {
                minX = Math.Min(minX, g.X); maxX = Math.Max(maxX, g.X);
                minY = Math.Min(minY, g.Y); maxY = Math.Max(maxY, g.Y);
            }
            double diag = Math.Sqrt((maxX - minX) * (maxX - minX) + (maxY - minY) * (maxY - minY));
            double tol = 1e-6 * (diag > 0 ? diag : 1);
            (merged, _, _) = MergeCoincidentNodes(model, tol, mergeScope);
            neighbourStitch = stitchSurvivorIds.Count;
            remeshed = true;
        }

        return new SplitResult(a, b, merged, neighbourStitch, remeshed, wasMeshed);
    }

    /// <summary>
    /// Create a grid of spring points: nx x ny points starting at (x0, y0) spanning
    /// width x height (a count of 1 in a direction collapses that dimension).
    /// </summary>
    public static List<SpringPoint> AddSpringPointGrid(
        FeModel model, double x0, double y0, double width, double height, int nx, int ny)
    {
        if (nx < 1 || ny < 1) throw new ArgumentOutOfRangeException(nameof(nx), "Counts must be >= 1.");
        int nextId = model.SpringPoints.Count == 0 ? 1 : model.SpringPoints.Max(p => p.Id) + 1;
        var created = new List<SpringPoint>();
        for (int i = 0; i < nx; i++)
            for (int j = 0; j < ny; j++)
            {
                var sp = new SpringPoint
                {
                    Id = nextId++,
                    X = x0 + (nx == 1 ? 0 : width * i / (nx - 1)),
                    Y = y0 + (ny == 1 ? 0 : height * j / (ny - 1))
                };
                model.SpringPoints.Add(sp);
                created.Add(sp);
            }
        return created;
    }

    public sealed record SpringsAtPointsResult(
        int Created, int SkippedTooFew, int SkippedTooMany, int SkippedDuplicate);

    /// <summary>
    /// Create one spring element per spring point: at each point, exactly two VISIBLE
    /// FE nodes must lie within 'range'; a spring of stiffness k joins them. Points
    /// with fewer or more than two nodes in range are skipped (counted in the result),
    /// as are pairs that already have a spring.
    /// </summary>
    public static SpringsAtPointsResult CreateSpringsAtSpringPoints(FeModel model, double range, double stiffness)
    {
        if (range <= 0) throw new ArgumentOutOfRangeException(nameof(range), "Range must be positive.");
        var hidden = model.Membranes.Where(m => !m.Visible).Select(m => m.Id).ToHashSet();
        var visibleNodes = model.FeNodes
            .Where(n => n.MembraneId is not { } mid || !hidden.Contains(mid))
            .ToList();

        var existingPairs = new HashSet<long>();
        foreach (var s in model.FeSprings)
        {
            int a = Math.Min(s.FeNodeId1, s.FeNodeId2), b = Math.Max(s.FeNodeId1, s.FeNodeId2);
            existingPairs.Add((long)a << 32 | (uint)b);
        }

        int nextId = model.FeSprings.Count == 0 ? 1 : model.FeSprings.Max(s => s.Id) + 1;
        double r2 = range * range;
        int created = 0, tooFew = 0, tooMany = 0, duplicate = 0;
        foreach (var sp in model.SpringPoints)
        {
            var inRange = visibleNodes
                .Where(n => (n.X - sp.X) * (n.X - sp.X) + (n.Y - sp.Y) * (n.Y - sp.Y) <= r2)
                .ToList();
            if (inRange.Count < 2) { tooFew++; continue; }
            if (inRange.Count > 2) { tooMany++; continue; }

            int a = Math.Min(inRange[0].Id, inRange[1].Id), b = Math.Max(inRange[0].Id, inRange[1].Id);
            long key = (long)a << 32 | (uint)b;
            if (!existingPairs.Add(key)) { duplicate++; continue; }

            model.FeSprings.Add(new FeSpring { Id = nextId++, FeNodeId1 = a, FeNodeId2 = b, Stiffness = stiffness });
            inRange[0].IsSpringConnectionPoint = true;
            inRange[1].IsSpringConnectionPoint = true;
            created++;
        }
        return new SpringsAtPointsResult(created, tooFew, tooMany, duplicate);
    }

    /// <summary>
    /// Create a crack along a straight path of selected FE nodes in a Quad8 mesh.
    /// The path nodes (corners AND midsides along one mesh line) are split into two
    /// crack faces - every non-tip path node is duplicated and elements on one side
    /// of the line re-reference the duplicate. The midside nodes on edges emanating
    /// from each tip are moved to the quarter points (Barsoum), embedding the
    /// 1/sqrt(r) singularity. Returns one Crack record per tip, used by the
    /// displacement-correlation SIF extraction after a solve.
    ///
    /// Constraints (v1): the path must be straight and lie along element edges of a
    /// Quad8 mesh; a tip must be in the mesh interior. Fixed/enforced BCs are copied
    /// to duplicated nodes; nodal LOADS are not (copying would double them).
    /// </summary>
    public static List<Crack> CreateCrack(FeModel model, IReadOnlyCollection<int> pathNodeIds,
        bool tipAtStart, bool tipAtEnd)
    {
        if (!tipAtStart && !tipAtEnd)
            throw new InvalidOperationException("Choose at least one crack-tip end.");
        if (pathNodeIds.Count < 3)
            throw new InvalidOperationException("Select the crack path nodes (at least 3: corner-midside-corner).");

        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        var path = pathNodeIds.Select(id => nodeById.TryGetValue(id, out var n)
            ? n : throw new InvalidOperationException($"Crack path node {id} not found.")).ToList();

        // Order the path along its dominant direction (endpoints = the farthest pair)
        FeNode end1 = path[0], end2 = path[0];
        double best = -1;
        foreach (var a in path)
            foreach (var b in path)
            {
                double d2 = (a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y);
                if (d2 > best) { best = d2; end1 = a; end2 = b; }
            }
        if (best <= 0) throw new InvalidOperationException("Crack path nodes are coincident.");
        double dirX = (end2.X - end1.X) / Math.Sqrt(best), dirY = (end2.Y - end1.Y) / Math.Sqrt(best);
        var ordered = path.OrderBy(n => (n.X - end1.X) * dirX + (n.Y - end1.Y) * dirY).ToList();

        // Straightness check: every node within 1% of the path length off the line
        double tolOff = 0.01 * Math.Sqrt(best);
        foreach (var n in ordered)
        {
            double off = Math.Abs((n.X - end1.X) * dirY - (n.Y - end1.Y) * dirX);
            if (off > tolOff)
                throw new InvalidOperationException(
                    $"Crack path is not straight: node {n.Id} lies off the line. Select nodes along one mesh line.");
        }

        // Elements touching the path must be Quad8 (quarter-point tips need midside nodes)
        var pathSet = ordered.Select(n => n.Id).ToHashSet();
        var touching = model.FeElements.Where(e => e.NodeIds.Any(pathSet.Contains)).ToList();
        if (touching.Count == 0) throw new InvalidOperationException("No elements touch the crack path.");
        if (touching.Any(e => !ElementTopology.IsQuad8(e)))
            throw new InvalidOperationException(
                "Crack creation requires a Quad8 mesh (re-mesh the surface with 'Quadratic elements' ticked).");

        var tips = new List<FeNode>();
        if (tipAtStart) tips.Add(ordered[0]);
        if (tipAtEnd) tips.Add(ordered[^1]);
        var tipIds = tips.Select(t => t.Id).ToHashSet();

        // A tip must be interior: elements all around it (>= 2 attached elements and
        // not on the path boundary end that has only one side meshed is fine - the
        // real requirement is that splitting stops AT the tip)
        foreach (var tip in tips)
            if (touching.Count(e => e.NodeIds.Contains(tip.Id)) < 2)
                throw new InvalidOperationException(
                    $"Tip node {tip.Id} touches fewer than 2 elements - the tip must be inside the mesh.");

        // ---- Split: duplicate every non-tip path node; elements on the negative
        // side of the line re-reference the duplicate ----
        int nextNodeId = model.FeNodes.Max(n => n.Id) + 1;
        var dupOf = new Dictionary<int, int>(); // original path node id -> duplicate id
        double SideOf(FeElement e)
        {
            double cx = 0, cy = 0;
            foreach (var nid in e.NodeIds) { var nn = nodeById[nid]; cx += nn.X; cy += nn.Y; }
            cx /= e.NodeIds.Count; cy /= e.NodeIds.Count;
            return (cx - end1.X) * dirY - (cy - end1.Y) * dirX; // >0 = side B, <0 = side A
        }
        var sideOfElement = touching.ToDictionary(e => e.Id, SideOf);

        foreach (var n in ordered)
        {
            if (tipIds.Contains(n.Id)) continue;
            var attached = touching.Where(e => e.NodeIds.Contains(n.Id)).ToList();
            var sideB = attached.Where(e => sideOfElement[e.Id] > 0).ToList();
            var sideA = attached.Where(e => sideOfElement[e.Id] <= 0).ToList();
            if (sideA.Count == 0 || sideB.Count == 0) continue; // boundary end node etc - nothing to split

            var dup = new FeNode
            {
                Id = nextNodeId++,
                X = n.X,
                Y = n.Y,
                MembraneId = n.MembraneId,
                IsSpringConnectionPoint = n.IsSpringConnectionPoint,
                // Constraints carry to both faces; loads must NOT be copied (doubling)
                Bc = n.Bc is { Type: "fixed" or "enforced" } ? n.Bc : null
            };
            model.FeNodes.Add(dup);
            nodeById[dup.Id] = dup;
            dupOf[n.Id] = dup.Id;
            foreach (var e in sideB)
                for (int i = 0; i < e.NodeIds.Count; i++)
                    if (e.NodeIds[i] == n.Id) e.NodeIds[i] = dup.Id;
        }
        if (dupOf.Count == 0)
            throw new InvalidOperationException(
                "Nothing to split - the path has no interior nodes with elements on both sides.");

        // ---- Quarter-point conversion around each tip ----
        foreach (var tip in tips)
        {
            foreach (var e in model.FeElements.Where(e2 => ElementTopology.IsQuad8(e2) && e2.NodeIds.Take(4).Contains(tip.Id)))
            {
                int c = e.NodeIds.IndexOf(tip.Id); // corner index 0..3
                // midside between corners c and c+1 is at index 4+c; between c-1 and c at 4+(c+3)%4
                foreach (var (midIdx, otherCornerIdx) in new[] { (4 + c, (c + 1) % 4), (4 + (c + 3) % 4, (c + 3) % 4) })
                {
                    var mid = nodeById[e.NodeIds[midIdx]];
                    var other = nodeById[e.NodeIds[otherCornerIdx]];
                    mid.X = tip.X + 0.25 * (other.X - tip.X);
                    mid.Y = tip.Y + 0.25 * (other.Y - tip.Y);
                }
            }
        }

        // ---- Crack records: face node pairs behind each tip ----
        int nextCrackId = model.Cracks.Count == 0 ? 1 : model.Cracks.Max(cr => cr.Id) + 1;
        var created = new List<Crack>();
        foreach (var tip in tips)
        {
            int tipIdx = ordered.FindIndex(n => n.Id == tip.Id);
            int step = tipIdx == 0 ? 1 : -1; // walk back along the path away from the tip
            if (tipIdx + 2 * step < 0 || tipIdx + 2 * step >= ordered.Count)
                throw new InvalidOperationException($"Crack path too short behind tip {tip.Id}.");
            var mNode = ordered[tipIdx + step];       // midside behind tip (now at L/4)
            var cNode = ordered[tipIdx + 2 * step];   // corner behind tip (at L)
            if (!dupOf.ContainsKey(mNode.Id) || !dupOf.ContainsKey(cNode.Id))
                throw new InvalidOperationException(
                    $"The path nodes behind tip {tip.Id} were not split - the crack faces did not separate there.");

            // Normal pointing from side B (positive side) to side A: -(dirY, -dirX) etc.
            // SideOf > 0 used cross = dx*dirY - dy*dirX; side A has cross <= 0, which is
            // the side the normal (dirY, -dirX) points AWAY from; so B->A normal is:
            double nxBA = -dirY, nyBA = dirX;
            created.Add(new Crack
            {
                Id = nextCrackId++,
                TipNodeId = tip.Id,
                FaceAQuarterNodeId = mNode.Id,
                FaceACornerNodeId = cNode.Id,
                FaceBQuarterNodeId = dupOf[mNode.Id],
                FaceBCornerNodeId = dupOf[cNode.Id],
                NormalX = nxBA,
                NormalY = nyBA
            });
        }
        model.Cracks.AddRange(created);
        return created;
    }

    /// <summary>Drop cracks whose nodes have been removed.</summary>
    private static void PruneCracks(FeModel model, HashSet<int> doomedNodes)
    {
        model.Cracks.RemoveAll(c =>
            doomedNodes.Contains(c.TipNodeId) ||
            doomedNodes.Contains(c.FaceAQuarterNodeId) || doomedNodes.Contains(c.FaceACornerNodeId) ||
            doomedNodes.Contains(c.FaceBQuarterNodeId) || doomedNodes.Contains(c.FaceBCornerNodeId));
    }

    public sealed record DistributedLoadResult(
        int Edges, double TotalLength, double AppliedFx, double AppliedFy, int SkippedConstrained);

    /// <summary>
    /// Apply a distributed line load over the element edges spanned by the selected
    /// nodes, as CONSISTENT nodal loads: 1/2-1/2 per linear (Quad4) edge,
    /// 1/6-4/6-1/6 per quadratic (Quad8) edge. fx/fy are either running load
    /// (force per unit length) or the total load over the whole selected line.
    /// Loads ADD to existing nodal loads; nodes carrying fixed/enforced BCs are
    /// skipped (their share is dropped and counted in the result).
    /// </summary>
    public static DistributedLoadResult ApplyDistributedLoad(
        FeModel model, IReadOnlyCollection<int> nodeIds, double fx, double fy, bool isTotal)
    {
        var selected = nodeIds.ToHashSet();
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);

        // Collect element edges fully inside the selection. Quad8 edges are the full
        // corner-midside-corner triple; geometric edges shared by two elements load once.
        var seen = new HashSet<long>();
        var edges = new List<(int[] nodes, double length)>(); // 2 or 3 node ids per edge
        foreach (var el in model.FeElements)
        {
            if (!ElementTopology.IsSupported(el)) continue;
            var n = el.NodeIds;
            var elEdges = ElementTopology.IsQuad8(el)
                ? new[]
                {
                    new[] { n[0], n[4], n[1] }, new[] { n[1], n[5], n[2] },
                    new[] { n[2], n[6], n[3] }, new[] { n[3], n[7], n[0] }
                }
                : new[]
                {
                    new[] { n[0], n[1] }, new[] { n[1], n[2] },
                    new[] { n[2], n[3] }, new[] { n[3], n[0] }
                };
            foreach (var edge in elEdges)
            {
                if (!edge.All(selected.Contains)) continue;
                if (edge.Any(id => !nodeById.ContainsKey(id))) continue;
                int a = edge[0], b = edge[^1];
                long key = Math.Min(a, b) is var lo && Math.Max(a, b) is var hi
                    ? (long)lo << 32 | (uint)hi : 0;
                if (!seen.Add(key)) continue;
                var na = nodeById[a];
                var nb = nodeById[b];
                double len = Math.Sqrt((nb.X - na.X) * (nb.X - na.X) + (nb.Y - na.Y) * (nb.Y - na.Y));
                if (len <= 0) continue;
                edges.Add((edge, len));
            }
        }
        if (edges.Count == 0)
            throw new InvalidOperationException(
                "No element edges lie within the selected nodes - select a connected line of " +
                "nodes along element edges (for Quad8 include the midside nodes).");

        double totalLength = edges.Sum(e => e.length);
        // Running load per unit length
        double wx = isTotal ? fx / totalLength : fx;
        double wy = isTotal ? fy / totalLength : fy;

        // Accumulate consistent nodal forces
        var f = new Dictionary<int, (double fx, double fy)>();
        void Acc(int id, double share, double len)
        {
            var v = f.GetValueOrDefault(id);
            f[id] = (v.fx + wx * len * share, v.fy + wy * len * share);
        }
        foreach (var (en, len) in edges)
        {
            if (en.Length == 3)
            {
                Acc(en[0], 1.0 / 6, len);
                Acc(en[1], 4.0 / 6, len);
                Acc(en[2], 1.0 / 6, len);
            }
            else
            {
                Acc(en[0], 0.5, len);
                Acc(en[1], 0.5, len);
            }
        }

        int skipped = 0;
        double appliedFx = 0, appliedFy = 0;
        foreach (var (id, (nfx, nfy)) in f)
        {
            var node = nodeById[id];
            if (node.Bc is { Type: "fixed" or "enforced" }) { skipped++; continue; }
            double curFx = node.Bc?.Value.Fx ?? 0, curFy = node.Bc?.Value.Fy ?? 0;
            node.Bc = new BoundaryCondition
            {
                Type = "load",
                Value = new BcValue { Fx = curFx + nfx, Fy = curFy + nfy }
            };
            appliedFx += nfx;
            appliedFy += nfy;
        }
        return new DistributedLoadResult(edges.Count, totalLength, appliedFx, appliedFy, skipped);
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

    /// <summary>Options for <see cref="CreateReentrantCorner"/>.</summary>
    public sealed record ReentrantCornerOptions
    {
        public double ApexX { get; init; }               // the sharp re-entrant corner point
        public double ApexY { get; init; }
        public double Radius { get; init; }              // r: fillet radius at the corner, > 0
        public double Offset { get; init; }              // d: ring thickness into the material, > 0
        public double LegX { get; init; } = 60;          // straight-leg length beyond the fillet (x leg)
        public double LegY { get; init; } = 60;          // straight-leg length beyond the fillet (y leg)
        public int QuarterTurns { get; init; }           // 0..3: rotate the notch into another quadrant
        public int DivLegX { get; init; } = 6;           // divisions along the x leg
        public int DivLegY { get; init; } = 6;           // divisions along the y leg
        public int DivCorner { get; init; } = 6;         // divisions around the 90-degree fillet
        public int DivRadial { get; init; } = 4;         // divisions across the ring (free edge -> into material)
        public double RadialBias { get; init; } = 1.0;   // > 1 concentrates elements toward the free (inner) edge
        public bool Quadratic { get; init; }
        public double E { get; init; } = 10.5e6;
        public double Nu { get; init; } = 0.33;
        public double Thickness { get; init; } = 0.05;
        public bool CreateFrameBars { get; init; }       // chain bars along the free edge (edge stiffener)
        public double FrameE { get; init; } = 10.5e6;
        public double FrameArea { get; init; } = 0.1;
    }

    public sealed record ReentrantCornerResult(
        IReadOnlyList<int> PatchIds, IReadOnlyList<int> InnerEdgeNodeIds,
        IReadOnlyList<int> OuterEdgeNodeIds, int FrameBars, int NodesMerged);

    /// <summary>
    /// Build a structured ring along a re-entrant (concave, 90-degree) filleted corner:
    /// two straight rectangle leg patches plus one annular-sector fillet patch, from the
    /// free (inner) edge inward by <c>Offset</c>. Every patch is a convex 4-sided Coons
    /// surface (no degenerate or inverted corners); the radial direction can be graded
    /// toward the free edge to resolve the re-entrant-corner stress concentration; the
    /// patches share tangent geometry points with the seam nodes merged into one
    /// conformal mesh. Optionally chains bar elements along the free edge as a stiffener.
    ///
    /// Built in a canonical frame (notch in the +x,+y quadrant from the apex) then rotated
    /// by QuarterTurns*90 degrees about the apex (rotation preserves winding). Mesh the
    /// surrounding part up to the outer boundary and merge coincident nodes to stitch.
    /// Returns the patch ids, the inner (free-edge) and outer FE node paths, the number of
    /// stiffener bars and the number of seam nodes merged.
    /// </summary>
    public static ReentrantCornerResult CreateReentrantCorner(FeModel model, ReentrantCornerOptions o)
    {
        double r = o.Radius, d = o.Offset, ax = o.ApexX, ay = o.ApexY;
        if (r <= 0) throw new InvalidOperationException("Fillet radius must be positive.");
        if (d <= 0) throw new InvalidOperationException("Ring thickness (offset) must be positive.");
        if (o.LegX <= 0 || o.LegY <= 0) throw new InvalidOperationException("Leg lengths must be positive.");
        if (o.DivLegX < 1 || o.DivLegY < 1 || o.DivCorner < 1 || o.DivRadial < 1)
            throw new InvalidOperationException("All division counts must be >= 1.");

        // Canonical frame: apex at (ax,ay), notch in the +x,+y quadrant, material in the
        // rest. The y leg's free edge is x=ax (extending +y); the x leg's free edge is
        // y=ay (extending +x); the fillet centre F is in the notch.
        double fx = ax + r, fy = ay + r;

        int nextGeoId = model.Nodes.Count == 0 ? 1 : model.Nodes.Max(g => g.Id) + 1;
        var geoIds = new List<int>();
        int Pt(double x, double y) { model.Nodes.Add(new GeometryNode { Id = nextGeoId, X = x, Y = y }); geoIds.Add(nextGeoId); return nextGeoId++; }

        int IBt = Pt(ax, ay + r),     IBb = Pt(ax, ay + r + o.LegY);     // y leg, inner (free) edge
        int OBt = Pt(ax - d, ay + r), OBb = Pt(ax - d, ay + r + o.LegY); // y leg, outer edge
        int IRl = Pt(ax + r, ay),     IRr = Pt(ax + r + o.LegX, ay);     // x leg, inner (free) edge
        int ORl = Pt(ax + r, ay - d), ORr = Pt(ax + r + o.LegX, ay - d); // x leg, outer edge

        var geo = model.Nodes.ToDictionary(g => g.Id);
        // Signed radius so ArcPoint(p0,p1,.) reconstructs the fillet centre F.
        double SignR(int p0, int p1, double absR)
        {
            var (x0, y0) = (geo[p0].X, geo[p0].Y);
            var (x1, y1) = (geo[p1].X, geo[p1].Y);
            double mx = (x0 + x1) / 2, my = (y0 + y1) / 2, sdx = x1 - x0, sdy = y1 - y0;
            double sl = Math.Sqrt(sdx * sdx + sdy * sdy), nx = sdy / sl, ny = -sdx / sl;
            return (mx - fx) * nx + (my - fy) * ny >= 0 ? absR : -absR;
        }

        int nextMemId = model.Membranes.Count == 0 ? 1 : model.Membranes.Max(m => m.Id) + 1;
        var patches = new List<(Membrane mem, int m, int n)>();
        void Add(int[] ids, double[] radii, int mm, int nn)
        {
            var mem = new Membrane
            {
                Id = nextMemId++, NodeIds = ids.ToList(), EdgeRadii = radii.ToList(),
                MaterialE = o.E, MaterialNu = o.Nu, MaterialT = o.Thickness
            };
            model.Membranes.Add(mem);
            patches.Add((mem, mm, nn));
        }
        // Corners 0,1 on the free (inner) edge, 2,3 outer; positive winding; n is radial,
        // v=0 at the free edge so RadialBias concentrates there. edge0 inner, edge2 outer.
        Add(new[] { IBt, IBb, OBb, OBt }, new[] { 0.0, 0, 0, 0 }, o.DivLegY, o.DivRadial);     // y leg
        Add(new[] { IRr, IRl, ORl, ORr }, new[] { 0.0, 0, 0, 0 }, o.DivLegX, o.DivRadial);     // x leg
        Add(new[] { IRl, IBt, OBt, ORl },
            new[] { SignR(IRl, IBt, r), 0, SignR(OBt, ORl, r + d), 0 }, o.DivCorner, o.DivRadial); // fillet

        foreach (var (mem, mm, nn) in patches)
            MeshMembrane(model, mem, mm, nn, o.Quadratic, 1.0, o.RadialBias);

        // Tolerance tracks the SMALLEST node spacing (radial-graded / fillet / leg), not
        // the part size, so a thin ring or heavy grading never over-merges distinct nodes.
        double minRadialStep = double.PositiveInfinity;
        for (int j = 0; j < o.DivRadial; j++)
            minRadialStep = Math.Min(minRadialStep,
                d * (BiasedT(j + 1, o.DivRadial, o.RadialBias) - BiasedT(j, o.DivRadial, o.RadialBias)));
        double minSpacing = Math.Min(Math.Min(minRadialStep, Math.PI / 2 * r / o.DivCorner),
            Math.Min(o.LegX / o.DivLegX, o.LegY / o.DivLegY));
        double tol = 1e-3 * minSpacing;

        var patchIds = patches.Select(p => p.mem.Id).ToHashSet();
        var ringNodeIds = model.FeNodes.Where(nd => nd.MembraneId is { } id && patchIds.Contains(id))
            .Select(nd => nd.Id).ToList();
        var (merged, _, _) = MergeCoincidentNodes(model, tol, ringNodeIds);

        // Inner (free) and outer edge membership, in the canonical frame.
        double Dist(double x, double y) => Math.Sqrt((x - fx) * (x - fx) + (y - fy) * (y - fy));
        bool OnInner(double x, double y) =>
            (Math.Abs(x - ax) < tol && y >= ay + r - tol && y <= ay + r + o.LegY + tol) ||
            (Math.Abs(y - ay) < tol && x >= ax + r - tol && x <= ax + r + o.LegX + tol) ||
            (Math.Abs(Dist(x, y) - r) < tol && x >= ax - tol && y >= ay - tol);
        bool OnOuter(double x, double y) =>
            (Math.Abs(x - (ax - d)) < tol && y >= ay + r - tol && y <= ay + r + o.LegY + tol) ||
            (Math.Abs(y - (ay - d)) < tol && x >= ax + r - tol && x <= ax + r + o.LegX + tol) ||
            (Math.Abs(Dist(x, y) - (r + d)) < tol && x >= ax - d - tol && y >= ay - d - tol);

        var ringNodes = model.FeNodes.Where(nd => nd.MembraneId is { } id && patchIds.Contains(id)).ToList();
        // Both the free (inner) and outer edges are open L-paths; (x - y) increases
        // monotonically along each, giving a usable path order.
        var innerOrdered = ringNodes.Where(nd => OnInner(nd.X, nd.Y)).OrderBy(nd => nd.X - nd.Y).ToList();
        var outerNodes = ringNodes.Where(nd => OnOuter(nd.X, nd.Y)).OrderBy(nd => nd.X - nd.Y).ToList();

        // Defensive: a collapsed ring would not yield the expected free-edge node count.
        int seg = o.DivLegX + o.DivLegY + o.DivCorner;
        int expectedInner = (o.Quadratic ? 2 : 1) * seg + 1;
        if (innerOrdered.Count != expectedInner)
            throw new InvalidOperationException(
                $"Re-entrant ring collapsed: expected {expectedInner} free-edge nodes but got {innerOrdered.Count}. " +
                "The geometry is too degenerate for these divisions - increase the offset/legs or reduce divisions.");

        // Edge stiffener: chain bars along the free edge (open chain, in path order).
        int frameBars = 0;
        if (o.CreateFrameBars && innerOrdered.Count >= 2)
        {
            int nextBarId = model.FeBars.Count == 0 ? 1 : model.FeBars.Max(bar => bar.Id) + 1;
            for (int i = 0; i + 1 < innerOrdered.Count; i++)
            {
                model.FeBars.Add(new FeBar
                {
                    Id = nextBarId++, FeNodeId1 = innerOrdered[i].Id, FeNodeId2 = innerOrdered[i + 1].Id,
                    E = o.FrameE, A = o.FrameArea
                });
                frameBars++;
            }
        }

        // Rotate the whole feature by QuarterTurns*90 degrees about the apex (winding
        // preserved). Geometry points and FE nodes move together; stored arc radii stay
        // valid (rotation is orientation-preserving).
        int turns = ((o.QuarterTurns % 4) + 4) % 4;
        if (turns != 0)
        {
            (double X, double Y) Rot(double x, double y)
            {
                double dx = x - ax, dy = y - ay;
                return turns switch
                {
                    1 => (ax - dy, ay + dx),
                    2 => (ax - dx, ay - dy),
                    _ => (ax + dy, ay - dx), // 3
                };
            }
            foreach (var id in geoIds) { var g = geo[id]; (g.X, g.Y) = Rot(g.X, g.Y); }
            foreach (var nd in ringNodes) (nd.X, nd.Y) = Rot(nd.X, nd.Y);
        }

        return new ReentrantCornerResult(
            patches.Select(p => p.mem.Id).ToList(),
            innerOrdered.Select(n => n.Id).ToList(), outerNodes.Select(n => n.Id).ToList(),
            frameBars, merged);
    }

    /// <summary>
    /// Detach the given bars from everything else: every node they share with
    /// membrane elements, springs, RBE2s or other bars gets a coincident duplicate
    /// (membraneId = null, no BCs), and ONLY the given bars re-reference it. Bars in
    /// the set that share a node keep sharing its single duplicate (the chain stays
    /// connected). The detached bar then has no stiffness path to the mesh until
    /// springs (or constraints) connect it - the load-transfer fastener idealisation.
    /// Returns the number of nodes duplicated.
    /// </summary>
    public static int DetachBars(FeModel model, IReadOnlyCollection<int> barIds)
    {
        var barSet = barIds.ToHashSet();
        var bars = model.FeBars.Where(b => barSet.Contains(b.Id)).ToList();
        if (bars.Count == 0) throw new InvalidOperationException("No bars to detach.");
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);

        // A node needs duplicating if anything OTHER than the selected bars uses it
        var usedElsewhere = new HashSet<int>();
        foreach (var el in model.FeElements) usedElsewhere.UnionWith(el.NodeIds);
        foreach (var sp in model.FeSprings) { usedElsewhere.Add(sp.FeNodeId1); usedElsewhere.Add(sp.FeNodeId2); }
        foreach (var b in model.FeBars.Where(b => !barSet.Contains(b.Id)))
        {
            usedElsewhere.Add(b.FeNodeId1);
            usedElsewhere.Add(b.FeNodeId2);
        }
        foreach (var r in model.Rbe2s)
        {
            usedElsewhere.Add(r.IndependentNodeId);
            usedElsewhere.UnionWith(r.DependentNodeIds);
        }

        int nextId = model.FeNodes.Max(n => n.Id) + 1;
        var dupOf = new Dictionary<int, int>();
        int Dup(int origId)
        {
            if (dupOf.TryGetValue(origId, out var d)) return d;
            var orig = nodeById[origId];
            var dup = new FeNode
            {
                Id = nextId++,
                X = orig.X,
                Y = orig.Y,
                MembraneId = null,   // free bar node, not part of any surface mesh
                Bc = null            // BCs stay with the original (membrane) node
            };
            model.FeNodes.Add(dup);
            dupOf[origId] = dup.Id;
            return dup.Id;
        }

        foreach (var b in bars)
        {
            if (usedElsewhere.Contains(b.FeNodeId1)) b.FeNodeId1 = Dup(b.FeNodeId1);
            if (usedElsewhere.Contains(b.FeNodeId2)) b.FeNodeId2 = Dup(b.FeNodeId2);
        }
        return dupOf.Count;
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
