using FeaCore;
using SkiaSharp;

namespace FeaApp;

public enum StressView { None, VonMises, Sxx, Syy, Sxy }

/// <summary>
/// Immediate-mode renderer. All geometry is drawn each frame from pre-built flat arrays
/// (deduplicated mesh edges, node positions, stress polys) - the same batching strategy
/// that fixed the webtool's canvas performance, but here Skia comfortably handles far
/// larger models. Line widths and markers are constant screen-size (divided by scale).
/// </summary>
public sealed class SceneRenderer
{
    private FeModel? _model;
    private SolveResult? _result;

    // Pre-built render data
    private float[] _edges = [];          // 4 floats per deduped mesh edge
    private SKPoint[] _feNodePts = [];
    private (SKPoint a, SKPoint b)[] _springs = [];
    private (SKPoint a, SKPoint b)[] _bars = [];
    private (SKPoint[] pts, double vm, double sx, double sy, double sxy)[] _stressPolys = [];
    private Dictionary<int, (double dx, double dy)> _disp = new();

    public StressView StressView { get; set; } = StressView.None;
    public bool ShowDeformed { get; set; }

    public void SetModel(FeModel? model, SolveResult? result)
    {
        _model = model;
        _result = result;
        Rebuild();
    }

    private void Rebuild()
    {
        if (_model is null) { _edges = []; _feNodePts = []; _springs = []; _bars = []; _stressPolys = []; return; }
        var nodeById = _model.FeNodes.ToDictionary(n => n.Id);
        var hidden = _model.Membranes.Where(m => !m.Visible).Select(m => m.Id).ToHashSet();

        var edgeKeys = new HashSet<long>();
        var edges = new List<float>(_model.FeElements.Count * 8);
        foreach (var el in _model.FeElements)
        {
            if (el.MembraneId is { } mid && hidden.Contains(mid)) continue;
            if (el.Type != "quad" || el.NodeIds.Count != 4) continue;
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

        _feNodePts = _model.FeNodes
            .Where(n => n.MembraneId is not { } mid || !hidden.Contains(mid))
            .Select(n => new SKPoint((float)n.X, (float)n.Y)).ToArray();

        _springs = _model.FeSprings
            .Where(s => nodeById.ContainsKey(s.FeNodeId1) && nodeById.ContainsKey(s.FeNodeId2))
            .Select(s =>
            {
                var a = nodeById[s.FeNodeId1]; var b = nodeById[s.FeNodeId2];
                return (new SKPoint((float)a.X, (float)a.Y), new SKPoint((float)b.X, (float)b.Y));
            }).ToArray();

        _bars = _model.FeBars
            .Where(b => nodeById.ContainsKey(b.FeNodeId1) && nodeById.ContainsKey(b.FeNodeId2))
            .Select(b =>
            {
                var a = nodeById[b.FeNodeId1]; var c = nodeById[b.FeNodeId2];
                return (new SKPoint((float)a.X, (float)a.Y), new SKPoint((float)c.X, (float)c.Y));
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
        }
        else _stressPolys = [];
    }

    public void Render(SKCanvas canvas, float scale, SKPoint offset, int width, int height)
    {
        if (_model is null) return;
        canvas.Save();
        canvas.Translate(offset.X, offset.Y);
        canvas.Scale(scale);
        float px = 1f / scale; // one screen pixel in world units

        DrawGrid(canvas, scale, offset, width, height, px);

        // Stress fills under everything else
        if (StressView != StressView.None && _stressPolys.Length > 0)
            DrawStress(canvas);

        using var meshPaint = new SKPaint { Color = new SKColor(0x64, 0x74, 0x8B), StrokeWidth = px, IsStroke = true, IsAntialias = true };
        if (_edges.Length > 0)
        {
            using var path = new SKPath();
            for (int i = 0; i < _edges.Length; i += 4)
            {
                path.MoveTo(_edges[i], _edges[i + 1]);
                path.LineTo(_edges[i + 2], _edges[i + 3]);
            }
            canvas.DrawPath(path, meshPaint);
        }

        using var nodePaint = new SKPaint { Color = new SKColor(0x16, 0xA3, 0x4A), IsAntialias = true };
        float r = 2f * px;
        foreach (var p in _feNodePts)
            canvas.DrawCircle(p, r, nodePaint);

        using var springPaint = new SKPaint
        {
            Color = new SKColor(0x7C, 0x3A, 0xED), StrokeWidth = 1.5f * px, IsStroke = true, IsAntialias = true,
            PathEffect = SKPathEffect.CreateDash(new[] { 8 * px, 4 * px }, 0)
        };
        foreach (var (a, b) in _springs)
            canvas.DrawLine(a, b, springPaint);

        using var barPaint = new SKPaint { Color = new SKColor(0xB4, 0x53, 0x09), StrokeWidth = 2.5f * px, IsStroke = true, IsAntialias = true };
        foreach (var (a, b) in _bars)
            canvas.DrawLine(a, b, barPaint);

        DrawBcGlyphs(canvas, px);

        if (ShowDeformed && _disp.Count > 0)
            DrawDeformed(canvas, px);

        canvas.Restore();
    }

    private void DrawGrid(SKCanvas canvas, float scale, SKPoint offset, int width, int height, float px)
    {
        // Visible world rect
        float wx0 = -offset.X / scale, wy0 = -offset.Y / scale;
        float wx1 = (width - offset.X) / scale, wy1 = (height - offset.Y) / scale;
        double raw = 80.0 / scale;
        double mag = Math.Pow(10, Math.Floor(Math.Log10(raw)));
        double norm = raw / mag;
        double step = norm <= 1 ? mag : norm <= 2 ? 2 * mag : norm <= 5 ? 5 * mag : 10 * mag;

        using var grid = new SKPaint { Color = new SKColor(0xE2, 0xE8, 0xF0), StrokeWidth = px, IsStroke = true };
        using var axis = new SKPaint { Color = new SKColor(0x94, 0xA3, 0xB8), StrokeWidth = 1.5f * px, IsStroke = true };
        using var text = new SKPaint { Color = new SKColor(0x9C, 0xA3, 0xAF), IsAntialias = true };
        using var font = new SKFont(SKTypeface.Default, 10 * px);

        for (double gx = Math.Ceiling(wx0 / step) * step; gx <= wx1; gx += step)
        {
            canvas.DrawLine((float)gx, wy0, (float)gx, wy1, Math.Abs(gx) < step / 2 ? axis : grid);
            canvas.DrawText($"{gx:0.######}", (float)gx + 2 * px, wy0 + 12 * px, font, text);
        }
        for (double gy = Math.Ceiling(wy0 / step) * step; gy <= wy1; gy += step)
        {
            canvas.DrawLine(wx0, (float)gy, wx1, (float)gy, Math.Abs(gy) < step / 2 ? axis : grid);
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
        double min = _stressPolys.Min(value), max = _stressPolys.Max(value);
        if (max <= min) max = min + (min == 0 ? 1 : Math.Abs(min) * 1e-4);

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

    /// <summary>Blue -> cyan -> green -> yellow -> red, matching the webtool's HSL ramp.</summary>
    private static SKColor ColorMap(float t)
    {
        float hue = 240f * (1f - Math.Clamp(t, 0f, 1f));
        return SKColor.FromHsl(hue, 100f, 50f);
    }

    private void DrawBcGlyphs(SKCanvas canvas, float px)
    {
        if (_model is null) return;
        float size = 8 * px, off = 2 * px + 2 * px + size / 2;
        using var black = new SKPaint { Color = SKColors.Black, IsAntialias = true };
        using var red = new SKPaint { Color = SKColors.Red, StrokeWidth = px, IsAntialias = true };
        using var green = new SKPaint { Color = SKColors.Green, StrokeWidth = px, IsAntialias = true };

        foreach (var n in _model.FeNodes)
        {
            if (n.Bc is null) continue;
            float x = (float)n.X, y = (float)n.Y;
            if (n.Bc.Type == "fixed")
            {
                if (n.Bc.Value.FixX) Triangle(canvas, x - off, y, 0, size, black);
                if (n.Bc.Value.FixY) Triangle(canvas, x, y + off, -MathF.PI / 2, size, black);
            }
            else if (n.Bc.Type is "load" or "enforced")
            {
                var paint = n.Bc.Type == "load" ? red : green;
                double? vx = n.Bc.Type == "load" ? n.Bc.Value.Fx : n.Bc.Value.Dx;
                double? vy = n.Bc.Type == "load" ? n.Bc.Value.Fy : n.Bc.Value.Dy;
                if (vx is { } fx && fx != 0) Arrow(canvas, x, y, MathF.Sign((float)fx), 0, off, size, paint, px);
                if (vy is { } fy && fy != 0) Arrow(canvas, x, y, 0, MathF.Sign((float)fy), off, size, paint, px);
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
        float x1 = x + dirX * off / 1.5f, y1 = y + dirY * off / 1.5f;
        float x2 = x + dirX * (off + size), y2 = y + dirY * (off + size);
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
    }

    private void DrawDeformed(SKCanvas canvas, float px)
    {
        if (_model is null || _result is null) return;
        // Auto scale: 10% of model size at max displacement
        double maxD = _result.Displacements.Max(d => Math.Max(Math.Abs(d.Dx), Math.Abs(d.Dy)));
        if (maxD <= 0) return;
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

        using var paint = new SKPaint { Color = new SKColor(255, 0, 0, 180), StrokeWidth = px, IsStroke = true, IsAntialias = true };
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
