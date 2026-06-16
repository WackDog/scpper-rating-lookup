@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo SCPper Rating Lookup - Setup
echo ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js was not found.
    echo.
    echo Please install Node.js 24 or newer from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
    echo ERROR: npm was not found.
    echo npm should be installed with Node.js.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%A in ('node -p "process.versions.node"') do set NODE_MAJOR=%%A

echo Detected Node.js:
node -v
echo.

if %NODE_MAJOR% LSS 24 (
    echo ERROR: Node.js 24 or newer is required.
    echo.
    echo Please install Node.js 24 or newer from:
    echo https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Setting npm registry to public npm...
npm config set registry https://registry.npmjs.org/
if errorlevel 1 (
    echo ERROR: Failed to set npm registry.
    pause
    exit /b 1
)

echo.
echo Installing dependencies...
npm install --registry=https://registry.npmjs.org/
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    echo.
    echo Try deleting node_modules and package-lock.json, then run setup again.
    echo If it still fails, send the error output to the maintainer.
    echo.
    pause
    exit /b 1
)

echo.
echo Creating desktop shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\SCPper Rating Lookup.lnk'); $Shortcut.TargetPath = '%~dp0Start SCPper Rating Lookup.bat'; $Shortcut.WorkingDirectory = '%~dp0'; $Shortcut.IconLocation = 'shell32.dll,220'; $Shortcut.Save();"

echo.
echo Setup complete.
echo.
echo You can now start the app by double-clicking:
echo Start SCPper Rating Lookup.bat
echo.
echo Or use the desktop shortcut:
echo SCPper Rating Lookup
echo.
pause
