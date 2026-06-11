using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using FeaCore;
using Microsoft.Win32;
using SkiaSharp;
using SkiaSharp.Views.Desktop;

namespace FeaApp;

public partial class MainWindow : Window
{
    private enum Mode { Select, PickCorners, PickEdge }
    private enum Target { Surfaces, Points, Nodes, Elements, Bars }

    private FeModel _model = new();
    private SolveResult? _result;
    private readonly SceneRenderer _renderer = new();
    private string? _filePath;

    // View transform: screen = world * scale + offset (device px). World is Y-down.
    private double _scale = 5.0;
    private SKPoint _offset = new(60, 60);
    private bool _pendingFit;

    // Interaction state
    private Mode _mode = Mode.Select;
    private Target _target = Target.Surfaces;
    private Point _mouseDownPos;
    private bool _leftDown, _panning;
    private Point _lastMouse;
    private readonly List<(double X, double Y)> _pickedCorners = new();

    // Undo (model JSON snapshots, newest last)
    private readonly List<string> _undo = new();
    private const int UndoLimit = 30;

    public MainWindow()
    {
        InitializeComponent();
        PreviewKeyDown += Window_PreviewKeyDown;
        var args = Environment.GetCommandLineArgs();
        if (args.Length > 1 && File.Exists(args[1]))
            Loaded += (_, _) => OpenModel(args[1]);
        Loaded += (_, _) => { RefreshTree(); Log("Ready. Geometry > Surface to start, or File > Open."); };
    }

    // ====================== infrastructure ======================

    private void Log(string message)
    {
        TxtMessages.AppendText($"{DateTime.Now:HH:mm:ss}  {message}\n");
        TxtMessages.ScrollToEnd();
    }

    private void Prompt(string text) => TxtPrompt.Text = text;

    private void Snapshot()
    {
        _undo.Add(_model.ToJson());
        if (_undo.Count > UndoLimit) _undo.RemoveAt(0);
    }

    private void Undo()
    {
        if (_undo.Count == 0) { Prompt("Nothing to undo."); return; }
        var json = _undo[^1];
        _undo.RemoveAt(_undo.Count - 1);
        _model = FeModel.FromJson(json);
        _result = null;
        ClearSelection();
        _renderer.SetModel(_model, null);
        RefreshTree();
        Canvas.InvalidateVisual();
        Log("Undo.");
    }

    private void ModelChanged(bool invalidateResults = true)
    {
        if (invalidateResults) { _result = null; }
        _renderer.SetModel(_model, _result);
        RefreshTree();
        Canvas.InvalidateVisual();
    }

    private void ClearSelection()
    {
        _renderer.SelectedSurfaces.Clear();
        _renderer.SelectedPoints.Clear();
        _renderer.SelectedNodes.Clear();
        _renderer.SelectedElements.Clear();
        _renderer.SelectedBars.Clear();
        UpdateSelInfo();
    }

    private void UpdateSelInfo()
    {
        // Single surface / point: show associated geometry and mesh detail (FEMAP-style entity info)
        if (_renderer.SelectedSurfaces.Count == 1 && _renderer.SelectedPoints.Count == 0 &&
            _renderer.SelectedNodes.Count == 0 && _renderer.SelectedElements.Count == 0 &&
            _renderer.SelectedBars.Count == 0)
        {
            var s = _model.Membranes.FirstOrDefault(m => m.Id == _renderer.SelectedSurfaces.First());
            if (s is not null) { TxtSelInfo.Text = "Selected: " + DescribeSurface(s); return; }
        }
        if (_renderer.SelectedPoints.Count == 1)
        {
            var g = _model.Nodes.FirstOrDefault(n => n.Id == _renderer.SelectedPoints.First());
            if (g is not null)
            {
                var used = _model.Membranes.Where(m => m.NodeIds.Contains(g.Id)).Select(m => $"Surface {m.Id}").ToList();
                TxtSelInfo.Text = $"Selected: Point {g.Id} ({g.X:G6}, {g.Y:G6})" +
                    (used.Count > 0 ? $" - used by {string.Join(", ", used)}" : " - unused");
                return;
            }
        }

        var parts = new List<string>();
        if (_renderer.SelectedSurfaces.Count > 0) parts.Add($"{_renderer.SelectedSurfaces.Count} surface(s)");
        if (_renderer.SelectedPoints.Count > 0) parts.Add($"{_renderer.SelectedPoints.Count} point(s)");
        if (_renderer.SelectedNodes.Count > 0) parts.Add($"{_renderer.SelectedNodes.Count} node(s)");
        if (_renderer.SelectedElements.Count > 0) parts.Add($"{_renderer.SelectedElements.Count} element(s)");
        if (_renderer.SelectedBars.Count > 0) parts.Add($"{_renderer.SelectedBars.Count} bar(s)");
        TxtSelInfo.Text = parts.Count > 0 ? "Selected: " + string.Join(", ", parts) : "";
    }

    private string DescribeSurface(Membrane s)
    {
        string points = string.Join(", ", s.NodeIds);
        string edges = string.Join(", ", s.EdgeRadii.Select((r, i) => r == 0 ? $"E{i + 1} straight" : $"E{i + 1} R={r:G6}"));
        int els = _model.FeElements.Count(e => e.MembraneId == s.Id);
        string divisions = s.MeshM is { } mm && s.MeshN is { } nn ? $" {mm}x{nn}" : "";
        string mesh = els == 0 ? "unmeshed" : $"meshed{divisions} Quad4 membrane ({els} elements)";
        return $"Surface {s.Id} - points {points}; {edges}; {mesh}";
    }

    private void RefreshTree()
    {
        ModelTree.Items.Clear();

        var geo = new TreeViewItem { Header = "Geometry", IsExpanded = true };
        var surfaces = new TreeViewItem { Header = $"Surfaces ({_model.Membranes.Count})", IsExpanded = true };
        var pointById = _model.Nodes.ToDictionary(g => g.Id);
        foreach (var s in _model.Membranes)
        {
            int els = _model.FeElements.Count(e => e.MembraneId == s.Id);
            var item = new TreeViewItem
            {
                Header = $"Surface {s.Id}" + (els > 0 ? "  [meshed]" : "  [unmeshed]"),
                Tag = s.Id
            };

            // Associated geometry: corner points and edges (FEMAP-style detail)
            var ptsNode = new TreeViewItem { Header = "Points" };
            foreach (var pid in s.NodeIds)
            {
                var g = pointById.GetValueOrDefault(pid);
                ptsNode.Items.Add(new TreeViewItem
                {
                    Header = g is null ? $"Point {pid} (missing!)" : $"Point {pid}  ({g.X:G6}, {g.Y:G6})",
                    Tag = ("point", pid)
                });
            }
            item.Items.Add(ptsNode);

            var edgesNode = new TreeViewItem { Header = "Edges" };
            for (int e = 0; e < 4 && e < s.EdgeRadii.Count; e++)
            {
                int a = s.NodeIds[e], b = s.NodeIds[(e + 1) % 4];
                double r = s.EdgeRadii[e];
                edgesNode.Items.Add(new TreeViewItem
                {
                    Header = $"Edge {e + 1}  ({a} → {b})  " + (r == 0 ? "straight" : $"R = {r:G6}")
                });
            }
            item.Items.Add(edgesNode);

            // Mesh association: element type + divisions, not individual element numbers
            string meshDiv = s.MeshM is { } mm && s.MeshN is { } nn ? $", {mm} x {nn}" : "";
            item.Items.Add(new TreeViewItem
            {
                Header = els == 0 ? "Mesh: (none)" : $"Mesh: Quad4 membrane{meshDiv} ({els} elements)"
            });

            surfaces.Items.Add(item);
        }
        geo.Items.Add(surfaces);
        ModelTree.Items.Add(geo);

        var fem = new TreeViewItem { Header = "Model", IsExpanded = true };
        fem.Items.Add(new TreeViewItem { Header = $"Nodes ({_model.FeNodes.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Elements ({_model.FeElements.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Bars ({_model.FeBars.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Springs ({_model.FeSprings.Count})" });
        int loads = _model.FeNodes.Count(n => n.Bc?.Type == "load");
        int constraints = _model.FeNodes.Count(n => n.Bc?.Type is "fixed" or "enforced");
        fem.Items.Add(new TreeViewItem { Header = $"Loads ({loads})" });
        fem.Items.Add(new TreeViewItem { Header = $"Constraints ({constraints})" });
        ModelTree.Items.Add(fem);

        var results = new TreeViewItem { Header = "Results", IsExpanded = true };
        results.Items.Add(new TreeViewItem
        {
            Header = _result is null ? "(none - run Analyze > Solve)" :
                $"Static: {_result.DofCount} DOF, {_result.Elapsed.TotalMilliseconds:F0} ms"
        });
        ModelTree.Items.Add(results);
    }

    private void ModelTree_SelectedItemChanged(object sender, RoutedPropertyChangedEventArgs<object> e)
    {
        if (e.NewValue is TreeViewItem { Tag: int surfaceId })
        {
            ClearSelection();
            _renderer.SelectedSurfaces.Add(surfaceId);
        }
        else if (e.NewValue is TreeViewItem { Tag: ValueTuple<string, int> tag } && tag.Item1 == "point")
        {
            ClearSelection();
            _renderer.SelectedPoints.Add(tag.Item2);
        }
        else return;
        _renderer.Rebuild();
        UpdateSelInfo();
        Canvas.InvalidateVisual();
    }

    // ====================== file ======================

    private void MenuNew_Click(object sender, RoutedEventArgs e)
    {
        Snapshot();
        _model = new FeModel();
        _result = null;
        _filePath = null;
        ClearSelection();
        ModelChanged();
        Log("New model.");
    }

    private void MenuOpen_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog { Filter = "FEA model (*.json)|*.json|All files (*.*)|*.*" };
        if (dlg.ShowDialog(this) == true) OpenModel(dlg.FileName);
    }

    private void OpenModel(string path)
    {
        try
        {
            _model = FeModel.Load(path);
            _result = null;
            _filePath = path;
            ClearSelection();
            _renderer.SetModel(_model, null);
            RefreshTree();
            _pendingFit = true;
            Canvas.InvalidateVisual();
            Log($"Opened {Path.GetFileName(path)}: {_model.Membranes.Count} surfaces, " +
                $"{_model.FeNodes.Count} nodes, {_model.FeElements.Count} elements, " +
                $"{_model.FeSprings.Count} springs, {_model.FeBars.Count} bars.");
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Failed to load model", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void MenuSave_Click(object sender, RoutedEventArgs e)
    {
        if (_filePath is null) { MenuSaveAs_Click(sender, e); return; }
        _model.Save(_filePath);
        Log($"Saved {Path.GetFileName(_filePath)}.");
    }

    private void MenuSaveAs_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new SaveFileDialog { Filter = "FEA model (*.json)|*.json", FileName = "model.json" };
        if (dlg.ShowDialog(this) != true) return;
        _filePath = dlg.FileName;
        _model.Save(_filePath);
        Log($"Saved {Path.GetFileName(_filePath)}.");
    }

    private void MenuExit_Click(object sender, RoutedEventArgs e) => Close();

    // ====================== geometry ======================

    private void MenuSurfaceByCorners_Click(object sender, RoutedEventArgs e)
    {
        var d = new FormDialog(this, "Surface by Corner Points")
            .AddField("x1", "Corner 1  X", 0).AddField("y1", "Corner 1  Y", 0)
            .AddField("x2", "Corner 2  X", 100).AddField("y2", "Corner 2  Y", 0)
            .AddField("x3", "Corner 3  X", 100).AddField("y3", "Corner 3  Y", 50)
            .AddField("x4", "Corner 4  X", 0).AddField("y4", "Corner 4  Y", 50)
            .AddField("E", "Modulus E", 10.5e6).AddField("nu", "Poisson nu", 0.33).AddField("t", "Thickness t", 0.05);
        if (!d.Run()) return;
        Snapshot();
        var s = Mesher.AddSurface(_model,
            new[] { (d.Num("x1"), d.Num("y1")), (d.Num("x2"), d.Num("y2")), (d.Num("x3"), d.Num("y3")), (d.Num("x4"), d.Num("y4")) },
            d.Num("E"), d.Num("nu"), d.Num("t"));
        ModelChanged(invalidateResults: false);
        FitView();
        Log($"Surface {s.Id} created.");
    }

    private void MenuSurfacePick_Click(object sender, RoutedEventArgs e)
    {
        _mode = Mode.PickCorners;
        _pickedCorners.Clear();
        Prompt("Pick corner 1 of 4 (Esc to cancel). Order corners around the boundary.");
    }

    private void MenuEdgeRadius_Click(object sender, RoutedEventArgs e)
    {
        _mode = Mode.PickEdge;
        Prompt("Pick a surface edge to set its radius (Esc to cancel).");
    }

    private void MenuDeleteSurfaces_Click(object sender, RoutedEventArgs e) => DeleteSelected(surfacesOnly: true);

    private void MenuEditPoint_Click(object sender, RoutedEventArgs e)
    {
        if (_renderer.SelectedPoints.Count != 1)
        {
            Prompt("Select exactly one point first (Select: Points, click a cyan square).");
            return;
        }
        int pid = _renderer.SelectedPoints.First();
        var g = _model.Nodes.FirstOrDefault(n => n.Id == pid);
        if (g is null) return;

        var meshedUsers = _model.Membranes
            .Where(m => m.NodeIds.Contains(pid) && _model.FeElements.Any(el => el.MembraneId == m.Id))
            .Select(m => m.Id).ToList();
        var d = new FormDialog(this, $"Edit Point {pid}")
            .AddField("x", "X", g.X)
            .AddField("y", "Y", g.Y);
        if (meshedUsers.Count > 0)
            d.AddNote($"Surface(s) {string.Join(", ", meshedUsers)} are meshed and will be re-meshed to follow the new geometry.");
        if (!d.Run()) return;
        Snapshot();
        string summary = Mesher.MoveGeometryPoint(_model, pid, d.Num("x"), d.Num("y"));
        ModelChanged();
        Log(summary);
    }

    private void MenuDeleteElements_Click(object sender, RoutedEventArgs e)
    {
        if (_renderer.SelectedElements.Count == 0)
        {
            Prompt("Select element(s) first (Select: Elements, click or box).");
            return;
        }
        DeleteSelected();
    }

    // ====================== mesh ======================

    private List<Membrane> SelectedSurfacesOrAll()
    {
        var sel = _model.Membranes.Where(s => _renderer.SelectedSurfaces.Contains(s.Id)).ToList();
        if (sel.Count == 0 && _model.Membranes.Count == 1) sel = _model.Membranes.ToList();
        return sel;
    }

    private void MenuMesh_Click(object sender, RoutedEventArgs e)
    {
        var surfaces = SelectedSurfacesOrAll();
        if (surfaces.Count == 0) { Prompt("Select surface(s) first (Select: Surfaces, click or box)."); return; }
        var d = new FormDialog(this, $"Mesh {surfaces.Count} Surface(s)")
            .AddField("m", "Divisions along edge 1-2 (M)", 8)
            .AddField("n", "Divisions along edge 2-3 (N)", 4);
        if (!d.Run()) return;
        Snapshot();
        int m = (int)d.Num("m"), n = (int)d.Num("n");
        foreach (var s in surfaces)
        {
            var (nodes, els) = Mesher.MeshMembrane(_model, s, m, n);
            Log($"Surface {s.Id} meshed {m}x{n}: {nodes} nodes, {els} elements.");
        }
        ModelChanged();
    }

    private void MenuClearMesh_Click(object sender, RoutedEventArgs e)
    {
        var surfaces = SelectedSurfacesOrAll();
        if (surfaces.Count == 0) { Prompt("Select surface(s) first."); return; }
        Snapshot();
        foreach (var s in surfaces) Mesher.ClearMesh(_model, s.Id);
        ModelChanged();
        Log($"Mesh cleared on {surfaces.Count} surface(s).");
    }

    // ====================== model (BCs, bars, springs, props) ======================

    private List<FeNode> SelectedFeNodes() =>
        _model.FeNodes.Where(n => _renderer.SelectedNodes.Contains(n.Id)).ToList();

    private void MenuConstraint_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count == 0) { Prompt("Select node(s) first (Select: Nodes, click or box)."); return; }
        var d = new FormDialog(this, $"Constraint on {nodes.Count} Node(s)")
            .AddCheck("fx", "Fix TX (X translation)", true)
            .AddCheck("fy", "Fix TY (Y translation)", true);
        if (!d.Run()) return;
        if (!d.Check("fx") && !d.Check("fy")) return;
        Snapshot();
        foreach (var n in nodes)
            n.Bc = new BoundaryCondition { Type = "fixed", Value = new BcValue { FixX = d.Check("fx"), FixY = d.Check("fy") } };
        ModelChanged();
        Log($"Constraint applied to {nodes.Count} node(s).");
    }

    private void MenuLoad_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count == 0) { Prompt("Select node(s) first (Select: Nodes, click or box)."); return; }
        var d = new FormDialog(this, $"Nodal Load on {nodes.Count} Node(s)")
            .AddField("fx", "Force FX (per node)", 0)
            .AddField("fy", "Force FY (per node)", 0);
        if (!d.Run()) return;
        Snapshot();
        foreach (var n in nodes)
            n.Bc = new BoundaryCondition { Type = "load", Value = new BcValue { Fx = d.Num("fx"), Fy = d.Num("fy") } };
        ModelChanged();
        Log($"Load FX={d.Num("fx")}, FY={d.Num("fy")} applied to {nodes.Count} node(s).");
    }

    private void MenuEnforced_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count == 0) { Prompt("Select node(s) first."); return; }
        var d = new FormDialog(this, $"Enforced Displacement on {nodes.Count} Node(s)")
            .AddField("dx", "DX (blank = free)", "")
            .AddField("dy", "DY (blank = free)", "")
            .AddNote("Leave a field blank to leave that direction free.");
        if (!d.Run()) return;
        var dx = d.NumOrNull("dx");
        var dy = d.NumOrNull("dy");
        if (dx is null && dy is null) return;
        Snapshot();
        foreach (var n in nodes)
            n.Bc = new BoundaryCondition { Type = "enforced", Value = new BcValue { Dx = dx, Dy = dy } };
        ModelChanged();
        Log($"Enforced displacement applied to {nodes.Count} node(s).");
    }

    private void MenuClearBc_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count == 0) { Prompt("Select node(s) first."); return; }
        Snapshot();
        foreach (var n in nodes) n.Bc = null;
        ModelChanged();
        Log($"BCs removed from {nodes.Count} node(s).");
    }

    private void MenuBars_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count < 2) { Prompt("Select 2+ nodes first (Select: Nodes, box-select a line of nodes)."); return; }
        var d = new FormDialog(this, $"Bars Along {nodes.Count} Node(s)")
            .AddField("E", "Modulus E", 10.5e6)
            .AddField("A", "Area A", 0.05)
            .AddNote("Nodes are chained along their dominant direction; N nodes give N-1 bars.");
        if (!d.Run()) return;
        Snapshot();
        var bars = Mesher.CreateBarsAlongNodes(_model, nodes.Select(n => n.Id).ToList(), d.Num("E"), d.Num("A"));
        ModelChanged();
        Log($"{bars.Count} bar(s) created.");
    }

    private void MenuSpring_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count != 2) { Prompt("Select exactly 2 nodes first."); return; }
        var d = new FormDialog(this, "Spring (XY-decoupled)")
            .AddField("k", "Stiffness k (X and Y)", 5e4)
            .AddNote("Independent k in X and Y (fastener idealisation), not axial.");
        if (!d.Run()) return;
        Snapshot();
        int nextId = _model.FeSprings.Count == 0 ? 1 : _model.FeSprings.Max(s => s.Id) + 1;
        _model.FeSprings.Add(new FeSpring { Id = nextId, FeNodeId1 = nodes[0].Id, FeNodeId2 = nodes[1].Id, Stiffness = d.Num("k") });
        ModelChanged();
        Log($"Spring {nextId} created (k={d.Num("k")}).");
    }

    private void MenuSurfaceProps_Click(object sender, RoutedEventArgs e)
    {
        var surfaces = SelectedSurfacesOrAll();
        if (surfaces.Count == 0) { Prompt("Select surface(s) first."); return; }
        var s0 = surfaces[0];
        var d = new FormDialog(this, $"Properties for {surfaces.Count} Surface(s)")
            .AddField("E", "Modulus E", s0.MaterialE)
            .AddField("nu", "Poisson nu", s0.MaterialNu)
            .AddField("t", "Thickness t", s0.MaterialT);
        if (!d.Run()) return;
        Snapshot();
        foreach (var s in surfaces)
        {
            s.MaterialE = d.Num("E");
            s.MaterialNu = d.Num("nu");
            s.MaterialT = d.Num("t");
        }
        ModelChanged();
        Log($"Properties updated on {surfaces.Count} surface(s).");
    }

    private void DeleteSelected(bool surfacesOnly = false)
    {
        if (_renderer.SelectedSurfaces.Count > 0)
        {
            Snapshot();
            int count = _renderer.SelectedSurfaces.Count;
            foreach (var id in _renderer.SelectedSurfaces.ToList()) Mesher.DeleteSurface(_model, id);
            ClearSelection();
            ModelChanged();
            Log($"{count} surface(s) deleted.");
            return;
        }
        if (surfacesOnly) { Prompt("Select surface(s) first."); return; }
        if (_renderer.SelectedBars.Count > 0)
        {
            Snapshot();
            int count = _renderer.SelectedBars.Count;
            _model.FeBars.RemoveAll(b => _renderer.SelectedBars.Contains(b.Id));
            ClearSelection();
            ModelChanged();
            Log($"{count} bar(s) deleted.");
            return;
        }
        if (_renderer.SelectedElements.Count > 0)
        {
            Snapshot();
            var (els, orphans) = Mesher.DeleteElements(_model, _renderer.SelectedElements);
            ClearSelection();
            ModelChanged();
            Log($"{els} element(s) deleted" + (orphans > 0 ? $" ({orphans} unreferenced node(s) removed with them)." : "."));
        }
    }

    // ====================== analyze / view ======================

    private async void BtnSolve_Click(object sender, RoutedEventArgs e)
    {
        if (_model.FeNodes.Count == 0) { Prompt("Nothing to solve - mesh a surface first."); return; }
        BtnSolve.IsEnabled = false;
        Prompt("Solving…");
        try
        {
            var model = _model;
            _result = await Task.Run(() => Solver.Solve(model));
            _renderer.SetModel(_model, _result);
            RefreshTree();
            string msg = $"Analysis complete: {_result.DofCount} DOF, {_result.NonZeros} non-zeros, " +
                $"{_result.ConstrainedDofs} constrained DOFs, {_result.Elapsed.TotalMilliseconds:F0} ms. " +
                $"Max |d| = {_result.Displacements.Max(d => Math.Max(Math.Abs(d.Dx), Math.Abs(d.Dy))):E3}.";
            Prompt(msg);
            Log(msg);
            if (CmbView.SelectedIndex == 0) CmbView.SelectedIndex = 1; // default to Von Mises after solve
        }
        catch (Exception ex)
        {
            Prompt("Solve failed.");
            Log("Solve failed: " + ex.Message);
            MessageBox.Show(this, ex.Message, "Solve failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            BtnSolve.IsEnabled = true;
            Canvas.InvalidateVisual();
        }
    }

    private void BtnFit_Click(object sender, RoutedEventArgs e) => FitView();
    private void MenuZoomIn_Click(object sender, RoutedEventArgs e) => ZoomBy(1.4);
    private void MenuZoomOut_Click(object sender, RoutedEventArgs e) => ZoomBy(1 / 1.4);

    private void MenuGrid_Click(object sender, RoutedEventArgs e)
    {
        _renderer.ShowGrid = MenuGrid.IsChecked;
        Canvas.InvalidateVisual();
    }

    private void MenuLabels_Click(object sender, RoutedEventArgs e)
    {
        _renderer.ShowLabels = MenuLabels.IsChecked;
        Canvas.InvalidateVisual();
    }

    private void CmbTarget_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        _target = (Target)CmbTarget.SelectedIndex;
    }

    private void CmbView_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_renderer is null) return;
        _renderer.StressView = CmbView.SelectedIndex switch
        {
            1 => StressView.VonMises,
            2 => StressView.Sxx,
            3 => StressView.Syy,
            4 => StressView.Sxy,
            _ => StressView.None
        };
        Canvas?.InvalidateVisual();
    }

    private void ChkDeformed_Changed(object sender, RoutedEventArgs e)
    {
        _renderer.ShowDeformed = ChkDeformed.IsChecked == true;
        Canvas.InvalidateVisual();
    }

    // ====================== keyboard ======================

    private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.OriginalSource is TextBox) return; // let text fields work
        switch (e.Key)
        {
            case Key.Escape:
                if (_mode != Mode.Select) { _mode = Mode.Select; _pickedCorners.Clear(); Prompt("Cancelled."); }
                else { ClearSelection(); _renderer.Rebuild(); Canvas.InvalidateVisual(); }
                e.Handled = true;
                break;
            case Key.Delete:
                DeleteSelected();
                e.Handled = true;
                break;
            case Key.F:
                FitView();
                e.Handled = true;
                break;
            case Key.F5:
                BtnSolve_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;
            case Key.Z when Keyboard.Modifiers == ModifierKeys.Control:
                Undo();
                e.Handled = true;
                break;
            case Key.O when Keyboard.Modifiers == ModifierKeys.Control:
                MenuOpen_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;
            case Key.S when Keyboard.Modifiers == ModifierKeys.Control:
                MenuSave_Click(this, new RoutedEventArgs());
                e.Handled = true;
                break;
        }
    }

    // ====================== view transform ======================

    private void FitView()
    {
        double sw = Canvas.CanvasSize.Width, sh = Canvas.CanvasSize.Height;
        if (sw <= 0 || sh <= 0) { _pendingFit = true; Canvas.InvalidateVisual(); return; }
        FitToRect(sw, sh);
        Canvas.InvalidateVisual();
    }

    private void FitToRect(double sw, double sh)
    {
        double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
        double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
        foreach (var n in _model.FeNodes) { minX = Math.Min(minX, n.X); maxX = Math.Max(maxX, n.X); minY = Math.Min(minY, n.Y); maxY = Math.Max(maxY, n.Y); }
        foreach (var n in _model.Nodes) { minX = Math.Min(minX, n.X); maxX = Math.Max(maxX, n.X); minY = Math.Min(minY, n.Y); maxY = Math.Max(maxY, n.Y); }
        if (!double.IsFinite(minX)) return;

        double w = Math.Max(maxX - minX, 1e-6), h = Math.Max(maxY - minY, 1e-6);
        _scale = 0.85 * Math.Min(sw / w, sh / h);
        _offset = new SKPoint(
            (float)(sw / 2 - (minX + maxX) / 2 * _scale),
            (float)(sh / 2 - (minY + maxY) / 2 * _scale));
    }

    private void ZoomBy(double factor)
    {
        double sw = Canvas.CanvasSize.Width, sh = Canvas.CanvasSize.Height;
        double newScale = Math.Clamp(_scale * factor, 1e-3, 1e5);
        _offset = new SKPoint(
            (float)(sw / 2 - (sw / 2 - _offset.X) * (newScale / _scale)),
            (float)(sh / 2 - (sh / 2 - _offset.Y) * (newScale / _scale)));
        _scale = newScale;
        Canvas.InvalidateVisual();
    }

    private SKPoint DevicePoint(Point p)
    {
        double dpi = Canvas.CanvasSize.Width / Math.Max(Canvas.ActualWidth, 1);
        return new SKPoint((float)(p.X * dpi), (float)(p.Y * dpi));
    }

    private (double X, double Y) WorldPoint(Point p)
    {
        var d = DevicePoint(p);
        return ((d.X - _offset.X) / _scale, (d.Y - _offset.Y) / _scale);
    }

    // ====================== canvas events ======================

    private void Canvas_PaintSurface(object sender, SKPaintSurfaceEventArgs e)
    {
        if (_pendingFit && e.Info.Width > 0)
        {
            _pendingFit = false;
            FitToRect(e.Info.Width, e.Info.Height);
        }
        _renderer.Render(e.Surface.Canvas, (float)_scale, _offset, e.Info.Width, e.Info.Height);
    }

    private void Canvas_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        var p = DevicePoint(e.GetPosition(Canvas));
        double factor = e.Delta > 0 ? 1.1 : 1 / 1.1;
        double newScale = Math.Clamp(_scale * factor, 1e-3, 1e5);
        _offset = new SKPoint(
            (float)(p.X - (p.X - _offset.X) * (newScale / _scale)),
            (float)(p.Y - (p.Y - _offset.Y) * (newScale / _scale)));
        _scale = newScale;
        Canvas.InvalidateVisual();
    }

    private void Canvas_MouseDown(object sender, MouseButtonEventArgs e)
    {
        Canvas.Focus();
        if (e.ChangedButton is MouseButton.Middle or MouseButton.Right)
        {
            _panning = true;
            _lastMouse = e.GetPosition(Canvas);
            Canvas.CaptureMouse();
            return;
        }
        if (e.ChangedButton != MouseButton.Left) return;

        var pos = e.GetPosition(Canvas);
        var (wx, wy) = WorldPoint(pos);

        if (_mode == Mode.PickCorners)
        {
            _pickedCorners.Add((wx, wy));
            Log($"Corner {_pickedCorners.Count}: ({wx:F2}, {wy:F2})");
            if (_pickedCorners.Count == 4)
            {
                _mode = Mode.Select;
                var d = new FormDialog(this, "New Surface Properties")
                    .AddField("E", "Modulus E", 10.5e6).AddField("nu", "Poisson nu", 0.33).AddField("t", "Thickness t", 0.05);
                if (d.Run())
                {
                    Snapshot();
                    var s = Mesher.AddSurface(_model, _pickedCorners.ToArray(), d.Num("E"), d.Num("nu"), d.Num("t"));
                    ModelChanged(invalidateResults: false);
                    Log($"Surface {s.Id} created.");
                }
                _pickedCorners.Clear();
                Prompt("Ready.");
            }
            else Prompt($"Pick corner {_pickedCorners.Count + 1} of 4 (Esc to cancel).");
            Canvas.InvalidateVisual();
            return;
        }

        if (_mode == Mode.PickEdge)
        {
            var hit = PickSurfaceEdge(wx, wy, 8 / _scale);
            if (hit is { } edge)
            {
                _mode = Mode.Select;
                var s = edge.surface;
                var d = new FormDialog(this, $"Edge {edge.edgeIndex + 1} Radius - Surface {s.Id}")
                    .AddField("r", "Radius (+ convex / - concave, 0 = straight)", s.EdgeRadii[edge.edgeIndex])
                    .AddNote("Radius is clamped to at least half the chord length. Re-mesh after changing.");
                if (d.Run())
                {
                    Snapshot();
                    s.EdgeRadii[edge.edgeIndex] = d.Num("r");
                    if (_model.FeElements.Any(el => el.MembraneId == s.Id))
                    {
                        Mesher.ClearMesh(_model, s.Id);
                        Log($"Surface {s.Id} edge {edge.edgeIndex + 1} radius = {d.Num("r")}. Mesh cleared - re-mesh the surface.");
                    }
                    else Log($"Surface {s.Id} edge {edge.edgeIndex + 1} radius = {d.Num("r")}.");
                    ModelChanged();
                }
                Prompt("Ready.");
            }
            else Prompt("No edge there - pick closer to a surface edge (Esc to cancel).");
            return;
        }

        // Double-click a geometry point (in Points mode) opens the coordinate editor
        if (e.ClickCount == 2 && _target == Target.Points)
        {
            double tol = 8 / _scale;
            var hit = _model.Nodes
                .Select(g => (g, d2: (g.X - wx) * (g.X - wx) + (g.Y - wy) * (g.Y - wy)))
                .Where(t => t.d2 <= tol * tol)
                .OrderBy(t => t.d2)
                .Select(t => t.g)
                .FirstOrDefault();
            if (hit is not null)
            {
                _renderer.SelectedPoints.Clear();
                _renderer.SelectedPoints.Add(hit.Id);
                _renderer.Rebuild();
                UpdateSelInfo();
                Canvas.InvalidateVisual();
                MenuEditPoint_Click(this, new RoutedEventArgs());
                return;
            }
        }

        // Select mode: remember for click-vs-box decision on mouse-up
        _leftDown = true;
        _mouseDownPos = pos;
        Canvas.CaptureMouse();
    }

    private void Canvas_MouseMove(object sender, MouseEventArgs e)
    {
        var pos = e.GetPosition(Canvas);
        var (wx, wy) = WorldPoint(pos);
        TxtCoords.Text = $"x: {wx:F2}   y: {wy:F2}";

        if (_panning)
        {
            double dpi = Canvas.CanvasSize.Width / Math.Max(Canvas.ActualWidth, 1);
            _offset = new SKPoint(
                _offset.X + (float)((pos.X - _lastMouse.X) * dpi),
                _offset.Y + (float)((pos.Y - _lastMouse.Y) * dpi));
            _lastMouse = pos;
            Canvas.InvalidateVisual();
            return;
        }

        if (_leftDown)
        {
            var a = DevicePoint(_mouseDownPos);
            var b = DevicePoint(pos);
            if (Math.Abs(b.X - a.X) > 4 || Math.Abs(b.Y - a.Y) > 4)
            {
                _renderer.RubberBand = SKRect.Create(
                    Math.Min(a.X, b.X), Math.Min(a.Y, b.Y),
                    Math.Abs(b.X - a.X), Math.Abs(b.Y - a.Y));
                Canvas.InvalidateVisual();
            }
        }
    }

    private void Canvas_MouseUp(object sender, MouseButtonEventArgs e)
    {
        if (_panning && e.ChangedButton is MouseButton.Middle or MouseButton.Right)
        {
            _panning = false;
            Canvas.ReleaseMouseCapture();
            return;
        }
        if (!_leftDown || e.ChangedButton != MouseButton.Left) return;
        _leftDown = false;
        Canvas.ReleaseMouseCapture();

        bool additive = Keyboard.Modifiers.HasFlag(ModifierKeys.Control) || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift);
        var band = _renderer.RubberBand;
        _renderer.RubberBand = null;

        if (band is { } rb && rb.Width > 4 && rb.Height > 4)
        {
            // Box select (world rect)
            double wx0 = (rb.Left - _offset.X) / _scale, wy0 = (rb.Top - _offset.Y) / _scale;
            double wx1 = (rb.Right - _offset.X) / _scale, wy1 = (rb.Bottom - _offset.Y) / _scale;
            BoxSelect(wx0, wy0, wx1, wy1, additive);
        }
        else
        {
            var (wx, wy) = WorldPoint(e.GetPosition(Canvas));
            ClickSelect(wx, wy, additive);
        }
        _renderer.Rebuild();
        UpdateSelInfo();
        Canvas.InvalidateVisual();
    }

    // ====================== selection / picking ======================

    private void BoxSelect(double x0, double y0, double x1, double y1, bool additive)
    {
        bool Inside(double x, double y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
        switch (_target)
        {
            case Target.Points:
                if (!additive) _renderer.SelectedPoints.Clear();
                foreach (var g in _model.Nodes.Where(g => Inside(g.X, g.Y)))
                    _renderer.SelectedPoints.Add(g.Id);
                break;
            case Target.Nodes:
                if (!additive) _renderer.SelectedNodes.Clear();
                foreach (var n in _model.FeNodes.Where(n => Inside(n.X, n.Y)))
                    _renderer.SelectedNodes.Add(n.Id);
                break;
            case Target.Elements:
                if (!additive) _renderer.SelectedElements.Clear();
                var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
                foreach (var el in _model.FeElements)
                    if (el.NodeIds.All(id => nodeById.TryGetValue(id, out var n) && Inside(n.X, n.Y)))
                        _renderer.SelectedElements.Add(el.Id);
                break;
            case Target.Bars:
                if (!additive) _renderer.SelectedBars.Clear();
                var nb = _model.FeNodes.ToDictionary(n => n.Id);
                foreach (var b in _model.FeBars)
                    if (nb.TryGetValue(b.FeNodeId1, out var n1) && nb.TryGetValue(b.FeNodeId2, out var n2)
                        && Inside(n1.X, n1.Y) && Inside(n2.X, n2.Y))
                        _renderer.SelectedBars.Add(b.Id);
                break;
            case Target.Surfaces:
                if (!additive) _renderer.SelectedSurfaces.Clear();
                foreach (var s in _model.Membranes)
                {
                    var corners = s.NodeIds.Select(id => _model.Nodes.FirstOrDefault(g => g.Id == id)).ToList();
                    if (corners.All(c => c is not null && Inside(c.X, c.Y)))
                        _renderer.SelectedSurfaces.Add(s.Id);
                }
                break;
        }
    }

    private void ClickSelect(double wx, double wy, bool additive)
    {
        double tol = 8 / _scale;
        switch (_target)
        {
            case Target.Points:
            {
                var hit = _model.Nodes
                    .Select(g => (g, d2: (g.X - wx) * (g.X - wx) + (g.Y - wy) * (g.Y - wy)))
                    .Where(t => t.d2 <= tol * tol)
                    .OrderBy(t => t.d2)
                    .Select(t => t.g)
                    .FirstOrDefault();
                ApplyPick(_renderer.SelectedPoints, hit?.Id, additive);
                break;
            }
            case Target.Nodes:
            {
                var hit = _model.FeNodes
                    .Select(n => (n, d2: (n.X - wx) * (n.X - wx) + (n.Y - wy) * (n.Y - wy)))
                    .Where(t => t.d2 <= tol * tol)
                    .OrderBy(t => t.d2)
                    .Select(t => t.n)
                    .FirstOrDefault();
                ApplyPick(_renderer.SelectedNodes, hit?.Id, additive);
                break;
            }
            case Target.Elements:
            {
                var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
                FeElement? hit = null;
                foreach (var el in _model.FeElements)
                {
                    if (el.NodeIds.Count != 4) continue;
                    var v = el.NodeIds.Select(id => nodeById.GetValueOrDefault(id)).ToArray();
                    if (v.Any(x => x is null)) continue;
                    if (PointInPolygon(wx, wy, v!)) { hit = el; break; }
                }
                ApplyPick(_renderer.SelectedElements, hit?.Id, additive);
                break;
            }
            case Target.Bars:
            {
                var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
                FeBar? hit = null;
                double best = tol;
                foreach (var b in _model.FeBars)
                {
                    if (!nodeById.TryGetValue(b.FeNodeId1, out var n1) || !nodeById.TryGetValue(b.FeNodeId2, out var n2)) continue;
                    double d = DistToSegment(wx, wy, n1.X, n1.Y, n2.X, n2.Y);
                    if (d < best) { best = d; hit = b; }
                }
                ApplyPick(_renderer.SelectedBars, hit?.Id, additive);
                break;
            }
            case Target.Surfaces:
            {
                Membrane? hit = null;
                foreach (var s in _model.Membranes)
                {
                    var corners = s.NodeIds.Select(id => _model.Nodes.FirstOrDefault(g => g.Id == id)).ToArray();
                    if (corners.Any(c => c is null) || corners.Length < 3) continue;
                    if (PointInPolygonGeo(wx, wy, corners!)) { hit = s; break; }
                }
                ApplyPick(_renderer.SelectedSurfaces, hit?.Id, additive);
                break;
            }
        }
    }

    private static void ApplyPick(HashSet<int> set, int? hitId, bool additive)
    {
        if (!additive) set.Clear();
        if (hitId is { } id)
        {
            if (additive && set.Contains(id)) set.Remove(id);
            else set.Add(id);
        }
    }

    private (Membrane surface, int edgeIndex)? PickSurfaceEdge(double wx, double wy, double tol)
    {
        foreach (var s in _model.Membranes)
        {
            if (s.NodeIds.Count != 4) continue;
            var corners = s.NodeIds.Select(id => _model.Nodes.FirstOrDefault(g => g.Id == id)).ToArray();
            if (corners.Any(c => c is null)) continue;
            for (int e = 0; e < 4; e++)
            {
                var a = corners[e]!; var b = corners[(e + 1) % 4]!;
                double r = e < s.EdgeRadii.Count ? s.EdgeRadii[e] : 0;
                int steps = r == 0 ? 1 : 16;
                for (int k = 0; k < steps; k++)
                {
                    var (x0, y0) = Mesher.ArcPoint(a.X, a.Y, b.X, b.Y, r, (double)k / steps);
                    var (x1, y1) = Mesher.ArcPoint(a.X, a.Y, b.X, b.Y, r, (double)(k + 1) / steps);
                    if (DistToSegment(wx, wy, x0, y0, x1, y1) <= tol) return (s, e);
                }
            }
        }
        return null;
    }

    private static bool PointInPolygon(double x, double y, FeNode[] poly)
    {
        bool inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
        {
            if (poly[i].Y > y != poly[j].Y > y &&
                x < (poly[j].X - poly[i].X) * (y - poly[i].Y) / (poly[j].Y - poly[i].Y) + poly[i].X)
                inside = !inside;
        }
        return inside;
    }

    private static bool PointInPolygonGeo(double x, double y, GeometryNode[] poly)
    {
        bool inside = false;
        for (int i = 0, j = poly.Length - 1; i < poly.Length; j = i++)
        {
            if (poly[i].Y > y != poly[j].Y > y &&
                x < (poly[j].X - poly[i].X) * (y - poly[i].Y) / (poly[j].Y - poly[i].Y) + poly[i].X)
                inside = !inside;
        }
        return inside;
    }

    private static double DistToSegment(double px, double py, double x1, double y1, double x2, double y2)
    {
        double dx = x2 - x1, dy = y2 - y1;
        double len2 = dx * dx + dy * dy;
        double t = len2 < 1e-12 ? 0 : Math.Clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
        double cx = x1 + t * dx, cy = y1 + t * dy;
        return Math.Sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
    }
}
