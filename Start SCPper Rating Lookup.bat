@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo SCPper Rating Lookup
echo ==========================================
echo.

echo Checking npm...
where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found.
    echo Please run Setup SCPper Rating Lookup.bat first,
    echo or install Node.js 24 from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Starting local app...
echo.
echo Keep this window open while using the tool.
echo To stop the app, press Ctrl+C, then Y.
echo.

call npm start

echo.
echo App stopped.
pause
