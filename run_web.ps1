Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "Starting RoadGuard AI Autonomous Driving Safety System..." -ForegroundColor Green
Write-Host "========================================================" -ForegroundColor Cyan

$scriptRoot = $PSScriptRoot
if (-not $scriptRoot) { $scriptRoot = Get-Location }

$venvPython = Join-Path $scriptRoot "RoadGuard_AI_Realtime_Website\.venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    $venvPython = "python"
}

$targetDir = Join-Path $scriptRoot "RoadGuard_AI_Realtime_Website"
Set-Location $targetDir
& $venvPython app.py
