using System.Windows;
using System.Windows.Controls;

namespace FeaApp;

/// <summary>
/// Small FEMAP-style command dialog built in code: labelled numeric fields and
/// checkboxes with OK/Cancel. Fields lay out on one line each - label on the left,
/// input box on the right, all boxes aligned in a column - so the dialog stays compact.
/// </summary>
public sealed class FormDialog : Window
{
    private readonly Dictionary<string, TextBox> _fields = new();
    private readonly Dictionary<string, CheckBox> _checks = new();
    private readonly Grid _grid;
    private int _row;

    public FormDialog(Window owner, string title)
    {
        Owner = owner;
        Title = title;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SizeToContent = SizeToContent.WidthAndHeight;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;

        // Column 0 = labels (sized to the widest label), column 1 = input boxes.
        _grid = new Grid { Margin = new Thickness(14), MinWidth = 300 };
        _grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        _grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });

        var buttons = new StackPanel
        {
            Orientation = Orientation.Horizontal,
            HorizontalAlignment = HorizontalAlignment.Right,
            Margin = new Thickness(14, 0, 14, 12)
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
        outer.Children.Add(_grid);
        outer.Children.Add(buttons);
        Content = outer;
    }

    // Add a row: when 'label' is null the input spans both columns (checkboxes, notes).
    private void AddRow(UIElement? label, UIElement input)
    {
        _grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        if (label is not null)
        {
            Grid.SetRow(label, _row);
            Grid.SetColumn(label, 0);
            _grid.Children.Add(label);
            Grid.SetColumn(input, 1);
        }
        else
        {
            Grid.SetColumn(input, 0);
            Grid.SetColumnSpan(input, 2);
        }
        Grid.SetRow(input, _row);
        _grid.Children.Add(input);
        _row++;
    }

    public FormDialog AddField(string key, string label, double initial)
        => AddField(key, label, initial.ToString("G10"));

    public FormDialog AddField(string key, string label, string initial)
    {
        var lbl = new TextBlock
        {
            Text = label,
            Margin = new Thickness(0, 3, 12, 3),
            VerticalAlignment = VerticalAlignment.Center,
            TextWrapping = TextWrapping.Wrap,
            MaxWidth = 230
        };
        var tb = new TextBox
        {
            Text = initial,
            MinWidth = 150,
            Margin = new Thickness(0, 3, 0, 3),
            VerticalAlignment = VerticalAlignment.Center
        };
        _fields[key] = tb;
        AddRow(lbl, tb);
        return this;
    }

    public FormDialog AddCheck(string key, string label, bool initial)
    {
        var cb = new CheckBox { Content = label, IsChecked = initial, Margin = new Thickness(0, 8, 0, 2) };
        _checks[key] = cb;
        AddRow(null, cb);
        return this;
    }

    public FormDialog AddNote(string text)
    {
        var note = new TextBlock
        {
            Text = text,
            TextWrapping = TextWrapping.Wrap,
            Foreground = System.Windows.Media.Brushes.Gray,
            Margin = new Thickness(0, 6, 0, 0),
            MaxWidth = 360
        };
        AddRow(null, note);
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
