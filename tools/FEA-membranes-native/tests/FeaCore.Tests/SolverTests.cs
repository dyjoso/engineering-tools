using FeaCore;
using Xunit;

namespace FeaCore.Tests;

// Same analytical cases as the webtool's headless harness (run_test.js):
// exact solutions for a bilinear quad in uniaxial tension, bar PL/EA,
// spring force, enforced displacement, orphan diagnostic, plate far-field.
public class SolverTests
{
    private static BoundaryCondition Fixed(bool x, bool y) =>
        new() { Type = "fixed", Value = new BcValue { FixX = x, FixY = y } };
    private static BoundaryCondition Load(double fx, double fy) =>
        new() { Type = "load", Value = new BcValue { Fx = fx, Fy = fy } };
    private static BoundaryCondition Enforced(double? dx, double? dy) =>
        new() { Type = "enforced", Value = new BcValue { Dx = dx, Dy = dy } };

    [Fact]
    public void Quad_UniaxialTension_ExactForBilinear()
    {
        // 10x10 square, t=0.1, E=1e7, nu=0. Left edge fixed X, bottom-left fixed Y.
        // 1000 lb total on right edge -> sx = 1000 psi, u_right = 1e-3.
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true), MembraneId = 1 },
                new FeNode { Id = 2, X = 10, Y = 0, Bc = Load(500, 0), MembraneId = 1 },
                new FeNode { Id = 3, X = 10, Y = 10, Bc = Load(500, 0), MembraneId = 1 },
                new FeNode { Id = 4, X = 0, Y = 10, Bc = Fixed(true, false), MembraneId = 1 }
            },
            FeElements = { new FeElement { Id = 1, NodeIds = { 1, 2, 3, 4 }, MembraneId = 1 } },
            Membranes = { new Membrane { Id = 1, MaterialE = 1e7, MaterialNu = 0.0, MaterialT = 0.1 } }
        };

        var r = Solver.Solve(model);

        var d2 = r.Displacements.Single(d => d.NodeId == 2);
        var d3 = r.Displacements.Single(d => d.NodeId == 3);
        Assert.Equal(1e-3, d2.Dx, 9);
        Assert.Equal(1e-3, d3.Dx, 9);

        var st = r.ElementStresses.Single();
        Assert.Equal(1000, st.Sxx, 6);
        Assert.Equal(1000, st.SigmaVM, 6);

        Assert.Equal(-1000, r.Reactions.Sum(x => x.Rx), 6);
    }

    [Fact]
    public void Bar_AxialElongation_PLOverEA()
    {
        // Horizontal bar E=1e7, A=0.1, L=10, P=1000 -> elongation 1e-2.
        // Vertical bar to a fixed node supplies Y stiffness at the loaded node.
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true) },
                new FeNode { Id = 2, X = 10, Y = 0, Bc = Load(1000, 0) },
                new FeNode { Id = 3, X = 10, Y = -10, Bc = Fixed(true, true) }
            },
            FeBars =
            {
                new FeBar { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, E = 1e7, A = 0.1 },
                new FeBar { Id = 2, FeNodeId1 = 3, FeNodeId2 = 2, E = 1e7, A = 0.1 }
            }
        };

        var r = Solver.Solve(model);

        Assert.Equal(0.01, r.Displacements.Single(d => d.NodeId == 2).Dx, 9);
        var b1 = r.BarLoads.Single(b => b.Id == 1);
        Assert.Equal(1000, b1.P, 6);          // tension positive
        Assert.Equal(10000, b1.Stress, 6);
        Assert.Equal(0, r.BarLoads.Single(b => b.Id == 2).P, 6);
    }

    [Fact]
    public void Spring_DecoupledXY_ForceAndDisplacement()
    {
        // k=1e5 each direction, F=100 in X -> dx = 1e-3.
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true) },
                new FeNode { Id = 2, X = 0.05, Y = 0, Bc = Load(100, 0) }
            },
            FeSprings = { new FeSpring { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, Stiffness = 1e5 } }
        };

        var r = Solver.Solve(model);

        Assert.Equal(1e-3, r.Displacements.Single(d => d.NodeId == 2).Dx, 9);
        Assert.Equal(100, r.SpringLoads.Single().Fx, 6); // k*(u2-u1), matching the webtool convention
    }

    [Fact]
    public void EnforcedDisplacement_IsExact()
    {
        // Right edge driven to dx=2e-3 -> sx = E*eps = 1e7 * 2e-4 = 2000 psi.
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true), MembraneId = 1 },
                new FeNode { Id = 2, X = 10, Y = 0, Bc = Enforced(2e-3, null), MembraneId = 1 },
                new FeNode { Id = 3, X = 10, Y = 10, Bc = Enforced(2e-3, null), MembraneId = 1 },
                new FeNode { Id = 4, X = 0, Y = 10, Bc = Fixed(true, false), MembraneId = 1 }
            },
            FeElements = { new FeElement { Id = 1, NodeIds = { 1, 2, 3, 4 }, MembraneId = 1 } },
            Membranes = { new Membrane { Id = 1, MaterialE = 1e7, MaterialNu = 0.0, MaterialT = 0.1 } }
        };

        var r = Solver.Solve(model);

        Assert.Equal(2e-3, r.Displacements.Single(d => d.NodeId == 2).Dx, 12); // exact (elimination, not penalty)
        Assert.Equal(2000, r.ElementStresses.Single().Sxx, 6);
    }

    [Fact]
    public void OrphanNode_ThrowsWithNodeId()
    {
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true) },
                new FeNode { Id = 2, X = 10, Y = 0, Bc = Load(1000, 0) },
                new FeNode { Id = 99, X = 50, Y = 50 } // orphan
            },
            FeBars = { new FeBar { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, E = 1e7, A = 0.1 } }
        };

        var ex = Assert.Throws<InvalidOperationException>(() => Solver.Solve(model));
        Assert.Contains("99", ex.Message);
    }

    [Fact]
    public void Plate_20x20_FarFieldStress()
    {
        // 100x100 plate, 20x20 mesh, left edge fixed, 100 lb/node on right edge.
        // Far-field sx ~ (21*100)/(100*0.1) = 210 psi at mid-plate, within 2%.
        const int M = 20, N = 20;
        var model = new FeModel
        {
            Membranes = { new Membrane { Id = 1, MaterialE = 1e7, MaterialNu = 0.3, MaterialT = 0.1 } }
        };
        var grid = new int[M + 1, N + 1];
        int nid = 1;
        for (int i = 0; i <= M; i++)
            for (int j = 0; j <= N; j++)
            {
                BoundaryCondition? bc = i == 0 ? Fixed(true, true) : i == M ? Load(100, 0) : null;
                model.FeNodes.Add(new FeNode { Id = nid, X = i * 5, Y = j * 5, Bc = bc, MembraneId = 1 });
                grid[i, j] = nid++;
            }
        int eid = 1;
        for (int i = 0; i < M; i++)
            for (int j = 0; j < N; j++)
                model.FeElements.Add(new FeElement
                {
                    Id = eid++,
                    NodeIds = { grid[i, j], grid[i + 1, j], grid[i + 1, j + 1], grid[i, j + 1] },
                    MembraneId = 1
                });

        var r = Solver.Solve(model);

        var midElements = model.FeElements
            .Where(el => el.NodeIds.Any(id => model.FeNodes.First(n => n.Id == id).X == 50))
            .Select(el => el.Id).ToHashSet();
        double avgSx = r.ElementStresses.Where(s => midElements.Contains(s.ElementId)).Average(s => s.Sxx);
        Assert.True(Math.Abs(avgSx - 210) / 210 < 0.02, $"avg mid-plate sx = {avgSx}, expected ~210");
    }

    [Fact]
    public void SampleModel_LoadsAndSolves()
    {
        // Walk up from the test bin directory to find samples/ in the repo
        var dir = AppContext.BaseDirectory;
        string? samplePath = null;
        for (int i = 0; i < 8 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir, "samples", "curved-plate-with-bars.json");
            if (File.Exists(candidate)) { samplePath = candidate; break; }
            dir = Path.GetDirectoryName(dir);
        }
        Assert.False(samplePath is null, "samples/curved-plate-with-bars.json not found above test directory");

        var model = FeModel.Load(samplePath!);
        Assert.Equal(45, model.FeNodes.Count);
        Assert.Equal(32, model.FeElements.Count);
        Assert.Equal(8, model.FeBars.Count);

        var r = Solver.Solve(model);

        // Sanity: equilibrium - reactions balance the 5 x 250 lb applied load
        Assert.Equal(-1250, r.Reactions.Sum(x => x.Rx), 4);
        // All displacements finite and small
        Assert.All(r.Displacements, d =>
        {
            Assert.True(double.IsFinite(d.Dx) && double.IsFinite(d.Dy));
            Assert.True(Math.Abs(d.Dx) < 1 && Math.Abs(d.Dy) < 1);
        });
    }

    [Fact]
    public void UnderConstrained_ThrowsInsteadOfSilentGarbage()
    {
        // Loaded plate with NO constraints - rigid-body modes make K singular.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        model.FeNodes[0].Bc = Load(100, 0);

        var ex = Assert.Throws<InvalidOperationException>(() => Solver.Solve(model));
        Assert.Contains("under-constrained", ex.Message);
    }

    [Fact]
    public void Mesher_FlatQuad_NodeAndElementCounts()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        var (nodes, els) = Mesher.MeshMembrane(model, s, 4, 3);

        Assert.Equal(5 * 4, nodes);
        Assert.Equal(12, els);
        Assert.Equal(20, model.FeNodes.Count);

        // Corner FE nodes coincide with geometry corners
        Assert.Contains(model.FeNodes, n => Math.Abs(n.X) < 1e-9 && Math.Abs(n.Y) < 1e-9);
        Assert.Contains(model.FeNodes, n => Math.Abs(n.X - 10) < 1e-9 && Math.Abs(n.Y - 10) < 1e-9);

        // Re-mesh replaces, never duplicates: old mesh fully removed, ids unique
        Mesher.MeshMembrane(model, s, 2, 2);
        Assert.Equal(9, model.FeNodes.Count);
        Assert.Equal(4, model.FeElements.Count);
        Assert.Equal(model.FeNodes.Count, model.FeNodes.Select(n => n.Id).Distinct().Count());
        Assert.Equal(model.FeElements.Count, model.FeElements.Select(e2 => e2.Id).Distinct().Count());
        Assert.All(model.FeElements, e2 => Assert.All(e2.NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id)));
        Assert.Equal(2, s.MeshM);
        Assert.Equal(2, s.MeshN);

        // Meshed flat plate solves (sanity: all elements have positive Jacobians)
        foreach (var n in model.FeNodes) n.Bc = n.X < 1e-9 ? Fixed(true, true) : null;
        model.FeNodes.First(n => n.X > 9.9 && n.Y < 0.1).Bc = Load(100, 0);
        var r = Solver.Solve(model);
        Assert.All(r.Displacements, d => Assert.True(double.IsFinite(d.Dx)));
    }

    [Fact]
    public void Mesher_ArcEdge_MatchesWebtoolSample()
    {
        // The webtool sample (curved-plate-with-bars.json) has edge 4 of a 100x50 plate
        // from (0,50) to (0,0) with R=200; its meshed midpoint landed at x=-1.5687, y=25.
        var (x, y) = Mesher.ArcPoint(0, 50, 0, 0, 200, 0.5);
        Assert.Equal(-1.5687, x, 3);
        Assert.Equal(25.0, y, 6);

        // Zero radius degenerates to a straight line
        var (lx, ly) = Mesher.ArcPoint(0, 0, 10, 0, 0, 0.25);
        Assert.Equal(2.5, lx, 12);
        Assert.Equal(0, ly, 12);
    }

    [Fact]
    public void Mesher_MoveGeometryPoint_RemeshesAffectedSurfaces()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 4, 4);
        int nodesBefore = model.FeNodes.Count, elsBefore = model.FeElements.Count;

        // Move corner 2 (10,0) -> (15,0): mesh should regenerate, same topology, new coords
        var summary = Mesher.MoveGeometryPoint(model, s.NodeIds[1], 15, 0);

        Assert.Contains("re-meshed", summary);
        Assert.Equal(15, model.Nodes.First(g => g.Id == s.NodeIds[1]).X);
        Assert.Equal(nodesBefore, model.FeNodes.Count);
        Assert.Equal(elsBefore, model.FeElements.Count);
        Assert.Contains(model.FeNodes, n => Math.Abs(n.X - 15) < 1e-9 && Math.Abs(n.Y) < 1e-9); // mesh follows
        Assert.Equal(model.FeNodes.Count, model.FeNodes.Select(n => n.Id).Distinct().Count());

        // Unmeshed surfaces are untouched by a point move
        var s2 = Mesher.AddSurface(model, new[] { (20.0, 0.0), (30.0, 0.0), (30.0, 10.0), (20.0, 10.0) }, 1e7, 0.3, 0.1);
        var summary2 = Mesher.MoveGeometryPoint(model, s2.NodeIds[0], 21, 1);
        Assert.DoesNotContain("re-meshed", summary2);
    }

    [Fact]
    public void Mesher_DeleteElements_RemovesOrphanNodes()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 1); // 2 elements, 6 nodes

        var el0 = model.FeElements[0];
        var (els, orphans) = Mesher.DeleteElements(model, new[] { el0.Id });

        Assert.Equal(1, els);
        Assert.Equal(2, orphans); // the two nodes used only by the deleted element
        Assert.Single(model.FeElements);
        Assert.Equal(4, model.FeNodes.Count);
        // Remaining element's nodes all still exist
        Assert.All(model.FeElements[0].NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id));
    }

    [Fact]
    public void NodalStresses_UniformField_EqualElementStress()
    {
        // Uniform uniaxial stress: every node's averaged stress must equal the
        // element stress exactly (corner values = centre value = 1000 psi).
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        foreach (var n in model.FeNodes)
        {
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);
            // Consistent nodal loads for uniform traction: edge corners take half
            else if (n.X > 10 - 1e-9)
                n.Bc = Load(n.Y < 1e-9 || n.Y > 10 - 1e-9 ? 250 : 500, 0);
        }

        var r = Solver.Solve(model);

        Assert.Equal(model.FeNodes.Count, r.NodalStresses.Count);
        foreach (var ns in r.NodalStresses)
        {
            Assert.Equal(1000, ns.Sxx, 4);
            Assert.Equal(0, ns.Syy, 4);
            Assert.Equal(1000, ns.SigmaVM, 4);
        }
        // Interior node of a 2x2 mesh touches 4 elements, corners touch 1
        Assert.Contains(r.NodalStresses, ns => ns.ElementCount == 4);
        Assert.Contains(r.NodalStresses, ns => ns.ElementCount == 1);
    }

    [Fact]
    public void NodalStresses_StepChange_AveragesAtSharedNodes()
    {
        // Two elements in series with different thickness: sx = P/(t*w) differs per
        // element; at the shared nodes the average of the two corner values is reported.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 2, 1); // 2 elements side by side
        var left = model.FeElements.First(e => model.FeNodes.First(n => n.Id == e.NodeIds[0]).X < 5);
        var right = model.FeElements.First(e => e.Id != left.Id);
        left.PropT = 0.2;   // sx = 1000/(0.2*10) = 500
        right.PropT = 0.1;  // sx = 1000/(0.1*10) = 1000

        foreach (var n in model.FeNodes)
        {
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);
            else if (n.X > 20 - 1e-9) n.Bc = Load(500, 0);
        }

        var r = Solver.Solve(model);

        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        foreach (var ns in r.NodalStresses)
        {
            var n = nodeById[ns.NodeId];
            double expected = n.X < 5 ? 500 : n.X > 15 ? 1000 : (500 + 1000) / 2.0; // shared mid-nodes average
            Assert.Equal(expected, ns.Sxx, 3);
        }
    }

    [Fact]
    public void Mesher_SpringPointGrid_CountsAndSpacing()
    {
        var model = new FeModel();
        var pts = Mesher.AddSpringPointGrid(model, 10, 20, 40, 30, 5, 3);

        Assert.Equal(15, pts.Count);
        Assert.Equal(15, model.SpringPoints.Count);
        Assert.Contains(model.SpringPoints, p => p.X == 10 && p.Y == 20);   // start
        Assert.Contains(model.SpringPoints, p => p.X == 50 && p.Y == 50);   // far corner
        Assert.Contains(model.SpringPoints, p => p.X == 20 && p.Y == 35);   // interior pitch 10, 15

        // A 1 x N grid collapses the X dimension
        var single = Mesher.AddSpringPointGrid(model, 0, 0, 100, 10, 1, 2);
        Assert.All(single, p => Assert.Equal(0, p.X));
    }

    [Fact]
    public void Mesher_SpringsAtSpringPoints_ExactlyTwoVisibleNodesRule()
    {
        // Two coincident meshed surfaces (doubler-style): seam node pairs sit on top
        // of each other; spring points placed at four of those locations.
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        var s2 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.05);
        Mesher.MeshMembrane(model, s1, 2, 2);
        Mesher.MeshMembrane(model, s2, 2, 2); // 9 nodes from each, pairwise coincident

        Mesher.AddSpringPointGrid(model, 0, 0, 10, 10, 2, 2); // 4 corner spring points
        var r = Mesher.CreateSpringsAtSpringPoints(model, 0.01, 5e4);

        Assert.Equal(4, r.Created);                  // one spring per point, never more
        Assert.Equal(0, r.SkippedTooMany);
        Assert.Equal(4, model.FeSprings.Count);
        Assert.All(model.FeSprings, s => Assert.NotEqual(s.FeNodeId1, s.FeNodeId2));

        // Re-running creates nothing new (duplicate protection)
        var r2 = Mesher.CreateSpringsAtSpringPoints(model, 0.01, 5e4);
        Assert.Equal(0, r2.Created);
        Assert.Equal(4, r2.SkippedDuplicate);

        // Too-large range sees many nodes -> skipped, not guessed
        model.FeSprings.Clear();
        var r3 = Mesher.CreateSpringsAtSpringPoints(model, 50, 5e4);
        Assert.Equal(0, r3.Created);
        Assert.Equal(4, r3.SkippedTooMany);

        // A point with only one node in range is skipped (springs were cleared above,
        // so the 4 corner points create again and the lone-node point is skipped)
        Mesher.AddSpringPointGrid(model, 100, 100, 1, 1, 1, 1);
        model.FeNodes.Add(new FeNode { Id = 999, X = 100, Y = 100 });
        var r4 = Mesher.CreateSpringsAtSpringPoints(model, 0.01, 5e4);
        Assert.Equal(4, r4.Created);
        Assert.Equal(1, r4.SkippedTooFew);
    }

    [Fact]
    public void Mesher_SpringsAtSpringPoints_OnlyVisibleNodesConsidered()
    {
        // THREE coincident surfaces: 3 nodes at each location -> skipped (too many).
        // Hiding one surface leaves exactly 2 visible nodes -> springs created, and
        // none of them touch the hidden surface's nodes.
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        var s2 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.05);
        var s3 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.02);
        Mesher.MeshMembrane(model, s1, 1, 1);
        Mesher.MeshMembrane(model, s2, 1, 1);
        Mesher.MeshMembrane(model, s3, 1, 1);
        Mesher.AddSpringPointGrid(model, 0, 0, 10, 10, 2, 2);

        var all = Mesher.CreateSpringsAtSpringPoints(model, 0.01, 5e4);
        Assert.Equal(0, all.Created);
        Assert.Equal(4, all.SkippedTooMany);

        s3.Visible = false;
        var vis = Mesher.CreateSpringsAtSpringPoints(model, 0.01, 5e4);
        Assert.Equal(4, vis.Created);
        var s3Nodes = model.FeNodes.Where(n => n.MembraneId == s3.Id).Select(n => n.Id).ToHashSet();
        Assert.All(model.FeSprings, sp =>
        {
            Assert.DoesNotContain(sp.FeNodeId1, s3Nodes);
            Assert.DoesNotContain(sp.FeNodeId2, s3Nodes);
        });
    }

    [Fact]
    public void Mesher_AddSurface_SharedPoints()
    {
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);

        // Second surface reuses s1's right-edge points (snap behaviour)
        int p2 = s1.NodeIds[1], p3 = s1.NodeIds[2];
        var s2 = Mesher.AddSurface(model, new[]
        {
            (0.0, 0.0, (int?)p2),
            (20.0, 0.0, null),
            (20.0, 10.0, null),
            (0.0, 0.0, (int?)p3)
        }, 1e7, 0.3, 0.1);

        Assert.Equal(6, model.Nodes.Count);              // 4 + 2 new, not 8
        Assert.Equal(p2, s2.NodeIds[0]);
        Assert.Equal(p3, s2.NodeIds[3]);

        // Moving the shared point updates both surfaces' meshes
        Mesher.MeshMembrane(model, s1, 2, 2);
        Mesher.MeshMembrane(model, s2, 2, 2);
        Mesher.MoveGeometryPoint(model, p2, 12, 0);
        Assert.Contains(model.FeNodes, n => n.MembraneId == s1.Id && Math.Abs(n.X - 12) < 1e-9 && Math.Abs(n.Y) < 1e-9);
        Assert.Contains(model.FeNodes, n => n.MembraneId == s2.Id && Math.Abs(n.X - 12) < 1e-9 && Math.Abs(n.Y) < 1e-9);

        // Duplicate corner picks are rejected
        Assert.Throws<InvalidOperationException>(() => Mesher.AddSurface(model, new[]
        {
            (0.0, 0.0, (int?)p2), (0.0, 0.0, (int?)p2), (30.0, 0.0, (int?)null), (30.0, 10.0, (int?)null)
        }, 1e7, 0.3, 0.1));
    }

    [Fact]
    public void Mesher_MergeCoincidentNodes_StitchesTwoSurfacesIntoContinuousPlate()
    {
        // Two 5x10 surfaces side by side sharing the x=5 line, meshed separately ->
        // duplicate nodes along the seam. After merging, the pair must behave as one
        // continuous 10x10 plate: uniaxial tension gives the exact bilinear answer.
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (5.0, 0.0), (5.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        var s2 = Mesher.AddSurface(model, new[] { (5.0, 0.0), (10.0, 0.0), (10.0, 10.0), (5.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s1, 2, 2);
        Mesher.MeshMembrane(model, s2, 2, 2);
        Assert.Equal(18, model.FeNodes.Count); // 9 + 9, seam doubled

        var (merged, _, _) = Mesher.MergeCoincidentNodes(model, 1e-6);

        Assert.Equal(3, merged);                // the 3 seam nodes
        Assert.Equal(15, model.FeNodes.Count);
        Assert.All(model.FeElements, el => Assert.All(el.NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id)));

        // Solve: fixed left edge, 1000 lb total on right edge -> sx = 1000 psi exact
        foreach (var n in model.FeNodes)
        {
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);
            else if (n.X > 10 - 1e-9) n.Bc = Load(1000.0 / 3, 0);
        }
        var r = Solver.Solve(model);
        foreach (var st in r.ElementStresses) Assert.Equal(1000, st.Sxx, 4);
        Assert.Equal(-1000, r.Reactions.Sum(x => x.Rx), 4);
    }

    [Fact]
    public void Mesher_MergeCoincidentNodes_PreservesSpringPairsAndBcs()
    {
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0 },                                  // spring pair a
                new FeNode { Id = 2, X = 0.001, Y = 0 },                              // spring pair b (coincident!)
                new FeNode { Id = 3, X = 5, Y = 5, Bc = Load(50, 0) },                // plain pair a (no BC kept node gets one)
                new FeNode { Id = 4, X = 5.001, Y = 5 },                              // plain pair b
                new FeNode { Id = 5, X = 9, Y = 9 }
            },
            FeSprings = { new FeSpring { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, Stiffness = 1e5 } },
            FeBars =
            {
                new FeBar { Id = 1, FeNodeId1 = 3, FeNodeId2 = 5, E = 1e7, A = 0.1 },
                new FeBar { Id = 2, FeNodeId1 = 4, FeNodeId2 = 3, E = 1e7, A = 0.1 } // becomes degenerate
            }
        };

        var (merged, springsRemoved, barsRemoved) = Mesher.MergeCoincidentNodes(model, 0.01);

        Assert.Equal(1, merged);                                   // only 3+4; 1+2 protected by spring
        Assert.Equal(0, springsRemoved);
        Assert.Equal(1, barsRemoved);                              // bar 2 collapsed to a point
        Assert.Contains(model.FeNodes, n => n.Id == 1);
        Assert.Contains(model.FeNodes, n => n.Id == 2);            // spring pair survives
        Assert.DoesNotContain(model.FeNodes, n => n.Id == 4);
        Assert.Single(model.FeSprings);
        Assert.Single(model.FeBars);
        Assert.NotNull(model.FeNodes.First(n => n.Id == 3).Bc);    // BC retained on kept node

        // Scoped merge: nothing outside the given set is touched
        var model2 = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0 },
                new FeNode { Id = 2, X = 0.001, Y = 0 },
                new FeNode { Id = 3, X = 1, Y = 0 },
                new FeNode { Id = 4, X = 1.001, Y = 0 }
            }
        };
        var (m2, _, _) = Mesher.MergeCoincidentNodes(model2, 0.01, new[] { 3, 4 });
        Assert.Equal(1, m2);
        Assert.Contains(model2.FeNodes, n => n.Id == 1);
        Assert.Contains(model2.FeNodes, n => n.Id == 2); // out of scope, untouched
    }

    [Fact]
    public void Mesher_MergeCoincidentNodes_NegativeCoordinates()
    {
        // Spatial-hash cells use floor division - make sure negative coords hash
        // consistently (real models are often centred on the origin).
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = -7.07, Y = -7.07 },
                new FeNode { Id = 2, X = -7.075, Y = -7.07 },   // within 0.01 of node 1
                new FeNode { Id = 3, X = -50, Y = 50 },
                new FeNode { Id = 4, X = -50.009, Y = 50.001 }, // within 0.01 of node 3 (crosses a cell boundary)
                new FeNode { Id = 5, X = 0.005, Y = -0.005 },
                new FeNode { Id = 6, X = -0.004, Y = 0.004 }    // within 0.02 of node 5, straddling origin
            }
        };

        var (merged, _, _) = Mesher.MergeCoincidentNodes(model, 0.02);

        Assert.Equal(3, merged);
        Assert.Equal(3, model.FeNodes.Count);
        Assert.Contains(model.FeNodes, n => n.Id == 1);
        Assert.Contains(model.FeNodes, n => n.Id == 3);
        Assert.Contains(model.FeNodes, n => n.Id == 5);
    }

    [Fact]
    public void Mesher_ClearMesh_KeepsNodesSharedWithOtherSurfaces()
    {
        // Stitch two meshed surfaces, then re-mesh one: the seam nodes now belong to
        // the other surface's elements and must survive the clear.
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (5.0, 0.0), (5.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        var s2 = Mesher.AddSurface(model, new[] { (5.0, 0.0), (10.0, 0.0), (10.0, 10.0), (5.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s1, 2, 2);
        Mesher.MeshMembrane(model, s2, 2, 2);
        Mesher.MergeCoincidentNodes(model, 1e-6);

        Mesher.ClearMesh(model, s1.Id);

        // s2's elements must keep all their nodes (including the former seam)
        Assert.All(model.FeElements, el => Assert.All(el.NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id)));
        Assert.Equal(4, model.FeElements.Count);
        Assert.Equal(9, model.FeNodes.Count);
    }

    [Fact]
    public void Mesher_DeleteSurface_RemovesMeshAndOrphanGeometry()
    {
        var model = new FeModel();
        var s1 = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        var s2 = Mesher.AddSurface(model, new[] { (20.0, 0.0), (30.0, 0.0), (30.0, 10.0), (20.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s1, 2, 2);
        Mesher.MeshMembrane(model, s2, 2, 2);
        Mesher.CreateBarsAlongNodes(model, model.FeNodes.Where(n => n.MembraneId == s1.Id && n.Y < 1e-9).Select(n => n.Id).ToList(), 1e7, 0.1);

        Mesher.DeleteSurface(model, s1.Id);

        Assert.Single(model.Membranes);
        Assert.Equal(4, model.Nodes.Count);                               // s1's corners gone
        Assert.DoesNotContain(model.FeNodes, n => n.MembraneId == s1.Id); // s1 mesh gone
        Assert.Empty(model.FeBars);                                       // bars on s1 nodes gone
        Assert.Equal(9, model.FeNodes.Count);                             // s2 mesh intact
    }

    [Fact]
    public void WebtoolJson_RoundTrip()
    {
        const string json = """
        {
          "nodes": [ { "id": 1, "x": 0, "y": 0 } ],
          "membranes": [ { "id": 1, "nodeIds": [1], "materialE": 1.05e7, "materialNu": 0.33,
                           "materialT": 0.05, "edgeRadii": [60, 0, -60, 0], "visible": true } ],
          "feNodes": [ { "id": 1, "x": 0, "y": 0, "membraneId": 1,
                         "bc": { "type": "fixed", "value": { "fixX": true, "fixY": false } } } ],
          "feElements": [],
          "feSprings": [ { "id": 1, "feNodeId1": 1, "feNodeId2": 1, "stiffness": 50000 } ],
          "feBars": [ { "id": 1, "feNodeId1": 1, "feNodeId2": 1, "E": 1.05e7, "A": 0.08 } ]
        }
        """;

        var model = FeModel.FromJson(json);

        Assert.Single(model.Membranes);
        Assert.Equal(new List<double> { 60, 0, -60, 0 }, model.Membranes[0].EdgeRadii);
        Assert.True(model.FeNodes[0].Bc!.Value.FixX);
        Assert.False(model.FeNodes[0].Bc!.Value.FixY);
        Assert.Equal(50000, model.FeSprings[0].Stiffness);
        Assert.Equal(0.08, model.FeBars[0].A);

        // Round-trip preserves the webtool's camelCase field names
        var json2 = model.ToJson();
        var model2 = FeModel.FromJson(json2);
        Assert.Equal(model.Membranes[0].EdgeRadii, model2.Membranes[0].EdgeRadii);
        Assert.True(model2.FeNodes[0].Bc!.Value.FixX);
    }
}
