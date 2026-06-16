@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo SCPper Rating Lookup - Setup
echo ==========================================
echo.

echo Checking Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: Node.js was not found.
    echo Please install Node.js 24 from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Checking npm...
where npm >nul 2>nul
if errorlevel 1 (
    echo.
    echo ERROR: npm was not found.
    echo npm should be installed with Node.js.
    echo.
    pause
    exit /b 1
)

echo.
echo Node version:
node -v

echo.
echo npm version:
call npm -v

echo.
echo Checking Node is version 24 or newer...
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
    echo.
    echo ERROR: Node.js 24 or newer is required.
    echo Your version is:
    node -v
    echo.
    pause
    exit /b 1
)

echo.
echo Setting npm registry to public npm...
call npm config set registry https://registry.npmjs.org/
if errorlevel 1 (
    echo.
    echo ERROR: Failed to set npm registry.
    echo.
    pause
    exit /b 1
)

echo.
echo Installing dependencies...
call npm install --registry=https://registry.npmjs.org/
if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    echo.
    echo Try deleting node_modules and package-lock.json, then run setup again.
    echo.
    pause
    exit /b 1
)

echo.
echo Creating desktop shortcut...
set "SCPPER_TARGET=%~dp0Start SCPper Rating Lookup.bat"
set "SCPPER_WORKDIR=%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$desktop=[Environment]::GetFolderPath('Desktop'); $shell=New-Object -ComObject WScript.Shell; $shortcut=$shell.CreateShortcut((Join-Path $desktop 'SCPper Rating Lookup.lnk')); $shortcut.TargetPath=$env:SCPPER_TARGET; $shortcut.WorkingDirectory=$env:SCPPER_WORKDIR; $shortcut.Save()"
if errorlevel 1 (
    echo.
    echo WARNING: Setup worked, but the desktop shortcut could not be created.
    echo You can still use Start SCPper Rating Lookup.bat directly.
    echo.
) else (
    echo.
    echo Desktop shortcut created: SCPper Rating Lookup
    echo.
)

echo ==========================================
echo Setup complete.
echo ==========================================
echo.
echo You can now start the app from the desktop shortcut,
echo or by double-clicking Start SCPper Rating Lookup.bat.
echo.
pause
exit /b 0
