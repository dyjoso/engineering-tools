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
    public void Mesher_DeleteNodes_CascadesToAttachedEntities()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2); // 9 nodes, 4 elements
        var corner = model.FeNodes.First(n => Math.Abs(n.X) < 1e-9 && Math.Abs(n.Y) < 1e-9);
        var far = model.FeNodes.First(n => n.X > 9.9 && n.Y > 9.9);
        model.FeBars.Add(new FeBar { Id = 1, FeNodeId1 = corner.Id, FeNodeId2 = far.Id, E = 1e7, A = 0.1 });
        model.FeSprings.Add(new FeSpring { Id = 1, FeNodeId1 = corner.Id, FeNodeId2 = far.Id, Stiffness = 1e5 });
        Mesher.CreateRbe2(model, new[] { corner.Id, far.Id }, true, true);

        var (nodes, els, springs, bars) = Mesher.DeleteNodes(model, new[] { corner.Id });

        Assert.Equal(1, nodes);
        Assert.Equal(1, els);     // only the corner element touches that node
        Assert.Equal(1, springs);
        Assert.Equal(1, bars);
        Assert.Equal(8, model.FeNodes.Count);
        Assert.Equal(3, model.FeElements.Count);
        Assert.Empty(model.Rbe2s); // independent node deleted -> RBE2 removed
        Assert.All(model.FeElements, el => Assert.All(el.NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id)));
    }

    [Fact]
    public void Rbe2_TiesSelectedDofsExactly()
    {
        // Plate, left edge fixed. RBE2 ties the right edge in X only; the load goes
        // on ONE right-edge node but every tied node must move identically in X
        // (and the plate must carry the full load - check via reactions).
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        var rightNodes = model.FeNodes.Where(n => n.X > 10 - 1e-9).OrderBy(n => n.Y).ToList();
        foreach (var n in model.FeNodes)
            if (n.X < 1e-9) n.Bc = Fixed(true, true);
        rightNodes[1].Bc = Load(1000, 0); // mid-height node only

        Mesher.CreateRbe2(model, rightNodes.Select(n => n.Id).ToList(), tieX: true, tieY: false);

        var r = Solver.Solve(model);

        var dx = rightNodes.Select(n => r.Displacements.Single(d => d.NodeId == n.Id).Dx).ToList();
        Assert.All(dx, v => Assert.Equal(dx[0], v, 12));   // X tied exactly
        var dy = rightNodes.Select(n => r.Displacements.Single(d => d.NodeId == n.Id).Dy).ToList();
        Assert.NotEqual(dy[0], dy[1], 9);                  // Y left free (Poisson contraction differs)
        Assert.Equal(-1000, r.Reactions.Sum(x => x.Rx), 4); // equilibrium through the tie
        Assert.True(dx[0] > 0);
    }

    [Fact]
    public void Rbe2_ConstrainsViaIndependentNode()
    {
        // Constraint applied to the independent node holds the whole group: fix the
        // independent node in X, load a dependent node in X -> nothing moves in X,
        // and the full load appears as the reaction at the prescribing node.
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Fixed(true, true) },
                new FeNode { Id = 2, X = 10, Y = 0 },
                new FeNode { Id = 3, X = 10, Y = 5, Bc = Load(500, 0) }
            },
            FeBars = { new FeBar { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, E = 1e7, A = 0.1 } }
        };
        // Node 3 has no stiffness of its own - the RBE2 ties it to node 2 completely
        Mesher.CreateRbe2(model, new[] { 2, 3 }, tieX: true, tieY: true);
        // Y of the 2-3 group: bar gives no transverse stiffness, fix via node 2
        model.FeNodes.First(n => n.Id == 2).Bc = Fixed(false, true);

        var r = Solver.Solve(model);

        var d2 = r.Displacements.Single(d => d.NodeId == 2);
        var d3 = r.Displacements.Single(d => d.NodeId == 3);
        Assert.Equal(d2.Dx, d3.Dx, 12);
        Assert.Equal(d2.Dy, d3.Dy, 12);
        Assert.Equal(500.0 * 10 / (1e7 * 0.1), d2.Dx, 9); // PL/EA with the tied load
        Assert.Equal(-500, r.Reactions.Sum(x => x.Rx), 6);
    }

    [Fact]
    public void Rbe2_ConflictingPrescribedValues_Throw()
    {
        var model = new FeModel
        {
            FeNodes =
            {
                new FeNode { Id = 1, X = 0, Y = 0, Bc = Enforced(0.001, null) },
                new FeNode { Id = 2, X = 1, Y = 0, Bc = Enforced(0.002, null) },
                new FeNode { Id = 3, X = 2, Y = 0, Bc = Fixed(true, true) }
            },
            FeBars =
            {
                new FeBar { Id = 1, FeNodeId1 = 1, FeNodeId2 = 3, E = 1e7, A = 0.1 },
                new FeBar { Id = 2, FeNodeId1 = 2, FeNodeId2 = 3, E = 1e7, A = 0.1 }
            },
            FeSprings = { new FeSpring { Id = 1, FeNodeId1 = 1, FeNodeId2 = 2, Stiffness = 1e5 } }
        };
        Mesher.CreateRbe2(model, new[] { 1, 2 }, tieX: true, tieY: true);

        var ex = Assert.Throws<InvalidOperationException>(() => Solver.Solve(model));
        Assert.Contains("conflicts", ex.Message);
    }

    [Fact]
    public void Rbe2_CleanupOnMeshAndMergeOperations()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        var ids = model.FeNodes.Take(3).Select(n => n.Id).ToList();
        Mesher.CreateRbe2(model, ids, true, true);

        // Re-meshing destroys the nodes -> RBE2 goes with them
        Mesher.MeshMembrane(model, s, 3, 3);
        Assert.Empty(model.Rbe2s);

        // Merge remaps RBE2 node references
        var extra = new FeNode { Id = 9001, X = 0, Y = 0 }; // coincident with corner node
        model.FeNodes.Add(extra);
        var corner = model.FeNodes.First(n => Math.Abs(n.X) < 1e-9 && Math.Abs(n.Y) < 1e-9 && n.Id != 9001);
        var far = model.FeNodes.First(n => n.X > 9.9 && n.Y > 9.9);
        Mesher.CreateRbe2(model, new[] { extra.Id, far.Id }, true, true);
        Mesher.MergeCoincidentNodes(model, 1e-6);
        var rbe2 = Assert.Single(model.Rbe2s);
        Assert.Equal(corner.Id, Math.Min(rbe2.IndependentNodeId, rbe2.DependentNodeIds.Min()));
        Assert.DoesNotContain(9001, rbe2.DependentNodeIds);
    }

    private static double MacNealCantileverTip(int m, int n)
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (6.0, 0.0), (6.0, 0.2), (0.0, 0.2) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, m, n, quadratic: true);
        foreach (var nd in model.FeNodes)
            if (Math.Abs(nd.X) < 1e-9) nd.Bc = Fixed(true, true); // clamped root
        // Unit tip load as consistent quadratic-edge loads on the end face
        var endN = model.FeNodes.Where(nd => Math.Abs(nd.X - 6) < 1e-9).OrderBy(nd => nd.Y).ToList();
        int ne = (endN.Count - 1) / 2;
        var f = new Dictionary<int, double>();
        for (int k = 0; k < ne; k++)
        {
            f[endN[2 * k].Id] = f.GetValueOrDefault(endN[2 * k].Id) + 1.0 / (6 * ne);
            f[endN[2 * k + 1].Id] = f.GetValueOrDefault(endN[2 * k + 1].Id) + 4.0 / (6 * ne);
            f[endN[2 * k + 2].Id] = f.GetValueOrDefault(endN[2 * k + 2].Id) + 1.0 / (6 * ne);
        }
        foreach (var (id, fy) in f) model.FeNodes.First(nd => nd.Id == id).Bc = Load(0, fy);
        var r = Solver.Solve(model);
        return endN.Select(nd => r.Displacements.Single(d => d.NodeId == nd.Id).Dy).Average();
    }

    /// <summary>
    /// MacNeal distorted-element cantilever built from 6 SURFACES (one Q8 element
    /// each, adjacent surfaces sharing corner points), stitched with a
    /// coincident-node merge.
    /// Trapezoidal: interior boundaries slant alternately; outer ends vertical.
    /// Parallelogram: interior boundaries slant the SAME way (MacNeal's skew
    /// pattern - the outline stays rectangular with a vertical clamped root, so
    /// the 0.1081 reference applies; the middle four elements are parallelograms,
    /// the end pair mirrored trapezoids).
    /// Returns the model with BCs applied, ready to solve.
    /// </summary>
    private static (FeModel model, List<FeNode> tipNodes) MacNealDistortedBuild(double edgeAngleDeg, bool parallelogram)
    {
        const double h = 0.2;
        double tanA = Math.Tan(edgeAngleDeg * Math.PI / 180);
        var bot = new double[7];
        var top = new double[7];
        for (int i = 0; i <= 6; i++)
        {
            double s = (i == 0 || i == 6) ? 0
                : parallelogram ? 1                  // common slant direction
                : (i % 2 == 1 ? 1 : -1);             // alternating (trapezoidal)
            bot[i] = i - s * (h / 2) * tanA;
            top[i] = i + s * (h / 2) * tanA;
        }

        var model = new FeModel();
        int prevBotId = -1, prevTopId = -1;
        for (int k = 0; k < 6; k++)
        {
            var corners = new (double X, double Y, int? ExistingPointId)[]
            {
                (bot[k], 0, k > 0 ? prevBotId : null),
                (bot[k + 1], 0, null),
                (top[k + 1], h, null),
                (top[k], h, k > 0 ? prevTopId : null)
            };
            var s = Mesher.AddSurface(model, corners, 1e7, 0.3, 0.1);
            prevBotId = s.NodeIds[1]; // this surface's right-boundary points become
            prevTopId = s.NodeIds[2]; // the next surface's left boundary
            Mesher.MeshMembrane(model, s, 1, 1, quadratic: true);
        }

        // Stitch the seams (corner + midside FE nodes coincide exactly)
        var (merged, _, _) = Mesher.MergeCoincidentNodes(model, 1e-9);
        Assert.Equal(15, merged); // 3 nodes per interior boundary x 5

        // Root and tip edges are vertical in both patterns
        var rootN = model.FeNodes.Where(nd => Math.Abs(nd.X) < 1e-9).ToList();
        var tipN = model.FeNodes.Where(nd => Math.Abs(nd.X - 6) < 1e-9).OrderBy(nd => nd.Y).ToList();
        Assert.Equal(3, rootN.Count);
        Assert.Equal(3, tipN.Count);

        foreach (var nd in rootN) nd.Bc = Fixed(true, true); // clamped root
        tipN[0].Bc = Load(0, 1.0 / 6);
        tipN[1].Bc = Load(0, 4.0 / 6);
        tipN[2].Bc = Load(0, 1.0 / 6);
        return (model, tipN);
    }

    private static double MacNealDistortedTip(double edgeAngleDeg, bool parallelogram)
    {
        var (model, tipN) = MacNealDistortedBuild(edgeAngleDeg, parallelogram);
        var r = Solver.Solve(model);
        return tipN.Select(nd => r.Displacements.Single(d => d.NodeId == nd.Id).Dy).Average();
    }

    private static double MacNealTrapezoidTip(double edgeAngleDeg) => MacNealDistortedTip(edgeAngleDeg, false);

    [Fact]
    public void Quad8_MacNealCantilever_TrapezoidalElements()
    {
        // MacNeal's trapezoidal-element variant, built the way a user would:
        // 6 trapezoidal surfaces sharing corner points, one Q8 per surface,
        // stitched with Merge Coincident Nodes. Interior boundaries slant
        // alternately by the edge angle; reference tip deflection 0.1081.
        //
        // Measured (2x2 reduced integration):
        //   rectangular (0 deg): 0.9868   30 deg: 0.9816   45 deg: 0.9666
        // Mild, graceful trapezoidal sensitivity - well clear of the severe
        // trapezoidal locking that afflicts lower-order elements on this test.
        const double reference = 0.1081;

        double t30 = MacNealTrapezoidTip(30);
        Assert.True(Math.Abs(t30 - reference) / reference < 0.03,
            $"30deg tip {t30:G6} vs {reference} ({(t30 / reference - 1) * 100:F2}% off)");

        double t45 = MacNealTrapezoidTip(45);
        Assert.True(Math.Abs(t45 - reference) / reference < 0.05,
            $"45deg tip {t45:G6} vs {reference} ({(t45 / reference - 1) * 100:F2}% off)");
    }

    [Fact]
    public void Quad8_MacNealCantilever_ParallelogramElements()
    {
        // MacNeal's parallelogram (skew) variant: interior boundaries slanted in a
        // common direction, rectangular outline, vertical clamped root.
        //
        // Measured (2x2 reduced integration):
        //   30 deg: 0.9914   45 deg: 0.9969   (rectangular: 0.9868)
        // Skew preserves the affine element mapping, so the quadratic element
        // loses essentially nothing - slightly better than rectangular here.
        const double reference = 0.1081;

        double p30 = MacNealDistortedTip(30, parallelogram: true);
        Assert.True(Math.Abs(p30 - reference) / reference < 0.02,
            $"30deg tip {p30:G6} vs {reference} ({(p30 / reference - 1) * 100:F2}% off)");

        double p45 = MacNealDistortedTip(45, parallelogram: true);
        Assert.True(Math.Abs(p45 - reference) / reference < 0.02,
            $"45deg tip {p45:G6} vs {reference} ({(p45 / reference - 1) * 100:F2}% off)");
    }

    /// <summary>SENT benchmark model (same construction as Crack_EdgeCrackedPlate test).</summary>
    private static FeModel BuildSentBenchmark()
    {
        const double W = 10, H = 15, a = 3, sigma = 100, t = 0.1;
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -H), (W, -H), (W, H), (0.0, H) }, 1e7, 0.3, t);
        Mesher.MeshMembrane(model, s, 40, 120, quadratic: true);
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y) < 1e-9 && n.X <= a + 1e-9)
            .Select(n => n.Id).ToList();
        Mesher.CreateCrack(model, pathIds, tipAtStart: false, tipAtEnd: true);
        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - H) < 1e-9).Select(n => n.Id).ToList();
        var botIds = model.FeNodes.Where(n => Math.Abs(n.Y + H) < 1e-9).Select(n => n.Id).ToList();
        Mesher.ApplyDistributedLoad(model, topIds, 0, sigma * t, isTotal: false);
        Mesher.ApplyDistributedLoad(model, botIds, 0, -sigma * t, isTotal: false);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(true, true);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y - H / 2) < 1e-9).Bc = Fixed(true, false);
        return model;
    }

    /// <summary>CCT benchmark model (same construction as Crack_CentreCrackedPlate test).</summary>
    private static FeModel BuildCctBenchmark()
    {
        const double W2 = 20, H = 20, sigma = 100, t = 0.1;
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -H), (W2, -H), (W2, H), (0.0, H) }, 1e7, 0.3, t);
        Mesher.MeshMembrane(model, s, 40, 80, quadratic: true);
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y) < 1e-9 && n.X >= 6 - 1e-9 && n.X <= 14 + 1e-9)
            .Select(n => n.Id).ToList();
        Mesher.CreateCrack(model, pathIds, tipAtStart: true, tipAtEnd: true);
        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - H) < 1e-9).Select(n => n.Id).ToList();
        var botIds = model.FeNodes.Where(n => Math.Abs(n.Y + H) < 1e-9).Select(n => n.Id).ToList();
        Mesher.ApplyDistributedLoad(model, topIds, 0, sigma * W2 * t, isTotal: true);
        Mesher.ApplyDistributedLoad(model, botIds, 0, -sigma * W2 * t, isTotal: true);
        model.FeNodes.First(n => Math.Abs(n.X) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(true, true);
        model.FeNodes.First(n => Math.Abs(n.X - W2) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(false, true);
        return model;
    }

    /// <summary>Stringer load-transfer demo: skin + detached bar + fastener springs.</summary>
    private static FeModel BuildStringerDemo()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 4, 4);
        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - 10) < 1e-9).OrderBy(n => n.X).Select(n => n.Id).ToList();
        var bars = Mesher.CreateBarsAlongNodes(model, topIds, 1e7, 0.1);
        Mesher.DetachBars(model, bars.Select(b => b.Id).ToList());
        Mesher.AddSpringPointGrid(model, 0, 10, 10, 0, topIds.Count, 1);
        Mesher.CreateSpringsAtSpringPoints(model, 1e-6, 1e6);
        foreach (var n in model.FeNodes)
            if (n.MembraneId is not null && n.X < 1e-9) n.Bc = Fixed(true, true);
        model.FeNodes.Single(n => n.MembraneId is null &&
            Math.Abs(n.X - 10) < 1e-9 && Math.Abs(n.Y - 10) < 1e-9).Bc = Load(1000, 0);
        return model;
    }

    [Fact]
    public void BenchmarkModels_SaveForReview()
    {
        // Regenerate the benchmark models into validation/ so they can be opened,
        // reviewed and rendered (BCs included; solve to reproduce). Used by the
        // validation manual's image generation.
        var dir = AppContext.BaseDirectory;
        string? valDir = null;
        for (int i = 0; i < 8 && dir is not null; i++)
        {
            var candidate = Path.Combine(dir, "validation");
            if (Directory.Exists(candidate)) { valDir = candidate; break; }
            dir = Path.GetDirectoryName(dir);
        }
        Assert.False(valDir is null, "validation directory not found above test directory");

        MacNealDistortedBuild(0, parallelogram: false).model.Save(Path.Combine(valDir!, "macneal-rectangular.json"));
        MacNealDistortedBuild(30, parallelogram: false).model.Save(Path.Combine(valDir!, "macneal-trapezoid-30.json"));
        MacNealDistortedBuild(45, parallelogram: false).model.Save(Path.Combine(valDir!, "macneal-trapezoid-45.json"));
        MacNealDistortedBuild(30, parallelogram: true).model.Save(Path.Combine(valDir!, "macneal-parallelogram-30.json"));
        MacNealDistortedBuild(45, parallelogram: true).model.Save(Path.Combine(valDir!, "macneal-parallelogram-45.json"));
        BuildSentBenchmark().Save(Path.Combine(valDir!, "crack-sent-benchmark.json"));
        BuildCctBenchmark().Save(Path.Combine(valDir!, "crack-cct-benchmark.json"));
        BuildStringerDemo().Save(Path.Combine(valDir!, "stringer-load-transfer.json"));
    }

    [Fact]
    public void Quad8_MacNealCantilever_TipDeflectionAndConvergence()
    {
        // MacNeal & Harder (1985) straight cantilever: 6.0 x 0.2 x 0.1, E = 1e7,
        // nu = 0.3, unit in-plane shear load at the tip, rectangular elements.
        // Reference tip deflection (incl. shear) = 0.1081.
        //
        // Measured with 2x2 REDUCED integration (standard for Q8 membranes -
        // Nastran QUAD8 / Abaqus CPS8R):
        //   6x1: 0.9868   12x1: 0.9933   24x2: 0.9984   48x4: 0.9992   96x8: 0.9993
        // i.e. -1.3% on the coarse benchmark mesh (full 3x3 integration measured
        // -1.8%), converging to -0.07%, the residual being the physical
        // fully-clamped-root effect relative to beam theory. In line with
        // published QUAD8 results for this benchmark.
        const double reference = 0.1081;

        double coarse = MacNealCantileverTip(6, 1);
        Assert.True(Math.Abs(coarse - reference) / reference < 0.02,
            $"6x1 tip {coarse:G6} vs {reference} ({(coarse / reference - 1) * 100:F2}% off)");

        double fine = MacNealCantileverTip(48, 4);
        Assert.True(Math.Abs(fine - reference) / reference < 0.002,
            $"48x4 tip {fine:G6} vs {reference} ({(fine / reference - 1) * 100:F2}% off) - must converge");
    }

    [Fact]
    public void DistributedLoad_Quad4_ConsistentAndExact()
    {
        // Total 1000 lb spread over the right edge of a 2x2 Quad4 plate must produce
        // the consistent 250/500/250 pattern and therefore an EXACT uniform stress
        // field (sx = 1000 psi at every averaged node).
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        foreach (var n in model.FeNodes)
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);

        var rightIds = model.FeNodes.Where(n => n.X > 10 - 1e-9).Select(n => n.Id).ToList();
        var res = Mesher.ApplyDistributedLoad(model, rightIds, 1000, 0, isTotal: true);

        Assert.Equal(2, res.Edges);
        Assert.Equal(10, res.TotalLength, 9);
        Assert.Equal(1000, res.AppliedFx, 9);
        var corner = model.FeNodes.First(n => n.X > 10 - 1e-9 && n.Y < 1e-9);
        var mid = model.FeNodes.First(n => n.X > 10 - 1e-9 && Math.Abs(n.Y - 5) < 1e-9);
        Assert.Equal(250, corner.Bc!.Value.Fx!.Value, 9);
        Assert.Equal(500, mid.Bc!.Value.Fx!.Value, 9);

        var r = Solver.Solve(model);
        foreach (var ns in r.NodalStresses) Assert.Equal(1000, ns.Sxx, 4);
    }

    [Fact]
    public void DistributedLoad_Quad8_RunningLoad_ConsistentAndExact()
    {
        // Running load 100 lb/in over the 10-long right edge of a 2x2 Quad8 plate:
        // total 1000, per-edge 500 split 1/6-4/6-1/6 -> exact uniform stress.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2, quadratic: true);
        foreach (var n in model.FeNodes)
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);

        var rightIds = model.FeNodes.Where(n => n.X > 10 - 1e-9).Select(n => n.Id).ToList();
        Assert.Equal(5, rightIds.Count); // 3 corners + 2 midsides
        var res = Mesher.ApplyDistributedLoad(model, rightIds, 100, 0, isTotal: false);

        Assert.Equal(2, res.Edges);
        Assert.Equal(1000, res.AppliedFx, 9);
        var midside = model.FeNodes.First(n => n.X > 10 - 1e-9 && Math.Abs(n.Y - 2.5) < 1e-9);
        var sharedCorner = model.FeNodes.First(n => n.X > 10 - 1e-9 && Math.Abs(n.Y - 5) < 1e-9);
        Assert.Equal(500.0 * 4 / 6, midside.Bc!.Value.Fx!.Value, 9);
        Assert.Equal(2 * 500.0 / 6, sharedCorner.Bc!.Value.Fx!.Value, 9); // 1/6 from each edge

        var r = Solver.Solve(model);
        foreach (var ns in r.NodalStresses) Assert.Equal(1000, ns.Sxx, 4);
    }

    [Fact]
    public void DistributedLoad_AddsToExistingAndSkipsConstrained()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        foreach (var n in model.FeNodes)
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);

        var right = model.FeNodes.Where(n => n.X > 10 - 1e-9).OrderBy(n => n.Y).ToList();
        right[0].Bc = Load(0, 77);                                  // existing load: must be summed
        right[2].Bc = Fixed(true, true);                            // constrained: must be skipped

        var res = Mesher.ApplyDistributedLoad(model, right.Select(n => n.Id).ToList(), 1000, 0, isTotal: true);

        Assert.Equal(1, res.SkippedConstrained);
        Assert.Equal(250, right[0].Bc!.Value.Fx!.Value, 9);          // 250 added
        Assert.Equal(77, right[0].Bc!.Value.Fy!.Value, 9);           // existing FY kept
        Assert.Equal("fixed", right[2].Bc!.Type);                    // untouched
        Assert.Equal(750, res.AppliedFx, 9);                         // 250 share dropped

        // Selection without any complete element edge errors clearly
        var scattered = new[] { model.FeNodes.First(n => n.X < 1e-9).Id, right[1].Id };
        Assert.Throws<InvalidOperationException>(() =>
            Mesher.ApplyDistributedLoad(model, scattered, 1, 0, true));
    }

    [Fact]
    public void Quad8_PatchTest_UniaxialTensionExact()
    {
        // Single Q8, 10x10, E=1e7, nu=0, t=0.1, total 1000 lb on the right edge.
        // Consistent nodal loads for uniform traction on a quadratic edge: corners 1/6,
        // midside 4/6 of the edge total. Exact answer: sx=1000 psi, u_right=1e-3.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 1, 1, quadratic: true);

        Assert.Equal(8, model.FeNodes.Count);
        Assert.Single(model.FeElements);
        Assert.Equal("quad8", model.FeElements[0].Type);

        foreach (var n in model.FeNodes)
        {
            if (n.X < 1e-9) n.Bc = Fixed(true, n.Y < 1e-9);
            else if (n.X > 10 - 1e-9)
                n.Bc = Load(n.Y is > 1e-9 and < 10 - 1e-9 ? 1000.0 * 4 / 6 : 1000.0 / 6, 0);
        }

        var r = Solver.Solve(model);

        foreach (var n in model.FeNodes.Where(n => n.X > 10 - 1e-9))
            Assert.Equal(1e-3, r.Displacements.Single(d => d.NodeId == n.Id).Dx, 9);
        Assert.Equal(1000, r.ElementStresses.Single().Sxx, 4);
        // Nodal-averaged stresses exact at ALL 8 nodes (corners and midsides)
        Assert.Equal(8, r.NodalStresses.Count);
        foreach (var ns in r.NodalStresses) Assert.Equal(1000, ns.Sxx, 4);
        Assert.Equal(-1000, r.Reactions.Sum(x => x.Rx), 5);
    }

    [Fact]
    public void Quad8_PureBending_ExactLinearStress()
    {
        // The killer Q8 advantage: a SINGLE Q8 carries pure in-plane bending exactly
        // (quadratic displacements -> linear strain). Apply a linear end traction
        // sx = +/-1000 at y = +/-5 via consistent loads on the right edge and check
        // the linear stress profile. A single Q4 cannot do this (shear locking).
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -5.0), (20.0, -5.0), (20.0, 5.0), (0.0, 5.0) }, 1e7, 0.0, 0.1);
        Mesher.MeshMembrane(model, s, 1, 1, quadratic: true);

        // Consistent loads for traction sx(y) = 200*y on edge x=20 (t=0.1, height 10):
        // corner nodes (y=+-5): +/-500/3, midside (y=0): 0
        foreach (var n in model.FeNodes)
        {
            if (n.X < 1e-9)
                n.Bc = Math.Abs(n.Y) < 1e-9
                    ? Fixed(true, true)          // mid-height: pin
                    : Fixed(true, false);        // corners: symmetry in x
            else if (n.X > 20 - 1e-9 && Math.Abs(n.Y) > 1e-9)
                n.Bc = Load(Math.Sign(n.Y) * 500.0 / 3, 0);
        }

        var r = Solver.Solve(model);

        // Averaged nodal stresses follow sx = 200*y at every node
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        foreach (var ns in r.NodalStresses)
            Assert.Equal(200 * nodeById[ns.NodeId].Y, ns.Sxx, 3);
    }

    [Fact]
    public void Quad8_Mesher_CountsAndMidsides()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        var (nodes, els) = Mesher.MeshMembrane(model, s, 4, 3, quadratic: true);

        // Serendipity grid: (2M+1)(2N+1) - M*N centre points
        Assert.Equal(9 * 7 - 12, nodes);
        Assert.Equal(12, els);
        Assert.All(model.FeElements, el => Assert.Equal(8, el.NodeIds.Count));
        Assert.True(s.MeshQuadratic);

        // Midside nodes sit between their corners
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        foreach (var el in model.FeElements)
        {
            var n = el.NodeIds.Select(id => nodeById[id]).ToArray();
            Assert.Equal((n[0].X + n[1].X) / 2, n[4].X, 9);
            Assert.Equal((n[1].Y + n[2].Y) / 2, n[5].Y, 9);
        }

        // Re-mesh back to quad4 replaces cleanly
        Mesher.MeshMembrane(model, s, 2, 2, quadratic: false);
        Assert.Equal(9, model.FeNodes.Count);
        Assert.False(s.MeshQuadratic);
    }

    [Fact]
    public void Quad8_QuarterPoint_CrackTipConfigurationSolves()
    {
        // Quarter-point (Barsoum) configuration: midside nodes adjacent to a crack-tip
        // corner moved to the quarter position. The element must assemble (Gauss points
        // are interior, Jacobian positive there), solve, and produce finite stresses
        // (nodal averaging nudges off the singular tip).
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 1, 1, quadratic: true);

        // Crack tip at corner node 1 (0,0): shift midsides 5 (edge 1-2) and 8 (edge 4-1)
        // to the quarter points nearest the tip.
        var el = model.FeElements.Single();
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        var mid5 = nodeById[el.NodeIds[4]];
        mid5.X = 2.5; mid5.Y = 0;       // quarter of edge 1-2 from the tip
        var mid8 = nodeById[el.NodeIds[7]];
        mid8.X = 0; mid8.Y = 2.5;       // quarter of edge 4-1 from the tip

        foreach (var n in model.FeNodes)
        {
            if (n.X > 10 - 1e-9) n.Bc = Fixed(true, true);             // clamp far edge
            else if (n.X < 1e-9 && n.Y < 1e-9) n.Bc = Load(0, -100);   // pull the tip
        }

        var r = Solver.Solve(model);

        Assert.All(r.Displacements, d => Assert.True(double.IsFinite(d.Dx) && double.IsFinite(d.Dy)));
        Assert.All(r.NodalStresses, ns => Assert.True(double.IsFinite(ns.SigmaVM)));
        Assert.Equal(100, r.Reactions.Sum(x => x.Ry), 5); // equilibrium holds
    }

    // ---- Crack / SIF helpers ----

    /// <summary>Apply uniform traction (total force F, +Y direction) as consistent
    /// nodal loads on a horizontal Quad8 boundary at the given y.</summary>
    private static void LoadQ8EdgeY(FeModel model, double yEdge, double totalFy)
    {
        var edgeNodes = model.FeNodes.Where(n => Math.Abs(n.Y - yEdge) < 1e-9)
            .OrderBy(n => n.X).ToList();
        // edge nodes alternate corner-midside-corner...; per quadratic edge of length
        // covered by [c, m, c]: 1/6, 4/6, 1/6 of that edge's share
        int nEdges = (edgeNodes.Count - 1) / 2;
        double perEdge = totalFy / nEdges;
        var f = new Dictionary<int, double>();
        for (int e = 0; e < nEdges; e++)
        {
            f[edgeNodes[2 * e].Id] = f.GetValueOrDefault(edgeNodes[2 * e].Id) + perEdge / 6;
            f[edgeNodes[2 * e + 1].Id] = f.GetValueOrDefault(edgeNodes[2 * e + 1].Id) + perEdge * 4 / 6;
            f[edgeNodes[2 * e + 2].Id] = f.GetValueOrDefault(edgeNodes[2 * e + 2].Id) + perEdge / 6;
        }
        foreach (var (id, fy) in f)
            model.FeNodes.First(n => n.Id == id).Bc = Load(0, fy);
    }

    [Fact]
    public void Crack_InteractionIntegral_DomainIndependence()
    {
        // The defining property of a correct domain integral: K must be (nearly)
        // independent of the integration domain size. Solve the SENT benchmark once
        // and evaluate the interaction integral over annuli of 2L, 3L, 4L and 6L.
        const double W = 10, H = 15, a = 3, sigma = 100, t = 0.1;
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -H), (W, -H), (W, H), (0.0, H) }, 1e7, 0.3, t);
        Mesher.MeshMembrane(model, s, 40, 120, quadratic: true);
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y) < 1e-9 && n.X <= a + 1e-9)
            .Select(n => n.Id).ToList();
        var crack = Mesher.CreateCrack(model, pathIds, tipAtStart: false, tipAtEnd: true).Single();
        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - H) < 1e-9).Select(n => n.Id).ToList();
        var botIds = model.FeNodes.Where(n => Math.Abs(n.Y + H) < 1e-9).Select(n => n.Id).ToList();
        Mesher.ApplyDistributedLoad(model, topIds, 0, sigma * t, isTotal: false);
        Mesher.ApplyDistributedLoad(model, botIds, 0, -sigma * t, isTotal: false);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(true, true);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y - H / 2) < 1e-9).Bc = Fixed(true, false);

        var r = Solver.Solve(model);
        var disp = r.Displacements.ToDictionary(d => d.NodeId, d => (d.Dx, d.Dy));
        double faceL = r.CrackSifs.Single().FaceElementLength;

        var ks = new[] { 2.0, 3.0, 4.0, 6.0 }
            .Select(k => InteractionIntegral.Compute(model, crack, disp, k * faceL)!.K1)
            .ToList();
        double mean = ks.Average();
        foreach (var k1 in ks)
            Assert.True(Math.Abs(k1 - mean) / mean < 0.01,
                $"domain spread too large: {string.Join(", ", ks.Select(v => v.ToString("G6")))}");
    }

    [Fact]
    public void Crack_SplitTopology_FacesSeparateAndTipIsQuarterPoint()
    {
        // 4x4 Quad8 plate, edge crack from the left boundary to mid-plate at mid-height.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (4.0, 0.0), (4.0, 4.0), (0.0, 4.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 4, 4, quadratic: true);
        int nodesBefore = model.FeNodes.Count;

        // Path along y=2 from x=0 to x=2: corners at x=0,1,2 and midsides at 0.5,1.5
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y - 2) < 1e-9 && n.X <= 2 + 1e-9)
            .Select(n => n.Id).ToList();
        Assert.Equal(5, pathIds.Count);

        var cracks = Mesher.CreateCrack(model, pathIds, tipAtStart: false, tipAtEnd: true);

        var crack = Assert.Single(cracks);
        // 4 non-tip path nodes duplicated (x=0, 0.5, 1, 1.5; the x=2 tip is shared)
        Assert.Equal(nodesBefore + 4, model.FeNodes.Count);
        Assert.All(model.FeElements, el => Assert.All(el.NodeIds, id => Assert.Contains(model.FeNodes, n => n.Id == id)));

        // Quarter-point check: the path midside behind the tip moved from x=1.5 to
        // tip + L/4 = 2 - 0.25 = 1.75 (both faces)
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        Assert.Equal(1.75, nodeById[crack.FaceAQuarterNodeId].X, 9);
        Assert.Equal(1.75, nodeById[crack.FaceBQuarterNodeId].X, 9);
        Assert.Equal(1.0, Math.Abs(nodeById[crack.FaceACornerNodeId].X - 2.0), 9);

        // Solve under remote tension: the faces must OPEN (positive K1) and the
        // duplicated face nodes must move apart
        foreach (var n in model.FeNodes)
            if (Math.Abs(n.Y) < 1e-9) n.Bc = Fixed(Math.Abs(n.X) < 1e-9, true);
        LoadQ8EdgeY(model, 4, 1000);

        var r = Solver.Solve(model);
        var sif = Assert.Single(r.CrackSifs);
        Assert.True(sif.K1 > 0, $"K1 = {sif.K1} should be positive (opening)");
        var dA = r.Displacements.Single(d => d.NodeId == crack.FaceAQuarterNodeId);
        var dB = r.Displacements.Single(d => d.NodeId == crack.FaceBQuarterNodeId);
        Assert.NotEqual(dA.Dy, dB.Dy, 9); // faces separated
    }

    [Fact]
    public void Crack_EdgeCrackedPlate_MatchesHandbookK1()
    {
        // SENT: W=10, a=3 (a/W=0.3), remote tension applied as consistent tractions
        // (total = sigma * W * t). H/W = 1.5 per side (the handbook polynomial assumes
        // a long strip); tip element L = 0.25 -> L/a = 0.083.
        // Handbook (Gross & Brown / Tada): K1 = Y * sigma * sqrt(pi*a),
        // Y = 1.122 - 0.231r + 10.55r^2 - 21.71r^3 + 30.382r^4, r = a/W.
        //
        // Accuracy: the primary K is now the domain INTERACTION INTEGRAL
        // (InteractionIntegral.cs) - measured -0.1% on this benchmark (1%
        // acceptance). The displacement-correlation value is retained as
        // K1Dct/K2Dct for cross-checking; on this setup DCT measures ~+5%
        // (the known bias of non-collapsed rectangular quarter-point DCT).
        const double W = 10, H = 15, a = 3, sigma = 100, t = 0.1, E = 1e7, nu = 0.3;
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -H), (W, -H), (W, H), (0.0, H) }, E, nu, t);
        Mesher.MeshMembrane(model, s, 40, 120, quadratic: true); // dx = dy = 0.25 (square tip elements)

        // Crack along y=0 from the free edge x=0 to the tip at x=a
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y) < 1e-9 && n.X <= a + 1e-9)
            .Select(n => n.Id).ToList();
        var cracks = Mesher.CreateCrack(model, pathIds, tipAtStart: false, tipAtEnd: true);
        Assert.Single(cracks);

        // Remote tension on top and bottom edges; minimal rigid-body restraint at
        // far-field nodes that are NOT on the loaded edges (so no load is overwritten)
        LoadQ8EdgeY(model, H, sigma * W * t);
        LoadQ8EdgeY(model, -H, -sigma * W * t);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(true, true);
        model.FeNodes.First(n => Math.Abs(n.X - W) < 1e-9 && Math.Abs(n.Y - H / 2) < 1e-9).Bc = Fixed(true, false);

        var r = Solver.Solve(model);

        double ratio = a / W;
        double y = 1.122 - 0.231 * ratio + 10.55 * ratio * ratio
                   - 21.71 * Math.Pow(ratio, 3) + 30.382 * Math.Pow(ratio, 4);
        double kTarget = y * sigma * Math.Sqrt(Math.PI * a);

        var sif = Assert.Single(r.CrackSifs);
        Assert.True(Math.Abs(sif.K1 - kTarget) / kTarget < 0.01,
            $"K1 = {sif.K1:G5} vs handbook {kTarget:G5} ({(sif.K1 / kTarget - 1) * 100:F1}% off)");
        Assert.True(Math.Abs(sif.K2) < 0.02 * kTarget, $"K2 = {sif.K2:G5} should be ~0 for pure mode I");
    }

    [Fact]
    public void Crack_CentreCrackedPlate_MatchesHandbookK1_BothTips()
    {
        // CCT: plate width 2W = 20, half-crack a = 4 (a/W = 0.4), height 2H = 40,
        // remote tension. Handbook (Feddersen): K1 = sigma * sqrt(pi*a * sec(pi*a/(2W))).
        // Interaction-integral accuracy: -0.1% measured (1% acceptance).
        // The DCT cross-check value on this setup is ~+6%.
        const double W2 = 20, H = 20, aHalf = 4, sigma = 100, t = 0.1;
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, -H), (W2, -H), (W2, H), (0.0, H) }, 1e7, 0.3, t);
        Mesher.MeshMembrane(model, s, 40, 80, quadratic: true); // dx = dy = 0.5

        // Internal crack along y=0 from x=6 to x=14 (centred), tips at BOTH ends
        var pathIds = model.FeNodes
            .Where(n => Math.Abs(n.Y) < 1e-9 && n.X >= 6 - 1e-9 && n.X <= 14 + 1e-9)
            .Select(n => n.Id).ToList();
        var cracks = Mesher.CreateCrack(model, pathIds, tipAtStart: true, tipAtEnd: true);
        Assert.Equal(2, cracks.Count);

        LoadQ8EdgeY(model, H, sigma * W2 * t);
        LoadQ8EdgeY(model, -H, -sigma * W2 * t);
        model.FeNodes.First(n => Math.Abs(n.X) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(true, true);
        model.FeNodes.First(n => Math.Abs(n.X - W2) < 1e-9 && Math.Abs(n.Y) < 1e-9).Bc = Fixed(false, true);

        var r = Solver.Solve(model);

        double kTarget = sigma * Math.Sqrt(Math.PI * aHalf / Math.Cos(Math.PI * aHalf / W2));

        Assert.Equal(2, r.CrackSifs.Count);
        foreach (var sif in r.CrackSifs)
        {
            Assert.True(Math.Abs(sif.K1 - kTarget) / kTarget < 0.01,
                $"K1 = {sif.K1:G5} vs handbook {kTarget:G5} ({(sif.K1 / kTarget - 1) * 100:F1}% off)");
            Assert.True(Math.Abs(sif.K2) < 0.02 * kTarget, $"K2 = {sif.K2:G5} should be ~0");
        }
        // Symmetric problem: both tips equal
        Assert.Equal(r.CrackSifs[0].K1, r.CrackSifs[1].K1, 1);
    }

    [Fact]
    public void DetachBars_DuplicatesSharedNodesAndKeepsChainConnected()
    {
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 2, 2);
        int meshNodes = model.FeNodes.Count;

        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - 10) < 1e-9).OrderBy(n => n.X).Select(n => n.Id).ToList();
        var bars = Mesher.CreateBarsAlongNodes(model, topIds, 1e7, 0.1); // 2 bars sharing the middle node
        var topNode = model.FeNodes.First(n => n.Id == topIds[1]);
        topNode.Bc = Load(50, 0); // BC on a node about to be detached: stays with the membrane node

        int dups = Mesher.DetachBars(model, bars.Select(b => b.Id).ToList());

        Assert.Equal(3, dups);
        Assert.Equal(meshNodes + 3, model.FeNodes.Count);
        var nodeById = model.FeNodes.ToDictionary(n => n.Id);
        // Bars no longer reference any membrane node
        var membraneNodeIds = model.FeElements.SelectMany(el => el.NodeIds).ToHashSet();
        foreach (var b in bars)
        {
            Assert.DoesNotContain(b.FeNodeId1, membraneNodeIds);
            Assert.DoesNotContain(b.FeNodeId2, membraneNodeIds);
        }
        // The chain still shares its middle node (one duplicate, used by both bars)
        Assert.Equal(bars[0].FeNodeId2, bars[1].FeNodeId1);
        // Duplicates are coincident, free of surfaces and BCs; original keeps its load
        foreach (var b in bars)
            foreach (var id in new[] { b.FeNodeId1, b.FeNodeId2 })
            {
                var dup = nodeById[id];
                Assert.Null(dup.MembraneId);
                Assert.Null(dup.Bc);
                Assert.Contains(model.FeNodes, n => n.Id != id && Math.Abs(n.X - dup.X) < 1e-12 && Math.Abs(n.Y - dup.Y) < 1e-12);
            }
        Assert.NotNull(topNode.Bc); // membrane node kept the load

        // Unconnected detached bars are a mechanism: the orphan diagnostic names them
        foreach (var n in model.FeNodes)
            if (n.MembraneId is not null && n.X < 1e-9) n.Bc = Fixed(true, true);
        var ex = Assert.Throws<InvalidOperationException>(() => Solver.Solve(model));
        Assert.Contains("no stiffness", ex.Message);
    }

    [Fact]
    public void DetachedBar_FastenedBySprings_TransfersLoadIntoSkin()
    {
        // The full stringer idealisation: skin plate clamped at the left, a detached
        // bar along the top edge fastened to the skin by a spring at EVERY bar node,
        // axial load applied to the bar's free-end node. All load must flow
        // bar -> springs -> skin -> support, and the bar must carry force.
        var model = new FeModel();
        var s = Mesher.AddSurface(model, new[] { (0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0) }, 1e7, 0.3, 0.1);
        Mesher.MeshMembrane(model, s, 4, 4);

        var topIds = model.FeNodes.Where(n => Math.Abs(n.Y - 10) < 1e-9).OrderBy(n => n.X).Select(n => n.Id).ToList();
        var bars = Mesher.CreateBarsAlongNodes(model, topIds, 1e7, 0.1);
        Mesher.DetachBars(model, bars.Select(b => b.Id).ToList());

        // Fasteners: a spring at every coincident pair along the top edge
        Mesher.AddSpringPointGrid(model, 0, 10, 10, 0, topIds.Count, 1);
        var created = Mesher.CreateSpringsAtSpringPoints(model, 1e-6, 1e6);
        Assert.Equal(topIds.Count, created.Created);

        foreach (var n in model.FeNodes)
            if (n.MembraneId is not null && n.X < 1e-9) n.Bc = Fixed(true, true); // clamp skin
        // Load the bar's free right-end node (a detached node at (10, 10))
        var barEnd = model.FeNodes.Single(n => n.MembraneId is null &&
            Math.Abs(n.X - 10) < 1e-9 && Math.Abs(n.Y - 10) < 1e-9);
        barEnd.Bc = Load(1000, 0);

        var r = Solver.Solve(model);

        Assert.Equal(-1000, r.Reactions.Sum(x => x.Rx), 4);            // full transfer to the skin
        Assert.True(Math.Abs(r.SpringLoads.Sum(sl => sl.Fx)) > 0);     // springs carry shear
        double sumSpringFx = r.SpringLoads.Sum(sl => Math.Abs(sl.Fx));
        Assert.True(sumSpringFx >= 999, $"springs transfer the load (sum |Fx| = {sumSpringFx:G5})");
        // The bar next to the loaded end carries most of the applied force
        var endBar = r.BarLoads.OrderByDescending(b => Math.Abs(b.P)).First();
        Assert.True(Math.Abs(endBar.P) > 500, $"end bar P = {endBar.P:G5}");
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
