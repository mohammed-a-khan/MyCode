@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node was not found. Install Node 22.13 or newer on this build machine, then run this again.
  pause
  exit /b 1
)
node --experimental-strip-types --no-warnings tools\package.ts %*
if errorlevel 1 (
  echo.
  echo The build did not finish.
  pause
  exit /b 1
)
echo.
pause
