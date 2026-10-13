@echo off
echo ========================================================
echo Starting RoadGuard AI Autonomous Driving Safety System...
echo ========================================================

set "CURRENT_DIR=%~dp0"
if exist "%CURRENT_DIR%RoadGuard_AI_Realtime_Website\.venv\Scripts\python.exe" (
    set "PY_EXE=%CURRENT_DIR%RoadGuard_AI_Realtime_Website\.venv\Scripts\python.exe"
) else (
    set "PY_EXE=python"
)

cd /d "%CURRENT_DIR%RoadGuard_AI_Realtime_Website"
"%PY_EXE%" app.py
pause
