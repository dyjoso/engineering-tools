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
    /// Mesh a 4-sided membrane M x N (re-meshing replaces any existing mesh).
    /// quadratic=true creates 8-node serendipity quads (corner + midside nodes).
    /// Returns (nodesCreated, elementsCreated).
    /// </summary>
    public static (int nodes, int elements) MeshMembrane(FeModel model, Membrane membrane, int m, int n, bool quadratic = false)
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
                    var (sx, sy) = Coons((double)i / m, (double)j / n);
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
                    var (sx, sy) = Coons((double)i / fm, (double)j / fn);
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
                MeshMembrane(model, s, m, n, s.MeshQuadratic); // clears old mesh first
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
