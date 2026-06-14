@echo off
rem Launches the native FEA Membranes app (C#/WPF).
rem The .NET runtime is installed per-user at %USERPROFILE%\.dotnet, so the
rem app host needs DOTNET_ROOT set to find it.

set "DOTNET_ROOT=%USERPROFILE%\.dotnet"
set "EXE=%~dp0src\FeaApp\bin\Debug\net8.0-windows\FeaMembranes.exe"

if not exist "%EXE%" (
    echo Build not found: %EXE%
    echo Run "dotnet build" in %~dp0 first.
    pause
    exit /b 1
)

start "" "%EXE%"
