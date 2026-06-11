using System.Windows;
using System.Windows.Controls;

namespace FeaApp;

/// <summary>
/// Small FEMAP-style command dialog built in code: labelled numeric fields and
/// checkboxes with OK/Cancel. Keeps each command's UI to a few lines at the call site.
/// </summary>
public sealed class FormDialog : Window
{
    private readonly Dictionary<string, TextBox> _fields = new();
    private readonly Dictionary<string, CheckBox> _checks = new();
    private readonly StackPanel _panel;

    public FormDialog(Window owner, string title)
    {
        Owner = owner;
        Title = title;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;

        _panel = new StackPanel { Margin = new Thickness(14), MinWidth = 260 };

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(0, 12, 0, 0)
        };
        var ok = new Button { Content = "OK", Width = 80, Margin = new Thickness(0, 0, 8, 0), IsDefault = true };
        var cancel = new Button { Content = "Cancel", Width = 80, IsCancel = true };
        ok.Click += (_, _) =>
        {
            // validate all numeric fields before accepting (a closed dialog cannot be reshown)
            try
            {
                foreach (var key in _fields.Keys) NumOrNull(key);
            }
            catch (FormatException ex)
            {
                MessageBox.Show(this, ex.Message, "Invalid input", MessageBoxButton.OK, MessageBoxImage.Warning);
                return;
            }
            DialogResult = true;
        };
        buttons.Children.Add(ok);
        buttons.Children.Add(cancel);

        var outer = new StackPanel();
        outer.Children.Add(_panel);
        outer.Children.Add(buttons);
        ((StackPanel)outer.Children[1]).Margin = new Thickness(14, 0, 14, 12);
        Content = outer;
    }

    public FormDialog AddField(string key, string label, double initial)
        => AddField(key, label, initial.ToString("G10"));

    public FormDialog AddField(string key, string label, string initial)
    {
        _panel.Children.Add(new TextBlock { Text = label, Margin = new Thickness(0, 6, 0, 2) });
        var tb = new TextBox { Text = initial };
        _fields[key] = tb;
        _panel.Children.Add(tb);
        return this;
    }

    public FormDialog AddCheck(string key, string label, bool initial)
    {
        var cb = new CheckBox { Content = label, IsChecked = initial, Margin = new Thickness(0, 8, 0, 0) };
        _checks[key] = cb;
        _panel.Children.Add(cb);
        return this;
    }

    public FormDialog AddNote(string text)
    {
        _panel.Children.Add(new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            Foreground = System.Windows.Media.Brushes.Gray,
            Margin = new Thickness(0, 6, 0, 0),
            MaxWidth = 280
        });
        return this;
    }

    public double Num(string key)
    {
        var text = _fields[key].Text.Trim();
        if (!double.TryParse(text, System.Globalization.CultureInfo.InvariantCulture, out var v))
            throw new FormatException($"'{text}' is not a number.");
        return v;
    }

    /// <summary>Numeric field that may be left blank (returns null).</summary>
    public double? NumOrNull(string key)
    {
        var text = _fields[key].Text.Trim();
        return text.Length == 0 ? null : Num(key);
    }

    public bool Check(string key) => _checks[key].IsChecked == true;

    /// <summary>Show modally; returns true only when OK is pressed with valid numeric input.</summary>
    public bool Run() => ShowDialog() == true;
}
