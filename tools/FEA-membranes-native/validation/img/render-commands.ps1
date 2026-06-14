# Regenerates the validation-manual figures from the benchmark models.
# Run from the validation/ folder. Requires the app built (dotnet build) and
# DOTNET_ROOT pointing at the user-local .NET SDK.
$exe = "..\src\FeaApp\bin\Debug\net8.0-windows\FeaMembranes.exe"
$env:DOTNET_ROOT = "$env:USERPROFILE\.dotnet"

function Render($model, $out, $opts) {
    Start-Process -FilePath $exe -Wait -WindowStyle Hidden `
        -ArgumentList (@("--render", "`"$model`"", "`"img\$out`"") + $opts)
    if (Test-Path "img\$out") { "OK   $out" } else { "FAIL $out" }
}

Render "macneal-rectangular.json"      "macneal-rectangular.png"      @("--contour","none","--deformed","--width","1800","--height","400")
Render "macneal-trapezoid-30.json"     "macneal-trapezoid-30.png"     @("--contour","none","--deformed","--width","1800","--height","400")
Render "macneal-trapezoid-45.json"     "macneal-trapezoid-45.png"     @("--contour","none","--deformed","--width","1800","--height","400")
Render "macneal-parallelogram-30.json" "macneal-parallelogram-30.png" @("--contour","none","--deformed","--width","1800","--height","400")
Render "macneal-parallelogram-45.json" "macneal-parallelogram-45.png" @("--contour","none","--deformed","--width","1800","--height","400")
Render "crack-sent-benchmark.json"     "crack-sent-vm.png"            @("--contour","vm","--no-nodes","--cmax","400","--width","1100","--height","1500")
Render "crack-sent-benchmark.json"     "crack-sent-tip-zoom.png"      @("--contour","vm","--no-nodes","--cmax","600","--zoom","3","0","2.2","--width","1400","--height","1000")
Render "crack-cct-benchmark.json"      "crack-cct-vm.png"             @("--contour","vm","--no-nodes","--cmax","400","--width","1100","--height","1500")
Render "crack-cct-benchmark.json"      "crack-cct-tip-zoom.png"       @("--contour","vm","--no-nodes","--cmax","600","--zoom","14","0","3","--width","1400","--height","1000")
Render "stringer-load-transfer.json"   "stringer-springs.png"         @("--contour","none","--vectors","springs","--width","1400","--height","1200")
Copy-Item "..\samples\curved-plate-with-bars.json" ".\curved-plate-with-bars.json" -Force
Render "curved-plate-with-bars.json"   "curved-plate-vm.png"          @("--contour","vm","--width","1600","--height","1000")
Remove-Item ".\curved-plate-with-bars.json" -Force

# External standard benchmarks (NAFEMS LE1, SFM/AFNOR SSLP01/02, SSLL11) at spec mesh density
Render "ext-nafems-le1.json"           "ext-le1-vm.png"               @("--contour","vm","--width","1100","--height","1000")
Render "ext-sslp01.json"               "ext-sslp01-vm.png"            @("--contour","vm","--deformed","--width","1500","--height","600")
Render "ext-sslp02.json"               "ext-sslp02-vm.png"            @("--contour","vm","--no-nodes","--cmax","80","--width","1100","--height","1100")
Render "ext-ssll11.json"               "ext-ssll11.png"               @("--contour","none","--width","1000","--height","800")
