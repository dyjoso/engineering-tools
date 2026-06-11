# FEA Membranes (native Windows app)

Native Windows 11 successor to the `tools/FEA-membranes` webtool, with a
FEMAP-style front end. Same model format, same element set (Q4 plane-stress
membranes, XY-decoupled springs, axial bars), but built for much larger models
and faster iteration.

## Workflow (FEMAP-style)

1. **Geometry > Surface by Corner Points…** (or *Surface by Picking* - 4 clicks
   on the canvas), **Edge Radius** to curve an edge (pick the edge, enter R;
   +ve convex / -ve concave).
2. **Mesh > Mesh Selected Surfaces…** - M x N structured Coons-patch mesh
   (arcs honoured). Select surfaces by click/box with *Select: Surfaces*.
3. **Model > Constraint / Load / Enforced Displacement** on selected nodes
   (*Select: Nodes*, click or box-select). **Create Bars Along Selected Nodes**
   chains bars along the dominant direction; springs join 2 selected nodes.
4. **Analyze > Solve** (F5) - contour auto-switches to Von Mises; pick SX/SY/SXY
   from the toolbar, toggle the deformed overlay.
5. **File > Save** writes the webtool-compatible .json.

Mouse: left click/drag = select (Ctrl adds), middle or right drag = pan,
wheel = zoom, F = fit, Esc = cancel/clear, Del = delete selection, Ctrl+Z = undo.
The Model Info tree mirrors the model; the Messages pane logs every command.

## Stack

| Layer     | Choice                          | Why |
|-----------|---------------------------------|-----|
| Language  | C# / .NET 8 (LTS)               | One language for UI + solver; ships as a single exe |
| UI        | WPF                             | Mature, stable Windows desktop framework |
| Rendering | SkiaSharp (`SKElement`)         | Immediate-mode 2D canvas (Chrome's renderer); handles 100k+ elements at 60 fps |
| Solver    | CSparse (NuGet)                 | Proven sparse LU/Cholesky, orders of magnitude faster than math.js |

## Layout

- `src/FeaCore` — model + solver class library (no UI dependencies)
  - `Model.cs` — data model, JSON load/save **compatible with the webtool's save format**
  - `Solver.cs` — Q4 plane stress (2x2 Gauss), bars, springs, direct-elimination BCs,
    reactions, element-centre stresses, orphan-node diagnostic
- `src/FeaApp` — WPF + SkiaSharp viewer/solver front-end
  - Open webtool `.json` models, pan (drag) / zoom (wheel) / fit, solve,
    von Mises / SX / SY / SXY colour maps, deformed-shape overlay, BC glyphs
- `tests/FeaCore.Tests` — xunit analytical verification (same cases as the
  webtool's headless harness): uniaxial quad, bar PL/EA, spring, enforced
  displacement, orphan diagnostic, 20x20 plate far-field, JSON round-trip

## Build & run

```
dotnet test                    # run analytical verification
dotnet run --project src/FeaApp
```

Publish a self-contained single exe:

```
dotnet publish src/FeaApp -c Release -r win-x64 --self-contained -p:PublishSingleFile=true
```

## Conventions (carried over from the webtool — do not "fix")

- World coordinates are **Y-down** (canvas convention; models treat bottom as larger Y).
- Springs are **XY-decoupled** (independent k in X and Y), NOT axial — intentional
  fastener/load-transfer idealisation. Bars are the axial elements.

## Roadmap

- [ ] Results tables + CSV export (spring/bar/reaction/displacement)
- [ ] Node-averaged stress smoothing
- [ ] Spring grids between surfaces (webtool's spring-group workflow)
- [ ] Triangular elements, pressure (edge) loading
- [ ] Node coordinate editing / dragging
- [ ] Larger element library (beams, plates) now that the editor exists
