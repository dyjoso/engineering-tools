using FeaCore;
using System.Text.Json;

// Headless K runner for the bridged cracked-stringer model.
//   FeaSweep <model.json> [--spring-scale <s>]
// --spring-scale 0  => fasteners removed (unbridged); 1 => as-saved (bridged).
// Emits one JSON line with the crack SIFs and fastener load totals.

if (args.Length < 1)
{
    Console.Error.WriteLine("usage: FeaSweep <model.json> [--spring-scale <s>]");
    return 2;
}

string path = args[0];
double springScale = 1.0;
for (int i = 1; i < args.Length; i++)
    if (args[i] == "--spring-scale" && i + 1 < args.Length) springScale = double.Parse(args[++i]);

var model = FeModel.Load(path);
if (springScale != 1.0)
    foreach (var s in model.FeSprings) s.Stiffness *= springScale;

var r = Solver.Solve(model);

var sifs = r.CrackSifs.Select(s => new
{
    s.CrackId,
    s.TipNodeId,
    s.K1,
    s.K2,
    s.K1Dct,
    s.K2Dct,
    s.FaceElementLength,
    s.DomainElements
}).ToList();

Console.WriteLine(JsonSerializer.Serialize(new
{
    path,
    springScale,
    nSprings = model.FeSprings.Count,
    dof = r.DofCount,
    elapsedMs = Math.Round(r.Elapsed.TotalMilliseconds),
    sifs,
    sumAbsSpringFx = r.SpringLoads.Sum(s => Math.Abs(s.Fx)),
    sumAbsSpringFy = r.SpringLoads.Sum(s => Math.Abs(s.Fy)),
    springFy = r.SpringLoads.Select(s => Math.Round(s.Fy, 4))
}));
return 0;
