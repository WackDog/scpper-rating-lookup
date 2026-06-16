@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo SCPper Rating Lookup
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found.
    echo Please install Node.js 24 or newer, then run setup again.
    echo.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo Dependencies are not installed yet.
    echo.
    echo Please run:
    echo Setup SCPper Rating Lookup.bat
    echo.
    pause
    exit /b 1
)

echo Starting local app...
echo.
echo Keep this window open while using the tool.
echo To stop the app, press Ctrl+C, then Y.
echo.

start "" "http://127.0.0.1:3000"
npm start

echo.
echo App stopped.
pause
