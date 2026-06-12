using System.Text.Json;
using System.Text.Json.Serialization;

namespace FeaCore;

// Data model mirrors the FEA-membranes webtool save format (buildSaveData in index.html)
// so .json models move freely between the two tools. Coordinates are Y-down, matching
// the webtool's canvas convention.

public sealed class BoundaryCondition
{
    public string Type { get; set; } = "";          // "fixed" | "load" | "enforced"
    public BcValue Value { get; set; } = new();
}

public sealed class BcValue
{
    public bool FixX { get; set; }
    public bool FixY { get; set; }
    public double? Fx { get; set; }
    public double? Fy { get; set; }
    public double? Dx { get; set; }
    public double? Dy { get; set; }
}

public sealed class GeometryNode
{
    public int Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
}

/// <summary>
/// Free-standing geometry marker used only to define spring elements (never part of
/// a surface). A spring is created at a spring point when exactly two visible FE
/// nodes lie within the coincidence range.
/// </summary>
public sealed class SpringPoint
{
    public int Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
}

public sealed class Membrane
{
    public int Id { get; set; }
    public List<int> NodeIds { get; set; } = new();
    public double MaterialE { get; set; } = 10.5e6;
    public double MaterialNu { get; set; } = 0.33;
    public double MaterialT { get; set; } = 0.05;
    public List<double> EdgeRadii { get; set; } = new() { 0, 0, 0, 0 };
    public bool Visible { get; set; } = true;
    // Last mesh divisions - extra fields the webtool ignores; lets the native app
    // re-mesh automatically when a corner point moves.
    public int? MeshM { get; set; }
    public int? MeshN { get; set; }
    public bool MeshQuadratic { get; set; } // last mesh used quad8 elements
}

public sealed class FeNode
{
    public int Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public int? MembraneId { get; set; }
    public BoundaryCondition? Bc { get; set; }
    public bool IsSpringConnectionPoint { get; set; }
}

public sealed class FeElement
{
    public int Id { get; set; }
    public string Type { get; set; } = "quad";
    public List<int> NodeIds { get; set; } = new();
    public int? MembraneId { get; set; }
    public double? PropE { get; set; }
    public double? PropNu { get; set; }
    public double? PropT { get; set; }
}

public sealed class FeSpring
{
    public int Id { get; set; }
    public int FeNodeId1 { get; set; }
    public int FeNodeId2 { get; set; }
    public double Stiffness { get; set; }
}

public sealed class FeBar
{
    public int Id { get; set; }
    public int FeNodeId1 { get; set; }
    public int FeNodeId2 { get; set; }
    public double E { get; set; }
    public double A { get; set; }
}

/// <summary>
/// Nastran-style RBE2 rigid element (translational): the dependent nodes' selected
/// DOFs are tied to the independent node's DOFs (membrane model - no rotational
/// coupling). Enforced as an exact multipoint constraint, not a penalty.
/// </summary>
public sealed class Rbe2
{
    public int Id { get; set; }
    public int IndependentNodeId { get; set; }
    public List<int> DependentNodeIds { get; set; } = new();
    public bool TieX { get; set; } = true;
    public bool TieY { get; set; } = true;
}

public sealed class FeModel
{
    public List<GeometryNode> Nodes { get; set; } = new();
    public List<Membrane> Membranes { get; set; } = new();
    public List<SpringPoint> SpringPoints { get; set; } = new(); // extra field; webtool ignores it
    public List<FeNode> FeNodes { get; set; } = new();
    public List<FeElement> FeElements { get; set; } = new();
    public List<FeSpring> FeSprings { get; set; } = new();
    public List<FeBar> FeBars { get; set; } = new();
    public List<Rbe2> Rbe2s { get; set; } = new(); // extra field; webtool ignores it

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true
    };

    public static FeModel Load(string path) => FromJson(File.ReadAllText(path));

    public static FeModel FromJson(string json)
    {
        var model = JsonSerializer.Deserialize<FeModel>(json, JsonOpts)
            ?? throw new InvalidDataException("Model JSON deserialized to null.");
        model.Validate();
        return model;
    }

    public string ToJson() => JsonSerializer.Serialize(this, JsonOpts);

    public void Save(string path) => File.WriteAllText(path, ToJson());

    public void Validate()
    {
        var nodeIds = new HashSet<int>(FeNodes.Select(n => n.Id));
        foreach (var el in FeElements)
        {
            if (el.Type == "quad" && el.NodeIds.Count != 4)
                throw new InvalidDataException($"Element {el.Id} is a quad with {el.NodeIds.Count} nodes.");
            if (el.Type == "quad8" && el.NodeIds.Count != 8)
                throw new InvalidDataException($"Element {el.Id} is a quad8 with {el.NodeIds.Count} nodes.");
            foreach (var nid in el.NodeIds)
                if (!nodeIds.Contains(nid))
                    throw new InvalidDataException($"Element {el.Id} references missing FE node {nid}.");
        }
        foreach (var s in FeSprings)
            if (!nodeIds.Contains(s.FeNodeId1) || !nodeIds.Contains(s.FeNodeId2))
                throw new InvalidDataException($"Spring {s.Id} references a missing FE node.");
        foreach (var b in FeBars)
            if (!nodeIds.Contains(b.FeNodeId1) || !nodeIds.Contains(b.FeNodeId2))
                throw new InvalidDataException($"Bar {b.Id} references a missing FE node.");
        foreach (var r in Rbe2s)
        {
            if (!nodeIds.Contains(r.IndependentNodeId))
                throw new InvalidDataException($"RBE2 {r.Id} references missing independent node {r.IndependentNodeId}.");
            foreach (var d in r.DependentNodeIds)
                if (!nodeIds.Contains(d))
                    throw new InvalidDataException($"RBE2 {r.Id} references missing dependent node {d}.");
            if (!r.TieX && !r.TieY)
                throw new InvalidDataException($"RBE2 {r.Id} ties no DOFs.");
        }
    }
}
