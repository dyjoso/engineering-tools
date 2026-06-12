using FeaCore;
using SkiaSharp;

namespace FeaApp;

public enum StressView { None, VonMises, Sxx, Syy, Sxy }

/// <summary>
/// FEMAP-style immediate-mode renderer: deep-blue gradient background, white mesh,
/// cyan geometry curves, yellow bars, contour bands with a labelled legend, and a
/// screen-space XY triad. All geometry is pre-built into flat arrays on SetModel /
/// selection change; line widths and markers are constant screen size.
/// </summary>
public sealed class SceneRenderer
{
    // FEMAP-ish palette
    private static readonly SKColor BgTop = new(0x46, 0x5E, 0x8C);
    private static readonly SKColor BgBottom = new(0x14, 0x1E, 0x33);
    private static readonly SKColor MeshColor = new(0xE9, 0xED, 0xF4);
    private static readonly SKColor NodeColor = new(0xD9, 0x55, 0x4C);
    private static readonly SKColor GeoColor = new(0x35, 0xD3, 0xE0);
    private static readonly SKColor BarColor = new(0xFF, 0xD2, 0x3F);
    private static readonly SKColor SpringColor = new(0xE8, 0x6F, 0xE0);
    private static readonly SKColor SelectColor = new(0xFF, 0xFF, 0xFF);
    private static readonly SKColor ConstraintColor = new(0x36, 0xE0, 0xC8);
    private static readonly SKColor LoadColor = new(0xFF, 0x60, 0x52);
    private static readonly SKColor EnforcedColor = new(0x7C, 0xFF, 0x6E);

    private FeModel? _model;
    private SolveResult? _result;

    private float[] _edges = [];
    private float[] _selElementOutlines = [];
    private SKPoint[] _nodesPlain = [];
    private SKPoint[] _nodesSelected = [];
    private (SKPoint a, SKPoint b, bool sel, string label)[] _springs = [];
    private (SKPoint a, SKPoint b, bool sel, string label)[] _bars = [];
    private (SKPoint[] pts, double vm, double sx, double sy, double sxy)[] _stressPolys = [];
    // Smooth (nodal-averaged) contour: 2 triangles per quad with per-vertex values
    private SKPoint[] _smoothPos = [];
    private (double vm, double sx, double sy, double sxy)[] _smoothVals = [];
    private (SKPoint[] outline, bool sel, int id)[] _surfaces = [];
    private (SKPoint p, bool sel, int id)[] _geoPoints = [];
    private SKPoint[] _springPoints = [];
    private Dictionary<int, (double dx, double dy)> _disp = new();

    public StressView StressView { get; set; } = StressView.None;
    /// <summary>Contour from nodal-averaged stresses (smooth) instead of per-element values (flat).</summary>
    public bool NodalAveraged { get; set; } = true;
    public bool ShowDeformed { get; set; }
    public bool ShowGrid { get; set; }
    public bool ShowLabels { get; set; } = true;
    public string ContourTitle { get; private set; } = "";
    public (double min, double max)? ContourRange { get; private set; }

    public HashSet<int> SelectedSurfaces { get; } = new();
    public HashSet<int> SelectedPoints { get; } = new();
    public HashSet<int> SelectedNodes { get; } = new();
    public HashSet<int> SelectedElements { get; } = new();
    public HashSet<int> SelectedBars { get; } = new();

    /// <summary>Screen-space rubber band (device px), drawn while box-selecting.</summary>
    public SKRect? RubberBand { get; set; }

    public void SetModel(FeModel? model, SolveResult? result)
    {
        _model = model;
        _result = result;
        Rebuild();
    }

    public void Rebuild()
    {
        if (_model is null)
        {
            _edges = []; _selElementOutlines = []; _nodesPlain = []; _nodesSelected = [];
            _springs = []; _bars = []; _stressPolys = []; _surfaces = []; _disp = new();
            return;
        }
        var nodeById = _model.FeNodes.ToDictionary(n => n.Id);

        // Surfaces: boundary outlines with sampled arcs
        _surfaces = _model.Membranes.Where(s => s.Visible && s.NodeIds.Count == 4).Select(s =>
        {
            var corners = s.NodeIds.Select(id => _model.Nodes.FirstOrDefault(g => g.Id == id)).ToArray();
            var pts = new List<SKPoint>();
            if (corners.All(c => c is not null))
            {
                for (int e = 0; e < 4; e++)
                {
                    var a = corners[e]!; var b = corners[(e + 1) % 4]!;
                    double r = e < s.EdgeRadii.Count ? s.EdgeRadii[e] : 0;
                    int steps = r == 0 ? 1 : 16;
                    for (int k = 0; k < steps; k++)
                    {
                        var (x, y) = Mesher.ArcPoint(a.X, a.Y, b.X, b.Y, r, (double)k / steps);
                        pts.Add(new SKPoint((float)x, (float)y));
                    }
                }
            }
            return (pts.ToArray(), SelectedSurfaces.Contains(s.Id), s.Id);
        }).ToArray();

        var hidden = _model.Membranes.Where(s => !s.Visible).Select(s => s.Id).ToHashSet();

        // Geometry corner points: hidden if every surface using the point is hidden
        // (points not used by any surface stay visible)
        var pointUsage = new Dictionary<int, (int total, int hidden)>();
        foreach (var m in _model.Membranes)
            foreach (var pid in m.NodeIds)
            {
                var u = pointUsage.GetValueOrDefault(pid);
                pointUsage[pid] = (u.total + 1, u.hidden + (hidden.Contains(m.Id) ? 1 : 0));
            }
        _geoPoints = _model.Nodes
            .Where(g => !pointUsage.TryGetValue(g.Id, out var u) || u.hidden < u.total)
            .Select(g => (new SKPoint((float)g.X, (float)g.Y), SelectedPoints.Contains(g.Id), g.Id))
            .ToArray();

        _springPoints = _model.SpringPoints
            .Select(p => new SKPoint((float)p.X, (float)p.Y)).ToArray();

        // Mesh edges (dedup) + selected element outlines
        var edgeKeys = new HashSet<long>();
        var edges = new List<float>(_model.FeElements.Count * 8);
        var selOutlines = new List<float>();
        foreach (var el in _model.FeElements)
        {
            if (el.MembraneId is { } mid && hidden.Contains(mid)) continue;
            if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
            if (SelectedElements.Contains(el.Id))
            {
                foreach (var nid in el.NodeIds)
                {
                    var n = nodeById[nid];
                    selOutlines.Add((float)n.X); selOutlines.Add((float)n.Y);
                }
                continue;
            }
            for (int i = 0; i < 4; i++)
            {
                int a = el.NodeIds[i], b = el.NodeIds[(i + 1) % 4];
                long key = a < b ? (long)a << 32 | (uint)b : (long)b << 32 | (uint)a;
                if (!edgeKeys.Add(key)) continue;
                var na = nodeById[a]; var nb = nodeById[b];
                edges.Add((float)na.X); edges.Add((float)na.Y);
                edges.Add((float)nb.X); edges.Add((float)nb.Y);
            }
        }
        _edges = edges.ToArray();
        _selElementOutlines = selOutlines.ToArray();

        _nodesPlain = _model.FeNodes
            .Where(n => (n.MembraneId is not { } mid || !hidden.Contains(mid)) && !SelectedNodes.Contains(n.Id))
            .Select(n => new SKPoint((float)n.X, (float)n.Y)).ToArray();
        _nodesSelected = _model.FeNodes
            .Where(n => SelectedNodes.Contains(n.Id))
            .Select(n => new SKPoint((float)n.X, (float)n.Y)).ToArray();

        bool NodeHidden(int id) =>
            nodeById.TryGetValue(id, out var n) && n.MembraneId is { } m && hidden.Contains(m);

        var springLoads = _result?.SpringLoads.ToDictionary(s => s.Id);
        _springs = _model.FeSprings
            .Where(s => nodeById.ContainsKey(s.FeNodeId1) && nodeById.ContainsKey(s.FeNodeId2))
            .Where(s => !(NodeHidden(s.FeNodeId1) && NodeHidden(s.FeNodeId2)))
            .Select(s =>
            {
                var a = nodeById[s.FeNodeId1]; var b = nodeById[s.FeNodeId2];
                string label = springLoads is not null && springLoads.TryGetValue(s.Id, out var sl)
                    ? $"FR={Math.Sqrt(sl.Fx * sl.Fx + sl.Fy * sl.Fy):F1}"
                    : $"S{s.Id} k={s.Stiffness:G4}";
                return (new SKPoint((float)a.X, (float)a.Y), new SKPoint((float)b.X, (float)b.Y), false, label);
            }).ToArray();

        var barLoads = _result?.BarLoads.ToDictionary(b => b.Id);
        _bars = _model.FeBars
            .Where(b => nodeById.ContainsKey(b.FeNodeId1) && nodeById.ContainsKey(b.FeNodeId2))
            .Where(b => !(NodeHidden(b.FeNodeId1) && NodeHidden(b.FeNodeId2)))
            .Select(b =>
            {
                var a = nodeById[b.FeNodeId1]; var c = nodeById[b.FeNodeId2];
                string label = barLoads is not null && barLoads.TryGetValue(b.Id, out var bl)
                    ? $"P={bl.P:F1} {(bl.P >= 0 ? "(T)" : "(C)")}"
                    : $"B{b.Id} A={b.A:G4}";
                return (new SKPoint((float)a.X, (float)a.Y), new SKPoint((float)c.X, (float)c.Y),
                        SelectedBars.Contains(b.Id), label);
            }).ToArray();

        _disp = _result?.Displacements.ToDictionary(d => d.NodeId, d => (d.Dx, d.Dy)) ?? new();

        if (_result is not null)
        {
            var stressById = _result.ElementStresses.ToDictionary(s => s.ElementId);
            var polys = new List<(SKPoint[], double, double, double, double)>();
            foreach (var el in _model.FeElements)
            {
                if (el.MembraneId is { } mid && hidden.Contains(mid)) continue;
                if (!stressById.TryGetValue(el.Id, out var st)) continue;
                var pts = el.NodeIds.Select(id => nodeById[id]).Select(n => new SKPoint((float)n.X, (float)n.Y)).ToArray();
                polys.Add((pts, st.SigmaVM, st.Sxx, st.Syy, st.Sxy));
            }
            _stressPolys = polys.ToArray();

            // Smooth contour data: triangulate each quad (0-1-2, 0-2-3) with
            // nodal-averaged values at each vertex
            var nodal = _result.NodalStresses.ToDictionary(s => s.NodeId);
            var pos = new List<SKPoint>();
            var vals = new List<(double, double, double, double)>();
            foreach (var el in _model.FeElements)
            {
                if (el.MembraneId is { } mid && hidden.Contains(mid)) continue;
                if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
                var p = new SKPoint[4];
                var v = new (double, double, double, double)[4];
                bool ok = true;
                for (int a = 0; a < 4; a++)
                {
                    if (!nodeById.TryGetValue(el.NodeIds[a], out var nd) ||
                        !nodal.TryGetValue(el.NodeIds[a], out var ns)) { ok = false; break; }
                    p[a] = new SKPoint((float)nd.X, (float)nd.Y);
                    v[a] = (ns.SigmaVM, ns.Sxx, ns.Syy, ns.Sxy);
                }
                if (!ok) continue;
                foreach (int a in new[] { 0, 1, 2, 0, 2, 3 })
                {
                    pos.Add(p[a]);
                    vals.Add(v[a]);
                }
            }
            _smoothPos = pos.ToArray();
            _smoothVals = vals.ToArray();
        }
        else { _stressPolys = []; _smoothPos = []; _smoothVals = []; }
    }

    public void Render(SKCanvas canvas, float scale, SKPoint offset, int width, int height)
    {
        // Background gradient (screen space)
        using (var bg = new SKPaint())
        {
            bg.Shader = SKShader.CreateLinearGradient(
                new SKPoint(0, 0), new SKPoint(0, height),
                new[] { BgTop, BgBottom }, null, SKShaderTileMode.Clamp);
            canvas.DrawRect(0, 0, width, height, bg);
        }

        if (_model is null) { DrawTriad(canvas, height); return; }

        canvas.Save();
        canvas.Translate(offset.X, offset.Y);
        canvas.Scale(scale);
        float px = 1f / scale;

        if (ShowGrid) DrawGrid(canvas, scale, offset, width, height, px);

        if (StressView != StressView.None && NodalAveraged && _smoothPos.Length > 0) DrawSmoothStress(canvas);
        else if (StressView != StressView.None && _stressPolys.Length > 0) DrawStress(canvas);
        else { ContourTitle = ""; ContourRange = null; }

        // Mesh
        if (_edges.Length > 0)
        {
            using var meshPaint = new SKPaint { Color = MeshColor, StrokeWidth = px, IsStroke = true, IsAntialias = true };
            using var path = new SKPath();
            for (int i = 0; i < _edges.Length; i += 4)
            {
                path.MoveTo(_edges[i], _edges[i + 1]);
                path.LineTo(_edges[i + 2], _edges[i + 3]);
            }
            canvas.DrawPath(path, meshPaint);
        }
        if (_selElementOutlines.Length > 0)
        {
            using var selPaint = new SKPaint { Color = SelectColor, StrokeWidth = 2.5f * px, IsStroke = true, IsAntialias = true };
            using var path = new SKPath();
            for (int i = 0; i < _selElementOutlines.Length; i += 8)
            {
                path.MoveTo(_selElementOutlines[i], _selElementOutlines[i + 1]);
                path.LineTo(_selElementOutlines[i + 2], _selElementOutlines[i + 3]);
                path.LineTo(_selElementOutlines[i + 4], _selElementOutlines[i + 5]);
                path.LineTo(_selElementOutlines[i + 6], _selElementOutlines[i + 7]);
                path.Close();
            }
            canvas.DrawPath(path, selPaint);
        }

        // Geometry curves over the mesh
        foreach (var (outline, sel, _) in _surfaces)
        {
            if (outline.Length < 2) continue;
            using var geoPaint = new SKPaint
            {
                Color = sel ? SelectColor : GeoColor,
                StrokeWidth = (sel ? 2.5f : 1.4f) * px,
                IsStroke = true,
                IsAntialias = true
            };
            using var path = new SKPath();
            path.MoveTo(outline[0]);
            for (int i = 1; i < outline.Length; i++) path.LineTo(outline[i]);
            path.Close();
            canvas.DrawPath(path, geoPaint);
        }

        // Nodes as small crosses (FEMAP style)
        DrawNodeCrosses(canvas, _nodesPlain, NodeColor, 2.5f * px, px);
        DrawNodeCrosses(canvas, _nodesSelected, SelectColor, 4f * px, 1.8f * px);

        // Geometry corner points as filled squares (cyan; white when selected)
        if (_geoPoints.Length > 0)
        {
            using var geoPtPlain = new SKPaint { Color = GeoColor, IsAntialias = true };
            using var geoPtSel = new SKPaint { Color = SelectColor, IsAntialias = true };
            foreach (var (pt, sel, _) in _geoPoints)
            {
                float r = (sel ? 5f : 3.5f) * px;
                canvas.DrawRect(pt.X - r, pt.Y - r, 2 * r, 2 * r, sel ? geoPtSel : geoPtPlain);
            }
        }

        // Spring points as magenta diamonds (free geometry markers for spring creation)
        if (_springPoints.Length > 0)
        {
            using var spPaint = new SKPaint { Color = SpringColor, IsAntialias = true };
            using var spPath = new SKPath();
            float r = 4.5f * px;
            foreach (var pt in _springPoints)
            {
                spPath.MoveTo(pt.X, pt.Y - r);
                spPath.LineTo(pt.X + r, pt.Y);
                spPath.LineTo(pt.X, pt.Y + r);
                spPath.LineTo(pt.X - r, pt.Y);
                spPath.Close();
            }
            canvas.DrawPath(spPath, spPaint);
        }

        // Springs
        using (var springPaint = new SKPaint
        {
            Color = SpringColor, StrokeWidth = 1.4f * px, IsStroke = true, IsAntialias = true,
            PathEffect = SKPathEffect.CreateDash(new[] { 6 * px, 4 * px }, 0)
        })
            foreach (var (a, b, _, _) in _springs)
                canvas.DrawLine(a, b, springPaint);

        // Bars
        foreach (var (a, b, sel, _) in _bars)
        {
            using var barPaint = new SKPaint
            {
                Color = sel ? SelectColor : BarColor,
                StrokeWidth = (sel ? 3.5f : 2.2f) * px,
                IsStroke = true, IsAntialias = true
            };
            canvas.DrawLine(a, b, barPaint);
        }

        if (ShowLabels) DrawLabels(canvas, px);
        DrawBcGlyphs(canvas, px);
        if (ShowDeformed && _disp.Count > 0) DrawDeformed(canvas, px);

        canvas.Restore();

        // Screen-space chrome
        DrawTriad(canvas, height);
        if (ContourRange is not null) DrawLegend(canvas, width);
        if (RubberBand is { } rb)
        {
            using var rbFill = new SKPaint { Color = new SKColor(0x60, 0xA5, 0xFA, 40) };
            using var rbLine = new SKPaint { Color = new SKColor(0x90, 0xC5, 0xFF), StrokeWidth = 1, IsStroke = true };
            canvas.DrawRect(rb, rbFill);
            canvas.DrawRect(rb, rbLine);
        }
    }

    private static void DrawNodeCrosses(SKCanvas canvas, SKPoint[] pts, SKColor color, float r, float lw)
    {
        if (pts.Length == 0) return;
        using var paint = new SKPaint { Color = color, StrokeWidth = lw, IsStroke = true, IsAntialias = true };
        using var path = new SKPath();
        foreach (var p in pts)
        {
            path.MoveTo(p.X - r, p.Y); path.LineTo(p.X + r, p.Y);
            path.MoveTo(p.X, p.Y - r); path.LineTo(p.X, p.Y + r);
        }
        canvas.DrawPath(path, paint);
    }

    private void DrawLabels(SKCanvas canvas, float px)
    {
        using var font = new SKFont(SKTypeface.Default, 10 * px);
        using var barText = new SKPaint { Color = BarColor, IsAntialias = true, TextSize = 10 * px };
        using var springText = new SKPaint { Color = SpringColor, IsAntialias = true, TextSize = 10 * px };
        void Centered(string label, float x, float y, SKPaint paint)
            => canvas.DrawText(label, x - paint.MeasureText(label) / 2, y, font, paint);
        foreach (var (a, b, _, label) in _bars)
        {
            float dx = b.X - a.X, dy = b.Y - a.Y;
            float len = MathF.Sqrt(dx * dx + dy * dy);
            if (len < 1e-9) continue;
            Centered(label, (a.X + b.X) / 2 - dy / len * 8 * px, (a.Y + b.Y) / 2 + dx / len * 8 * px, barText);
        }
        foreach (var (a, b, _, label) in _springs)
        {
            float dx = b.X - a.X, dy = b.Y - a.Y;
            float len = MathF.Sqrt(dx * dx + dy * dy);
            if (len < 1e-9) continue;
            Centered(label, (a.X + b.X) / 2 - dy / len * 10 * px, (a.Y + b.Y) / 2 + dx / len * 10 * px, springText);
        }
    }

    private void DrawGrid(SKCanvas canvas, float scale, SKPoint offset, int width, int height, float px)
    {
        float wx0 = -offset.X / scale, wy0 = -offset.Y / scale;
        float wx1 = (width - offset.X) / scale, wy1 = (height - offset.Y) / scale;
        double raw = 80.0 / scale;
        double mag = Math.Pow(10, Math.Floor(Math.Log10(raw)));
        double norm = raw / mag;
        double step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag;

        using var grid = new SKPaint { Color = new SKColor(255, 255, 255, 26), StrokeWidth = px, IsStroke = true };
        using var text = new SKPaint { Color = new SKColor(255, 255, 255, 90), IsAntialias = true };
        using var font = new SKFont(SKTypeface.Default, 10 * px);

        for (double gx = Math.Ceiling(wx0 / step) * step; gx <= wx1; gx += step)
        {
            canvas.DrawLine((float)gx, wy0, (float)gx, wy1, grid);
            canvas.DrawText($"{gx:0.######}", (float)gx + 2 * px, wy0 + 12 * px, font, text);
        }
        for (double gy = Math.Ceiling(wy0 / step) * step; gy <= wy1; gy += step)
        {
            canvas.DrawLine(wx0, (float)gy, wx1, (float)gy, grid);
            canvas.DrawText($"{gy:0.######}", wx0 + 4 * px, (float)gy - 2 * px, font, text);
        }
    }

    private void DrawStress(SKCanvas canvas)
    {
        Func<(SKPoint[] pts, double vm, double sx, double sy, double sxy), double> value = StressView switch
        {
            StressView.Sxx => p => p.sx,
            StressView.Syy => p => p.sy,
            StressView.Sxy => p => p.sxy,
            _ => p => p.vm
        };
        ContourTitle = StressView switch
        {
            StressView.Sxx => "Stress X",
            StressView.Syy => "Stress Y",
            StressView.Sxy => "Shear XY",
            _ => "Von Mises"
        };
        double min = _stressPolys.Min(value), max = _stressPolys.Max(value);
        if (max <= min) max = min + (min == 0 ? 1 : Math.Abs(min) * 1e-4);
        ContourRange = (min, max);

        using var fill = new SKPaint { IsAntialias = false };
        using var path = new SKPath();
        foreach (var poly in _stressPolys)
        {
            double t = (value(poly) - min) / (max - min);
            fill.Color = ColorMap((float)t);
            path.Reset();
            path.MoveTo(poly.pts[0]);
            for (int i = 1; i < poly.pts.Length; i++) path.LineTo(poly.pts[i]);
            path.Close();
            canvas.DrawPath(path, fill);
        }
    }

    /// <summary>FEMAP-style discrete band colormap: blue -> cyan -> green -> yellow -> red, 12 levels.</summary>
    public static SKColor ColorMap(float t)
    {
        const int bands = 12;
        t = MathF.Floor(Math.Clamp(t, 0f, 0.9999f) * bands) / (bands - 1);
        float hue = 240f * (1f - t);
        return SKColor.FromHsl(hue, 100f, 50f);
    }

    /// <summary>Continuous colormap for the smooth (nodal-averaged) contour.</summary>
    public static SKColor ColorMapSmooth(float t)
    {
        float hue = 240f * (1f - Math.Clamp(t, 0f, 1f));
        return SKColor.FromHsl(hue, 100f, 50f);
    }

    /// <summary>Smooth contour: Gouraud-shaded triangles with nodal-averaged values at the vertices.</summary>
    private void DrawSmoothStress(SKCanvas canvas)
    {
        int comp = StressView switch { StressView.Sxx => 1, StressView.Syy => 2, StressView.Sxy => 3, _ => 0 };
        ContourTitle = StressView switch
        {
            StressView.Sxx => "Stress X (avg)",
            StressView.Syy => "Stress Y (avg)",
            StressView.Sxy => "Shear XY (avg)",
            _ => "Von Mises (avg)"
        };
        double Val((double vm, double sx, double sy, double sxy) v) =>
            comp switch { 1 => v.sx, 2 => v.sy, 3 => v.sxy, _ => v.vm };

        double min = double.PositiveInfinity, max = double.NegativeInfinity;
        foreach (var v in _smoothVals)
        {
            double x = Val(v);
            if (x < min) min = x;
            if (x > max) max = x;
        }
        if (max <= min) max = min + (min == 0 ? 1 : Math.Abs(min) * 1e-4);
        ContourRange = (min, max);

        var colors = new SKColor[_smoothPos.Length];
        for (int i = 0; i < _smoothVals.Length; i++)
            colors[i] = ColorMapSmooth((float)((Val(_smoothVals[i]) - min) / (max - min)));

        using var vertices = SKVertices.CreateCopy(SKVertexMode.Triangles, _smoothPos, colors);
        using var paint = new SKPaint { IsAntialias = false };
        // Vertex colors are SRC in drawVertices blending; Src shows them unmodified
        canvas.DrawVertices(vertices, SKBlendMode.Src, paint);
    }

    private void DrawLegend(SKCanvas canvas, int width)
    {
        if (ContourRange is not { } range) return;
        const int bands = 12;
        const float bandH = 22, bandW = 26;
        float x = width - 150, y = 50;

        using var font = new SKFont(SKTypeface.Default, 12);
        using var text = new SKPaint { Color = SKColors.White, IsAntialias = true };
        using var titleFont = new SKFont(SKTypeface.Default, 13) { Embolden = true };
        using var box = new SKPaint { Color = new SKColor(0, 0, 0, 90) };

        canvas.DrawRect(x - 12, y - 30, 150, bands * bandH + 50, box);
        canvas.DrawText(ContourTitle, x - 2, y - 10, titleFont, text);

        using var fill = new SKPaint();
        for (int i = 0; i < bands; i++)
        {
            float t = 1f - (float)i / (bands - 1);
            fill.Color = ColorMap(t);
            canvas.DrawRect(x, y + i * bandH, bandW, bandH, fill);
            double v = range.min + (range.max - range.min) * (1.0 - (double)i / bands);
            canvas.DrawText(v.ToString("G4"), x + bandW + 6, y + i * bandH + bandH * 0.7f, font, text);
        }
        canvas.DrawText(range.min.ToString("G4"), x + bandW + 6, y + bands * bandH + 4, font, text);
    }

    private void DrawTriad(SKCanvas canvas, int height)
    {
        float ox = 38, oy = height - 38, len = 26;
        using var xPaint = new SKPaint { Color = new SKColor(0xFF, 0x66, 0x55), StrokeWidth = 2, IsStroke = true, IsAntialias = true };
        using var yPaint = new SKPaint { Color = new SKColor(0x66, 0xDD, 0x66), StrokeWidth = 2, IsStroke = true, IsAntialias = true };
        using var font = new SKFont(SKTypeface.Default, 12);
        using var text = new SKPaint { Color = SKColors.White, IsAntialias = true };
        canvas.DrawLine(ox, oy, ox + len, oy, xPaint);
        canvas.DrawLine(ox, oy, ox, oy + len, yPaint); // Y-down
        canvas.DrawText("X", ox + len + 4, oy + 4, font, text);
        canvas.DrawText("Y", ox - 4, oy + len + 12, font, text);
    }

    private void DrawBcGlyphs(SKCanvas canvas, float px)
    {
        if (_model is null) return;
        float size = 9 * px, off = 6 * px;
        using var fixedPaint = new SKPaint { Color = ConstraintColor, IsAntialias = true };
        using var loadPaint = new SKPaint { Color = LoadColor, StrokeWidth = 1.4f * px, IsAntialias = true };
        using var enfPaint = new SKPaint { Color = EnforcedColor, StrokeWidth = 1.4f * px, IsAntialias = true };

        foreach (var n in _model.FeNodes)
        {
            if (n.Bc is null) continue;
            float x = (float)n.X, y = (float)n.Y;
            if (n.Bc.Type == "fixed")
            {
                if (n.Bc.Value.FixX) Triangle(canvas, x - off - size / 2, y, 0, size, fixedPaint);
                if (n.Bc.Value.FixY) Triangle(canvas, x, y + off + size / 2, -MathF.PI / 2, size, fixedPaint);
            }
            else if (n.Bc.Type is "load" or "enforced")
            {
                var paint = n.Bc.Type == "load" ? loadPaint : enfPaint;
                double? vx = n.Bc.Type == "load" ? n.Bc.Value.Fx : n.Bc.Value.Dx;
                double? vy = n.Bc.Type == "load" ? n.Bc.Value.Fy : n.Bc.Value.Dy;
                if (vx is { } fx && fx != 0) Arrow(canvas, x, y, MathF.Sign((float)fx), 0, off, 2.2f * size, paint, px);
                if (vy is { } fy && fy != 0) Arrow(canvas, x, y, 0, MathF.Sign((float)fy), off, 2.2f * size, paint, px);
            }
        }
    }

    private static void Triangle(SKCanvas canvas, float cx, float cy, float ang, float size, SKPaint paint)
    {
        float r = size / 2;
        using var p = new SKPath();
        p.MoveTo(cx + r * MathF.Cos(ang), cy + r * MathF.Sin(ang));
        p.LineTo(cx + r * MathF.Cos(ang + 2.0944f), cy + r * MathF.Sin(ang + 2.0944f));
        p.LineTo(cx + r * MathF.Cos(ang - 2.0944f), cy + r * MathF.Sin(ang - 2.0944f));
        p.Close();
        canvas.DrawPath(p, paint);
    }

    private static void Arrow(SKCanvas canvas, float x, float y, float dirX, float dirY, float off, float size, SKPaint paint, float px)
    {
        float x1 = x + dirX * off, y1 = y + dirY * off;
        float x2 = x + dirX * (off + size), y2 = y + dirY * (off + size);
        bool wasStroke = paint.IsStroke;
        paint.IsStroke = true;
        canvas.DrawLine(x1, y1, x2, y2, paint);
        paint.IsStroke = false;
        float hl = 6 * px, hw = 4 * px;
        float ang = MathF.Atan2(y2 - y1, x2 - x1);
        using var p = new SKPath();
        p.MoveTo(x2, y2);
        p.LineTo(x2 - hl * MathF.Cos(ang) - hw * MathF.Sin(ang), y2 - hl * MathF.Sin(ang) + hw * MathF.Cos(ang));
        p.LineTo(x2 - hl * MathF.Cos(ang) + hw * MathF.Sin(ang), y2 - hl * MathF.Sin(ang) - hw * MathF.Cos(ang));
        p.Close();
        canvas.DrawPath(p, paint);
        paint.IsStroke = wasStroke;
    }

    private void DrawDeformed(SKCanvas canvas, float px)
    {
        if (_model is null || _result is null) return;
        double maxD = _result.Displacements.Max(d => Math.Max(Math.Abs(d.Dx), Math.Abs(d.Dy)));
        if (maxD <= 0 || _model.FeNodes.Count == 0) return;
        double minX = _model.FeNodes.Min(n => n.X), maxX = _model.FeNodes.Max(n => n.X);
        double minY = _model.FeNodes.Min(n => n.Y), maxY = _model.FeNodes.Max(n => n.Y);
        double k = 0.1 * Math.Max(maxX - minX, maxY - minY) / maxD;

        var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
        SKPoint Def(int id)
        {
            var n = nodeById[id];
            var (dx, dy) = _disp.TryGetValue(id, out var d) ? d : (0, 0);
            return new SKPoint((float)(n.X + dx * k), (float)(n.Y + dy * k));
        }

        using var paint = new SKPaint { Color = new SKColor(255, 255, 255, 150), StrokeWidth = px, IsStroke = true, IsAntialias = true };
        using var path = new SKPath();
        var edgeKeys = new HashSet<long>();
        foreach (var el in _model.FeElements)
        {
            if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
            for (int i = 0; i < 4; i++)
            {
                int a = el.NodeIds[i], b = el.NodeIds[(i + 1) % 4];
                long key = a < b ? (long)a << 32 | (uint)b : (long)b << 32 | (uint)a;
                if (!edgeKeys.Add(key)) continue;
                path.MoveTo(Def(a));
                path.LineTo(Def(b));
            }
        }
        foreach (var b in _model.FeBars)
        {
            path.MoveTo(Def(b.FeNodeId1));
            path.LineTo(Def(b.FeNodeId2));
        }
        canvas.DrawPath(path, paint);
    }
}
