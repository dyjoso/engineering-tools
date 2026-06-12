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
    private enum Target { Surfaces, Points, Nodes, Elements, Bars, Springs }

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
    private readonly List<(double X, double Y, int? PointId)> _pickedCorners = new();

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
        UpdateSelInfo();
        Canvas.InvalidateVisual();
    }

    private void ClearSelection()
    {
        _renderer.SelectedSurfaces.Clear();
        _renderer.SelectedPoints.Clear();
        _renderer.SelectedNodes.Clear();
        _renderer.SelectedElements.Clear();
        _renderer.SelectedBars.Clear();
        _renderer.SelectedSprings.Clear();
        UpdateSelInfo();
    }

    private void UpdateSelInfo()
    {
        UpdateSelectionData();
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
        if (_renderer.SelectedSprings.Count > 0) parts.Add($"{_renderer.SelectedSprings.Count} spring(s)");
        TxtSelInfo.Text = parts.Count > 0 ? "Selected: " + string.Join(", ", parts) : "";
    }

    /// <summary>Selection Data pane: per-entity values for the current selection.</summary>
    private void UpdateSelectionData()
    {
        const int maxRows = 200;
        var sb = new System.Text.StringBuilder();

        if (_renderer.SelectedElements.Count > 0)
        {
            var stressById = _result?.ElementStresses.ToDictionary(s => s.ElementId);
            var selected = _model.FeElements
                .Where(el => _renderer.SelectedElements.Contains(el.Id))
                .OrderBy(el => el.Id).ToList();
            sb.AppendLine($"Elements ({selected.Count}):");
            if (stressById is not null)
            {
                sb.AppendLine($"{"ID",6} {"SX",12} {"SY",12} {"SXY",12} {"VonMises",12}");
                var shown = selected.Take(maxRows).ToList();
                foreach (var el in shown)
                {
                    if (stressById.TryGetValue(el.Id, out var st))
                        sb.AppendLine($"{el.Id,6} {st.Sxx,12:G5} {st.Syy,12:G5} {st.Sxy,12:G5} {st.SigmaVM,12:G5}");
                    else
                        sb.AppendLine($"{el.Id,6} {"-",12} {"-",12} {"-",12} {"-",12}");
                }
                if (selected.Count > maxRows) sb.AppendLine($"  … {selected.Count - maxRows} more not shown");
                var withStress = selected.Where(el => stressById.ContainsKey(el.Id))
                    .Select(el => stressById[el.Id]).ToList();
                if (withStress.Count > 0)
                {
                    sb.AppendLine();
                    sb.AppendLine($"VM  min {withStress.Min(s => s.SigmaVM):G5}  max {withStress.Max(s => s.SigmaVM):G5}");
                    sb.AppendLine($"SX  min {withStress.Min(s => s.Sxx):G5}  max {withStress.Max(s => s.Sxx):G5}");
                    sb.AppendLine($"SY  min {withStress.Min(s => s.Syy):G5}  max {withStress.Max(s => s.Syy):G5}");
                    sb.AppendLine($"SXY min {withStress.Min(s => s.Sxy):G5}  max {withStress.Max(s => s.Sxy):G5}");
                }
            }
            else
            {
                var membById = _model.Membranes.ToDictionary(m => m.Id);
                sb.AppendLine("(no results - run Analyze > Solve for stresses)");
                foreach (var el in selected.Take(maxRows))
                {
                    var memb = el.MembraneId is { } mid ? membById.GetValueOrDefault(mid) : null;
                    double? eMod = el.PropE ?? memb?.MaterialE;
                    double? t = el.PropT ?? memb?.MaterialT;
                    string elType = el.Type == "quad8" ? "Quad8" : "Quad4";
                    sb.AppendLine($"El {el.Id}: {elType}, surface {el.MembraneId?.ToString() ?? "-"}, E={eMod:G5}, t={t:G5}");
                }
                if (selected.Count > maxRows) sb.AppendLine($"  … {selected.Count - maxRows} more not shown");
            }
            sb.AppendLine();
        }

        if (_renderer.SelectedNodes.Count > 0)
        {
            var dispById = _result?.Displacements.ToDictionary(d => d.NodeId);
            var nodalById = _result?.NodalStresses.ToDictionary(s => s.NodeId);
            var reactById = _result?.Reactions.ToDictionary(r => r.NodeId);
            var selected = _model.FeNodes
                .Where(n => _renderer.SelectedNodes.Contains(n.Id))
                .OrderBy(n => n.Id).ToList();
            sb.AppendLine($"Nodes ({selected.Count}):");
            sb.AppendLine(dispById is not null
                ? $"{"ID",6} {"DX",12} {"DY",12} {"RX",12} {"RY",12} {"SX avg",12} {"SY avg",12} {"SXY avg",12} {"VM avg",12}"
                : $"{"ID",6} {"X",10} {"Y",10}  BC");
            foreach (var n in selected.Take(maxRows))
            {
                if (dispById is not null && dispById.TryGetValue(n.Id, out var dsp))
                {
                    var ns = nodalById?.GetValueOrDefault(n.Id);
                    var re = reactById?.GetValueOrDefault(n.Id);
                    string rx = re is not null ? $"{re.Rx,12:G5}" : $"{"-",12}";
                    string ry = re is not null ? $"{re.Ry,12:G5}" : $"{"-",12}";
                    sb.AppendLine(ns is not null
                        ? $"{n.Id,6} {dsp.Dx,12:E3} {dsp.Dy,12:E3} {rx} {ry} {ns.Sxx,12:G5} {ns.Syy,12:G5} {ns.Sxy,12:G5} {ns.SigmaVM,12:G5}"
                        : $"{n.Id,6} {dsp.Dx,12:E3} {dsp.Dy,12:E3} {rx} {ry} {"-",12} {"-",12} {"-",12} {"-",12}");
                }
                else
                    sb.AppendLine($"{n.Id,6} {n.X,10:G5} {n.Y,10:G5}  {n.Bc?.Type ?? "-"}");
            }
            if (selected.Count > maxRows) sb.AppendLine($"  … {selected.Count - maxRows} more not shown");

            // Reaction totals and averages over the selected constrained nodes
            if (reactById is not null)
            {
                var reacts = selected.Where(n => reactById.ContainsKey(n.Id)).Select(n => reactById[n.Id]).ToList();
                if (reacts.Count > 0)
                {
                    double sumRx = reacts.Sum(r => r.Rx), sumRy = reacts.Sum(r => r.Ry);
                    sb.AppendLine();
                    sb.AppendLine($"Reactions over {reacts.Count} constrained node(s):");
                    sb.AppendLine($"  Sum  RX {sumRx,12:G5}   RY {sumRy,12:G5}");
                    sb.AppendLine($"  Avg  RX {sumRx / reacts.Count,12:G5}   RY {sumRy / reacts.Count,12:G5}");
                }
            }
            if (nodalById is not null)
            {
                var withStress = selected.Where(n => nodalById.ContainsKey(n.Id)).Select(n => nodalById[n.Id]).ToList();
                if (withStress.Count > 0)
                {
                    sb.AppendLine();
                    sb.AppendLine($"VM avg  min {withStress.Min(s => s.SigmaVM):G5}  max {withStress.Max(s => s.SigmaVM):G5}");
                }
            }
            sb.AppendLine();
        }

        if (_renderer.SelectedSprings.Count > 0)
        {
            var loadById = _result?.SpringLoads.ToDictionary(s => s.Id);
            var selected = _model.FeSprings
                .Where(s => _renderer.SelectedSprings.Contains(s.Id))
                .OrderBy(s => s.Id).ToList();
            sb.AppendLine($"Springs ({selected.Count}):");
            sb.AppendLine(loadById is not null
                ? $"{"ID",6} {"FX",12} {"FY",12} {"FR",12} {"k",12}"
                : $"{"ID",6} {"Node1",8} {"Node2",8} {"k",12}");
            double maxFr = 0;
            foreach (var s in selected.Take(maxRows))
            {
                if (loadById is not null && loadById.TryGetValue(s.Id, out var sl))
                {
                    double fr = Math.Sqrt(sl.Fx * sl.Fx + sl.Fy * sl.Fy);
                    maxFr = Math.Max(maxFr, fr);
                    sb.AppendLine($"{s.Id,6} {sl.Fx,12:G5} {sl.Fy,12:G5} {fr,12:G5} {s.Stiffness,12:G4}");
                }
                else
                    sb.AppendLine($"{s.Id,6} {s.FeNodeId1,8} {s.FeNodeId2,8} {s.Stiffness,12:G4}");
            }
            if (selected.Count > maxRows) sb.AppendLine($"  … {selected.Count - maxRows} more not shown");
            if (loadById is not null && selected.Count > 1)
            {
                var loads = selected.Where(s => loadById.ContainsKey(s.Id)).Select(s => loadById[s.Id]).ToList();
                if (loads.Count > 0)
                {
                    sb.AppendLine();
                    sb.AppendLine($"FR  max {loads.Max(l => Math.Sqrt(l.Fx * l.Fx + l.Fy * l.Fy)):G5}" +
                                  $"  avg {loads.Average(l => Math.Sqrt(l.Fx * l.Fx + l.Fy * l.Fy)):G5}");
                }
            }
            sb.AppendLine();
        }

        if (_renderer.SelectedBars.Count > 0)
        {
            var barById = _result?.BarLoads.ToDictionary(b => b.Id);
            var selected = _model.FeBars
                .Where(b => _renderer.SelectedBars.Contains(b.Id))
                .OrderBy(b => b.Id).ToList();
            sb.AppendLine($"Bars ({selected.Count}):");
            foreach (var b in selected.Take(maxRows))
            {
                if (barById is not null && barById.TryGetValue(b.Id, out var bl))
                    sb.AppendLine($"B{b.Id}: P={bl.P:G5} {(bl.P >= 0 ? "(T)" : "(C)")}, stress={bl.Stress:G5}, L={bl.Length:G5}");
                else
                    sb.AppendLine($"B{b.Id}: E={b.E:G5}, A={b.A:G5}");
            }
            sb.AppendLine();
        }

        TxtSelData.Text = sb.Length > 0 ? sb.ToString() : "(nothing selected)";
    }

    private string DescribeSurface(Membrane s)
    {
        string points = string.Join(", ", s.NodeIds);
        string edges = string.Join(", ", s.EdgeRadii.Select((r, i) => r == 0 ? $"E{i + 1} straight" : $"E{i + 1} R={r:G6}"));
        int els = _model.FeElements.Count(e => e.MembraneId == s.Id);
        string divisions = s.MeshM is { } mm && s.MeshN is { } nn ? $" {mm}x{nn}" : "";
        string elType = s.MeshQuadratic ? "Quad8" : "Quad4";
        string mesh = els == 0 ? "unmeshed" : $"meshed{divisions} {elType} membrane ({els} elements)";
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

            // Header with a visibility checkbox: toggling hides/shows the surface AND
            // its mesh (nodes + elements) without rebuilding the tree.
            var headerPanel = new StackPanel { Orientation = Orientation.Horizontal };
            var visChk = new CheckBox
            {
                IsChecked = s.Visible,
                VerticalAlignment = VerticalAlignment.Center,
                Margin = new Thickness(0, 0, 5, 0),
                ToolTip = "Show/hide this surface and its mesh"
            };
            var surfId = s.Id;
            RoutedEventHandler visHandler = (_, args) =>
            {
                args.Handled = true; // don't select the tree item when clicking the checkbox
                var surf = _model.Membranes.FirstOrDefault(m => m.Id == surfId);
                if (surf is null) return;
                surf.Visible = visChk.IsChecked == true;
                _renderer.Rebuild();
                Canvas.InvalidateVisual();
                Log($"Surface {surfId} {(surf.Visible ? "shown" : "hidden")}.");
            };
            visChk.Checked += visHandler;
            visChk.Unchecked += visHandler;
            headerPanel.Children.Add(visChk);
            headerPanel.Children.Add(new TextBlock
            {
                Text = $"Surface {s.Id}" + (els > 0 ? "  [meshed]" : "  [unmeshed]"),
                VerticalAlignment = VerticalAlignment.Center
            });
            var item = new TreeViewItem { Header = headerPanel, Tag = s.Id };

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
            string meshType = s.MeshQuadratic ? "Quad8" : "Quad4";
            item.Items.Add(new TreeViewItem
            {
                Header = els == 0 ? "Mesh: (none)" : $"Mesh: {meshType} membrane{meshDiv} ({els} elements)"
            });

            surfaces.Items.Add(item);
        }
        geo.Items.Add(surfaces);
        geo.Items.Add(new TreeViewItem { Header = $"Spring Points ({_model.SpringPoints.Count})" });
        ModelTree.Items.Add(geo);

        var fem = new TreeViewItem { Header = "Model", IsExpanded = true };
        fem.Items.Add(new TreeViewItem { Header = $"Nodes ({_model.FeNodes.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Elements ({_model.FeElements.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Bars ({_model.FeBars.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"Springs ({_model.FeSprings.Count})" });
        fem.Items.Add(new TreeViewItem { Header = $"RBE2s ({_model.Rbe2s.Count})" });
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
        if (_model.Cracks.Count > 0)
        {
            var sifById = _result?.CrackSifs.ToDictionary(s => s.CrackId);
            foreach (var c in _model.Cracks)
            {
                var sif = sifById?.GetValueOrDefault(c.Id);
                results.Items.Add(new TreeViewItem
                {
                    Header = sif is null
                        ? $"Crack {c.Id} (tip node {c.TipNodeId}): solve for K"
                        : $"Crack {c.Id}: K_I = {sif.K1:G5}, K_II = {sif.K2:G5}"
                });
            }
        }
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

    // ====================== edit menu ======================

    private void MenuUndo_Click(object sender, RoutedEventArgs e) => Undo();

    private void MenuDeleteSelected_Click(object sender, RoutedEventArgs e) => DeleteSelected();

    private void MenuClearSelection_Click(object sender, RoutedEventArgs e)
    {
        ClearSelection();
        _renderer.Rebuild();
        Canvas.InvalidateVisual();
    }

    private void MenuDeleteNodes_Click(object sender, RoutedEventArgs e)
    {
        if (_renderer.SelectedNodes.Count == 0)
        {
            Prompt("Select node(s) first (Select: Nodes, click or box).");
            return;
        }
        DeleteSelected();
    }

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

    private void MenuSurfaceByOrigin_Click(object sender, RoutedEventArgs e)
    {
        var d = new FormDialog(this, "Surface by Origin and Size")
            .AddField("x0", "Origin X", 0).AddField("y0", "Origin Y", 0)
            .AddField("lx", "Length X", 100).AddField("ly", "Length Y", 50)
            .AddField("E", "Modulus E", 10.5e6).AddField("nu", "Poisson nu", 0.33).AddField("t", "Thickness t", 0.05)
            .AddNote("Corners are origin, origin+X, origin+X+Y, origin+Y. Negative lengths grow the other way.");
        if (!d.Run()) return;
        double x0 = d.Num("x0"), y0 = d.Num("y0"), lx = d.Num("lx"), ly = d.Num("ly");
        if (lx == 0 || ly == 0) { Prompt("Lengths must be non-zero."); return; }
        Snapshot();
        var s = Mesher.AddSurface(_model,
            new[] { (x0, y0), (x0 + lx, y0), (x0 + lx, y0 + ly), (x0, y0 + ly) },
            d.Num("E"), d.Num("nu"), d.Num("t"));
        ModelChanged(invalidateResults: false);
        FitView();
        Log($"Surface {s.Id} created at ({x0:G6}, {y0:G6}), {lx:G6} x {ly:G6}.");
    }

    private void MenuSpringPointGrid_Click(object sender, RoutedEventArgs e)
    {
        var d = new FormDialog(this, "Spring Point Grid")
            .AddField("x0", "Start X", 0).AddField("y0", "Start Y", 0)
            .AddField("w", "Width (X extent)", 100).AddField("h", "Height (Y extent)", 50)
            .AddField("nx", "Points in X", 5).AddField("ny", "Points in Y", 3)
            .AddNote("Spring points are free markers used only by Model > Create Springs at Spring Points.");
        if (!d.Run()) return;
        int nx = (int)d.Num("nx"), ny = (int)d.Num("ny");
        if (nx < 1 || ny < 1) { Prompt("Point counts must be at least 1."); return; }
        Snapshot();
        var pts = Mesher.AddSpringPointGrid(_model, d.Num("x0"), d.Num("y0"), d.Num("w"), d.Num("h"), nx, ny);
        ModelChanged(invalidateResults: false);
        Log($"{pts.Count} spring point(s) created ({nx} x {ny} grid).");
    }

    private void MenuDeleteSpringPoints_Click(object sender, RoutedEventArgs e)
    {
        if (_model.SpringPoints.Count == 0) { Prompt("No spring points to delete."); return; }
        Snapshot();
        int n = _model.SpringPoints.Count;
        _model.SpringPoints.Clear();
        ModelChanged(invalidateResults: false);
        Log($"{n} spring point(s) deleted.");
    }

    private void MenuSpringsAtPoints_Click(object sender, RoutedEventArgs e)
    {
        if (_model.SpringPoints.Count == 0)
        {
            Prompt("No spring points - create them first (Geometry > Spring Point Grid…).");
            return;
        }
        var d = new FormDialog(this, $"Springs at {_model.SpringPoints.Count} Spring Point(s)")
            .AddField("range", "Coincidence range", 0.1)
            .AddField("k", "Stiffness k (X and Y)", 5e4)
            .AddNote("One spring per point, created only where EXACTLY two visible FE nodes " +
                     "lie within range. Hide surfaces to control which nodes are considered.");
        if (!d.Run()) return;
        Snapshot();
        var r = Mesher.CreateSpringsAtSpringPoints(_model, d.Num("range"), d.Num("k"));
        ModelChanged();
        var parts = new List<string> { $"{r.Created} spring(s) created" };
        if (r.SkippedTooFew > 0) parts.Add($"{r.SkippedTooFew} point(s) skipped (fewer than 2 nodes in range)");
        if (r.SkippedTooMany > 0) parts.Add($"{r.SkippedTooMany} point(s) skipped (more than 2 nodes in range - reduce the range or hide surfaces)");
        if (r.SkippedDuplicate > 0) parts.Add($"{r.SkippedDuplicate} point(s) skipped (spring already exists)");
        string msg = string.Join("; ", parts) + ".";
        Log(msg);
        Prompt(msg);
    }

    private void MenuSurfacePick_Click(object sender, RoutedEventArgs e)
    {
        _mode = Mode.PickCorners;
        _pickedCorners.Clear();
        Prompt("Pick corner 1 of 4 - clicks near an existing point snap to it. Order corners around the boundary (Esc to cancel).");
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

    private void MenuRbe2_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count < 2) { Prompt("Select 2+ nodes first (Select: Nodes, click or box)."); return; }
        int independent = nodes.Min(n => n.Id);
        var d = new FormDialog(this, $"RBE2 over {nodes.Count} Node(s)")
            .AddCheck("tx", "Tie X (all nodes move together in X)", true)
            .AddCheck("ty", "Tie Y (all nodes move together in Y)", true)
            .AddNote($"Independent node: {independent} (lowest selected id). Translational only - " +
                     "the membrane model has no rotational DOFs. Enforced as an exact constraint.");
        if (!d.Run()) return;
        if (!d.Check("tx") && !d.Check("ty")) { Prompt("Tie at least one direction."); return; }
        Snapshot();
        var rbe2 = Mesher.CreateRbe2(_model, nodes.Select(n => n.Id).ToList(), d.Check("tx"), d.Check("ty"));
        ModelChanged();
        Log($"RBE2 {rbe2.Id} created: independent node {rbe2.IndependentNodeId}, " +
            $"{rbe2.DependentNodeIds.Count} dependent(s), ties [{(rbe2.TieX ? "X" : "")}{(rbe2.TieY ? "Y" : "")}].");
    }

    private void MenuDeleteRbe2s_Click(object sender, RoutedEventArgs e)
    {
        if (_model.Rbe2s.Count == 0) { Prompt("No RBE2s to delete."); return; }
        Snapshot();
        int n = _model.Rbe2s.Count;
        _model.Rbe2s.Clear();
        ModelChanged();
        Log($"{n} RBE2(s) deleted.");
    }

    private void MenuCrack_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count < 3)
        {
            Prompt("Select the crack path nodes first (Select: Nodes - box-select corners AND midsides along one mesh line in a Quad8 mesh).");
            return;
        }
        // Identify the path ends (farthest pair) so the tip checkboxes can name them
        FeNode end1 = nodes[0], end2 = nodes[0];
        double best = -1;
        foreach (var a in nodes)
            foreach (var b in nodes)
            {
                double d2 = (a.X - b.X) * (a.X - b.X) + (a.Y - b.Y) * (a.Y - b.Y);
                if (d2 > best) { best = d2; end1 = a; end2 = b; }
            }
        var d = new FormDialog(this, $"Crack Along {nodes.Count} Node(s)")
            .AddCheck("tipStart", $"Tip at node {end1.Id} ({end1.X:G5}, {end1.Y:G5})", false)
            .AddCheck("tipEnd", $"Tip at node {end2.Id} ({end2.X:G5}, {end2.Y:G5})", true)
            .AddNote("The mesh is split into crack faces along the path; midside nodes at each " +
                     "tip move to the quarter points (Barsoum). Requires a Quad8 mesh and a " +
                     "straight path along one mesh line. K_I / K_II are reported after Solve. " +
                     "Tick both for an internal (centre) crack.");
        if (!d.Run()) return;
        try
        {
            Snapshot();
            var cracks = Mesher.CreateCrack(_model, nodes.Select(n => n.Id).ToList(),
                d.Check("tipStart"), d.Check("tipEnd"));
            ClearSelection();
            ModelChanged();
            Log($"{cracks.Count} crack tip(s) created: " +
                string.Join(", ", cracks.Select(c => $"Crack {c.Id} (tip node {c.TipNodeId})")) +
                ". Solve to extract K_I / K_II.");
        }
        catch (Exception ex)
        {
            Log("Crack creation failed: " + ex.Message);
            MessageBox.Show(this, ex.Message, "Crack creation failed", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void MenuMergeNodes_Click(object sender, RoutedEventArgs e)
    {
        if (_model.FeNodes.Count == 0) { Prompt("No FE nodes - mesh a surface first."); return; }
        bool scoped = _renderer.SelectedNodes.Count > 1;
        var d = new FormDialog(this, "Merge Coincident Nodes")
            .AddField("tol", "Tolerance", 0.01)
            .AddNote(scoped
                ? $"Only the {_renderer.SelectedNodes.Count} selected nodes are considered."
                : "All FE nodes are considered (select nodes first to restrict the scope).")
            .AddNote("Pairs joined by a spring are never merged - coincident spring-connected " +
                     "nodes are the fastener idealisation.");
        if (!d.Run()) return;
        Snapshot();
        var (merged, springsRemoved, barsRemoved) = Mesher.MergeCoincidentNodes(
            _model, d.Num("tol"), scoped ? _renderer.SelectedNodes.ToList() : null);
        ClearSelection();
        ModelChanged();
        string scope = scoped ? " among the selected nodes" : "";
        string msg = merged == 0
            ? $"No coincident nodes found within tolerance {d.Num("tol"):G6}{scope}." +
              (scoped ? " (Press Esc to clear the selection and re-run for a whole-model merge.)" : "")
            : $"{merged} node(s) merged within tolerance {d.Num("tol"):G6}{scope}." +
              (springsRemoved > 0 ? $" {springsRemoved} degenerate spring(s) removed." : "") +
              (barsRemoved > 0 ? $" {barsRemoved} degenerate bar(s) removed." : "");
        Log(msg);
        Prompt(msg);
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
            .AddField("n", "Divisions along edge 2-3 (N)", 4)
            .AddCheck("q8", "Quadratic elements (Quad8, corner + midside nodes)", false)
            .AddNote("Quad8 gives quadratic displacement fields - better for stress gradients " +
                     "and the basis for quarter-point crack-tip elements.");
        if (!d.Run()) return;
        Snapshot();
        int m = (int)d.Num("m"), n = (int)d.Num("n");
        bool q8 = d.Check("q8");
        foreach (var s in surfaces)
        {
            var (nodes, els) = Mesher.MeshMembrane(_model, s, m, n, q8);
            Log($"Surface {s.Id} meshed {m}x{n} {(q8 ? "Quad8" : "Quad4")}: {nodes} nodes, {els} elements.");
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

    private void MenuDistLoad_Click(object sender, RoutedEventArgs e)
    {
        var nodes = SelectedFeNodes();
        if (nodes.Count < 2)
        {
            Prompt("Select the nodes along the loaded line first (Select: Nodes - for Quad8 meshes include the midside nodes).");
            return;
        }
        var d = new FormDialog(this, $"Distributed Load over {nodes.Count} Node(s)")
            .AddField("fx", "FX", 0)
            .AddField("fy", "FY", 0)
            .AddCheck("total", "Values are the TOTAL load over the line (untick for running load per unit length)", false)
            .AddNote("Applied as consistent nodal loads on the element edges spanned by the " +
                     "selection (1/2-1/2 per Quad4 edge, 1/6-4/6-1/6 per Quad8 edge). " +
                     "Adds to existing nodal loads; nodes with fixed/enforced BCs are skipped.");
        if (!d.Run()) return;
        if (d.Num("fx") == 0 && d.Num("fy") == 0) { Prompt("Enter a non-zero FX and/or FY."); return; }
        try
        {
            Snapshot();
            var res = Mesher.ApplyDistributedLoad(_model, nodes.Select(n => n.Id).ToList(),
                d.Num("fx"), d.Num("fy"), d.Check("total"));
            ModelChanged();
            Log($"Distributed load applied over {res.Edges} edge(s), length {res.TotalLength:G5}: " +
                $"total FX = {res.AppliedFx:G5}, FY = {res.AppliedFy:G5}" +
                (res.SkippedConstrained > 0
                    ? $" ({res.SkippedConstrained} constrained node(s) skipped - their share was dropped)."
                    : "."));
        }
        catch (Exception ex)
        {
            Log("Distributed load failed: " + ex.Message);
            MessageBox.Show(this, ex.Message, "Distributed load failed", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
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
        if (_renderer.SelectedNodes.Count > 0)
        {
            Snapshot();
            var (nodes2, els2, springs2, bars2) = Mesher.DeleteNodes(_model, _renderer.SelectedNodes);
            ClearSelection();
            ModelChanged();
            var extras = new List<string>();
            if (els2 > 0) extras.Add($"{els2} element(s)");
            if (springs2 > 0) extras.Add($"{springs2} spring(s)");
            if (bars2 > 0) extras.Add($"{bars2} bar(s)");
            Log($"{nodes2} node(s) deleted" +
                (extras.Count > 0 ? $" (with attached {string.Join(", ", extras)})." : "."));
            return;
        }
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
        if (_renderer.SelectedSprings.Count > 0)
        {
            Snapshot();
            int count = _renderer.SelectedSprings.Count;
            _model.FeSprings.RemoveAll(s => _renderer.SelectedSprings.Contains(s.Id));
            ClearSelection();
            ModelChanged();
            Log($"{count} spring(s) deleted.");
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
            UpdateSelInfo(); // refresh Selection Data pane with the new results
            string msg = $"Analysis complete: {_result.DofCount} DOF, {_result.NonZeros} non-zeros, " +
                $"{_result.ConstrainedDofs} constrained DOFs, {_result.Elapsed.TotalMilliseconds:F0} ms. " +
                $"Max |d| = {_result.Displacements.Max(d => Math.Max(Math.Abs(d.Dx), Math.Abs(d.Dy))):E3}.";
            Prompt(msg);
            Log(msg);
            foreach (var sif in _result.CrackSifs)
                Log($"Crack {sif.CrackId} (tip node {sif.TipNodeId}): " +
                    $"K_I = {sif.K1:G6}, K_II = {sif.K2:G6}  (quarter-point face L = {sif.FaceElementLength:G4})");
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

    private void ChkNodalAvg_Changed(object sender, RoutedEventArgs e)
    {
        if (_renderer is null) return;
        _renderer.NodalAveraged = ChkNodalAvg.IsChecked == true;
        Canvas?.InvalidateVisual();
    }

    private void CmbVectors_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (_renderer is null) return;
        _renderer.VectorPlot = CmbVectors.SelectedIndex switch
        {
            1 => VectorPlot.SpringForces,
            2 => VectorPlot.Reactions,
            3 => VectorPlot.Both,
            _ => VectorPlot.None
        };
        Canvas?.InvalidateVisual();
    }

    private void TxtVectorScale_TextChanged(object sender, TextChangedEventArgs e)
    {
        if (_renderer is null) return;
        var text = TxtVectorScale.Text.Trim();
        _renderer.VectorScale =
            text.Length > 0 &&
            double.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, out var v) && v > 0
                ? v : null; // blank or invalid = auto
        Canvas?.InvalidateVisual();
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
            // Snap to an existing geometry point within ~10 screen px - the surface
            // then SHARES that point (no near-coincident duplicates in space).
            double snapTol = 10 / _scale;
            var snap = _model.Nodes
                .Select(g => (g, d2: (g.X - wx) * (g.X - wx) + (g.Y - wy) * (g.Y - wy)))
                .Where(t => t.d2 <= snapTol * snapTol)
                .OrderBy(t => t.d2)
                .Select(t => t.g)
                .FirstOrDefault();
            if (snap is not null && _pickedCorners.Any(c => c.PointId == snap.Id))
            {
                Prompt($"Point {snap.Id} is already corner {_pickedCorners.FindIndex(c => c.PointId == snap.Id) + 1} - pick a different corner.");
                return;
            }
            if (snap is not null)
            {
                _pickedCorners.Add((snap.X, snap.Y, snap.Id));
                Log($"Corner {_pickedCorners.Count}: snapped to existing Point {snap.Id} ({snap.X:G6}, {snap.Y:G6}).");
            }
            else
            {
                _pickedCorners.Add((wx, wy, null));
                Log($"Corner {_pickedCorners.Count}: new point at ({wx:F2}, {wy:F2}).");
            }

            if (_pickedCorners.Count == 4)
            {
                _mode = Mode.Select;
                var d = new FormDialog(this, "New Surface Properties")
                    .AddField("E", "Modulus E", 10.5e6).AddField("nu", "Poisson nu", 0.33).AddField("t", "Thickness t", 0.05);
                if (d.Run())
                {
                    try
                    {
                        Snapshot();
                        var s = Mesher.AddSurface(_model, _pickedCorners.ToArray(), d.Num("E"), d.Num("nu"), d.Num("t"));
                        int shared = _pickedCorners.Count(c => c.PointId is not null);
                        ModelChanged(invalidateResults: false);
                        Log($"Surface {s.Id} created" + (shared > 0 ? $" ({shared} corner(s) shared with existing geometry)." : "."));
                    }
                    catch (Exception ex)
                    {
                        Log("Surface creation failed: " + ex.Message);
                        MessageBox.Show(this, ex.Message, "Surface creation failed", MessageBoxButton.OK, MessageBoxImage.Warning);
                    }
                }
                _pickedCorners.Clear();
                Prompt("Ready.");
            }
            else Prompt($"Pick corner {_pickedCorners.Count + 1} of 4 - clicks near an existing point snap to it (Esc to cancel).");
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
            case Target.Springs:
                if (!additive) _renderer.SelectedSprings.Clear();
                var ns = _model.FeNodes.ToDictionary(n => n.Id);
                foreach (var s in _model.FeSprings)
                    if (ns.TryGetValue(s.FeNodeId1, out var s1) && ns.TryGetValue(s.FeNodeId2, out var s2)
                        && Inside(s1.X, s1.Y) && Inside(s2.X, s2.Y))
                        _renderer.SelectedSprings.Add(s.Id);
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
                    if (!ElementTopology.IsSupported(el)) continue;
                    var v = ElementTopology.BoundaryNodeIds(el)
                        .Select(id => nodeById.GetValueOrDefault(id)).ToArray();
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
            case Target.Springs:
            {
                var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
                FeSpring? hit = null;
                double best = tol;
                foreach (var s in _model.FeSprings)
                {
                    if (!nodeById.TryGetValue(s.FeNodeId1, out var n1) || !nodeById.TryGetValue(s.FeNodeId2, out var n2)) continue;
                    double d = DistToSegment(wx, wy, n1.X, n1.Y, n2.X, n2.Y);
                    if (d < best) { best = d; hit = s; }
                }
                ApplyPick(_renderer.SelectedSprings, hit?.Id, additive);
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
