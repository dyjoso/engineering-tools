using System.IO;
using System.Windows;
using System.Windows.Input;
using FeaCore;
using Microsoft.Win32;
using SkiaSharp;
using SkiaSharp.Views.Desktop;

namespace FeaApp;

public partial class MainWindow : Window
{
    private FeModel? _model;
    private SolveResult? _result;
    private readonly SceneRenderer _renderer = new();

    // View transform: screen = world * Scale + Offset. World is Y-down (webtool convention).
    private double _scale = 5.0;
    private SKPoint _offset = new(50, 50);
    private Point _lastMouse;
    private bool _panning;
    private bool _pendingFit;

    public MainWindow()
    {
        InitializeComponent();
        // Open a model passed on the command line (or via file association)
        var args = Environment.GetCommandLineArgs();
        if (args.Length > 1 && File.Exists(args[1]))
            Loaded += (_, _) => OpenModel(args[1]);
    }

    private void OpenModel(string path)
    {
        try
        {
            _model = FeModel.Load(path);
            _result = null;
            _renderer.SetModel(_model, null);
            BtnSolve.IsEnabled = true;
            _pendingFit = true; // canvas may not have a size yet; fit on next paint
            Canvas.InvalidateVisual();
            TxtStatus.Text = $"Loaded {Path.GetFileName(path)}: " +
                $"{_model.FeNodes.Count} FE nodes, {_model.FeElements.Count} elements, " +
                $"{_model.FeSprings.Count} springs, {_model.FeBars.Count} bars.";
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "Failed to load model", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    private void BtnOpen_Click(object sender, RoutedEventArgs e)
    {
        var dlg = new OpenFileDialog
        {
            Filter = "FEA model (*.json)|*.json|All files (*.*)|*.*",
            Title = "Open FEA-membranes model"
        };
        if (dlg.ShowDialog(this) != true) return;
        OpenModel(dlg.FileName);
    }

    private async void BtnSolve_Click(object sender, RoutedEventArgs e)
    {
        if (_model is null) return;
        BtnSolve.IsEnabled = false;
        TxtStatus.Text = "Solving…";
        try
        {
            var model = _model;
            _result = await Task.Run(() => Solver.Solve(model));
            _renderer.SetModel(_model, _result);
            TxtStatus.Text = $"Analysis complete: {_result.DofCount} DOF, {_result.NonZeros} non-zeros, " +
                $"{_result.ConstrainedDofs} constrained DOFs, {_result.Elapsed.TotalMilliseconds:F0} ms. " +
                $"Max |d| = {_result.Displacements.Max(d => Math.Max(Math.Abs(d.Dx), Math.Abs(d.Dy))):E3}.";
        }
        catch (Exception ex)
        {
            TxtStatus.Text = "Solve failed: " + ex.Message;
            MessageBox.Show(this, ex.Message, "Solve failed", MessageBoxButton.OK, MessageBoxImage.Error);
        }
        finally
        {
            BtnSolve.IsEnabled = _model is not null;
            Canvas.InvalidateVisual();
        }
    }

    private void BtnFit_Click(object sender, RoutedEventArgs e) => FitView();

    private void CmbView_SelectionChanged(object sender, System.Windows.Controls.SelectionChangedEventArgs e)
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

    private void FitView()
    {
        double sw = Canvas.CanvasSize.Width, sh = Canvas.CanvasSize.Height;
        if (sw <= 0 || sh <= 0) { _pendingFit = true; Canvas.InvalidateVisual(); return; }
        FitToRect(sw, sh);
        Canvas.InvalidateVisual();
    }

    private void FitToRect(double sw, double sh)
    {
        if (_model is null || _model.FeNodes.Count == 0 && _model.Nodes.Count == 0) return;
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

    private void Canvas_PaintSurface(object sender, SKPaintSurfaceEventArgs e)
    {
        var canvas = e.Surface.Canvas;
        canvas.Clear(new SKColor(0xF0, 0xF0, 0xF0));
        if (_model is null) return;
        if (_pendingFit && e.Info.Width > 0)
        {
            _pendingFit = false;
            FitToRect(e.Info.Width, e.Info.Height);
        }
        _renderer.Render(canvas, (float)_scale, _offset, e.Info.Width, e.Info.Height);
    }

    private void Canvas_MouseWheel(object sender, MouseWheelEventArgs e)
    {
        var p = ScreenPoint(e.GetPosition(Canvas));
        double factor = e.Delta > 0 ? 1.1 : 1 / 1.1;
        double newScale = Math.Clamp(_scale * factor, 1e-3, 1e5);
        // Zoom about cursor
        _offset = new SKPoint(
            (float)(p.X - (p.X - _offset.X) * (newScale / _scale)),
            (float)(p.Y - (p.Y - _offset.Y) * (newScale / _scale)));
        _scale = newScale;
        Canvas.InvalidateVisual();
    }

    private void Canvas_MouseDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton is MouseButton.Left or MouseButton.Middle)
        {
            _panning = true;
            _lastMouse = e.GetPosition(Canvas);
            Canvas.CaptureMouse();
        }
    }

    private void Canvas_MouseMove(object sender, MouseEventArgs e)
    {
        var pos = e.GetPosition(Canvas);
        var sp = ScreenPoint(pos);
        double wx = (sp.X - _offset.X) / _scale, wy = (sp.Y - _offset.Y) / _scale;
        TxtCoords.Text = $"x: {wx:F2}  y: {wy:F2}";

        if (!_panning) return;
        var dpi = Canvas.CanvasSize.Width / Math.Max(Canvas.ActualWidth, 1);
        _offset = new SKPoint(
            _offset.X + (float)((pos.X - _lastMouse.X) * dpi),
            _offset.Y + (float)((pos.Y - _lastMouse.Y) * dpi));
        _lastMouse = pos;
        Canvas.InvalidateVisual();
    }

    private void Canvas_MouseUp(object sender, MouseButtonEventArgs e)
    {
        _panning = false;
        Canvas.ReleaseMouseCapture();
    }

    /// <summary>WPF DIP position -> Skia surface pixels (handles display scaling).</summary>
    private SKPoint ScreenPoint(Point p)
    {
        double dpi = Canvas.CanvasSize.Width / Math.Max(Canvas.ActualWidth, 1);
        return new SKPoint((float)(p.X * dpi), (float)(p.Y * dpi));
    }
}
