using System.IO;
using System.Windows;
using FeaCore;
using SkiaSharp;

namespace FeaApp;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        // Headless batch rendering:
        //   FeaMembranes.exe --render model.json out.png [--contour vm|sx|sy|sxy|none]
        //                    [--deformed] [--vectors springs|reactions|both]
        //                    [--no-solve] [--width N] [--height N]
        // Solves (when the model has BCs) and writes the PNG without showing a window.
        if (e.Args.Length >= 3 && e.Args[0] == "--render")
        {
            int code = 0;
            try
            {
                HeadlessRender(e.Args);
            }
            catch (Exception ex)
            {
                try { File.WriteAllText(e.Args[2] + ".err.txt", ex.ToString()); } catch { /* best effort */ }
                code = 1;
            }
            Shutdown(code);
            return;
        }

        new MainWindow().Show();
    }

    private static void HeadlessRender(string[] args)
    {
        string modelPath = args[1];
        string outPath = args[2];
        var opts = args.Skip(3).ToArray();
        string OptVal(string name, string fallback)
        {
            int i = Array.IndexOf(opts, name);
            return i >= 0 && i + 1 < opts.Length ? opts[i + 1] : fallback;
        }
        bool Has(string name) => opts.Contains(name);

        var model = FeModel.Load(modelPath);
        SolveResult? result = null;
        bool wantSolve = !Has("--no-solve") && model.FeNodes.Any(n => n.Bc is not null);
        if (wantSolve)
        {
            try { result = Solver.Solve(model); }
            catch { result = null; } // render the unsolved model rather than fail
        }

        var renderer = new SceneRenderer
        {
            StressView = result is null ? StressView.None : OptVal("--contour", "vm") switch
            {
                "sx" => StressView.Sxx,
                "sy" => StressView.Syy,
                "sxy" => StressView.Sxy,
                "none" => StressView.None,
                _ => StressView.VonMises
            },
            ShowDeformed = Has("--deformed") && result is not null,
            ShowFeNodes = !Has("--no-nodes"),
            ShowLabels = !Has("--no-labels"),
            ContourCap = double.TryParse(OptVal("--cmax", ""), System.Globalization.CultureInfo.InvariantCulture, out var cap) ? cap : null,
            VectorPlot = result is null ? VectorPlot.None : OptVal("--vectors", "none") switch
            {
                "springs" => VectorPlot.SpringForces,
                "reactions" => VectorPlot.Reactions,
                "both" => VectorPlot.Both,
                _ => VectorPlot.None
            }
        };
        renderer.SetModel(model, result);

        int width = int.TryParse(OptVal("--width", "1600"), out var w) ? w : 1600;
        int height = int.TryParse(OptVal("--height", "1000"), out var h) ? h : 1000;

        // View transform: fit to model, or --zoom cx cy halfWidth for a close-up
        float scale;
        SKPoint offset;
        int zi = Array.IndexOf(opts, "--zoom");
        if (zi >= 0 && zi + 3 < opts.Length &&
            double.TryParse(opts[zi + 1], System.Globalization.CultureInfo.InvariantCulture, out var zx) &&
            double.TryParse(opts[zi + 2], System.Globalization.CultureInfo.InvariantCulture, out var zy) &&
            double.TryParse(opts[zi + 3], System.Globalization.CultureInfo.InvariantCulture, out var zhw) && zhw > 0)
        {
            scale = (float)(width / (2 * zhw));
            offset = new SKPoint((float)(width / 2.0 - zx * scale), (float)(height / 2.0 - zy * scale));
        }
        else
        {
            double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
            double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
            foreach (var n in model.FeNodes) { minX = Math.Min(minX, n.X); maxX = Math.Max(maxX, n.X); minY = Math.Min(minY, n.Y); maxY = Math.Max(maxY, n.Y); }
            foreach (var n in model.Nodes) { minX = Math.Min(minX, n.X); maxX = Math.Max(maxX, n.X); minY = Math.Min(minY, n.Y); maxY = Math.Max(maxY, n.Y); }
            if (!double.IsFinite(minX)) throw new InvalidOperationException("Model is empty.");
            double bw = Math.Max(maxX - minX, 1e-6), bh = Math.Max(maxY - minY, 1e-6);
            scale = (float)(0.85 * Math.Min(width / bw, height / bh));
            offset = new SKPoint(
                (float)(width / 2.0 - (minX + maxX) / 2 * scale),
                (float)(height / 2.0 - (minY + maxY) / 2 * scale));
        }

        using var surface = SKSurface.Create(new SKImageInfo(width, height));
        renderer.Render(surface.Canvas, scale, offset, width, height);
        using var image = surface.Snapshot();
        using var data = image.Encode(SKEncodedImageFormat.Png, 95);
        using var fs = File.Create(outPath);
        data.SaveTo(fs);
    }
}
