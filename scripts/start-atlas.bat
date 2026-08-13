@echo off
REM Starts the Atlas document platform: the API (which also serves the UI)
REM and the background worker.
REM
REM PostgreSQL and Memurai (Redis) are already installed as Windows services
REM set to Automatic, so they come up on their own before this runs -- this
REM script only owns the two Node processes.
REM
REM Launched at logon by scripts\install-autostart.ps1. Run it by hand to
REM start everything without rebooting.

cd /d "%~dp0.."

REM This is the PRODUCTION entry point, so say so. Without it Node and Express
REM ran in development mode in the deployment the client actually uses --
REM slower routing, verbose error rendering, and, more to the point,
REM config/env.js only enforces its minimum secret length when NODE_ENV is
REM production. The one place that check matters most was the one place it
REM was switched off.
set NODE_ENV=production

REM Logs live beside the app rather than in %TEMP%, which Windows Disk Cleanup
REM empties -- losing exactly the history you want when asking "why did it
REM stop overnight?". Rotated on each start so they cannot grow without bound:
REM the previous run is kept as .1 and anything older is overwritten.
set LOGDIR=%~dp0..\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
if exist "%LOGDIR%\atlas-api.log"    move /y "%LOGDIR%\atlas-api.log"    "%LOGDIR%\atlas-api.1.log"    >nul
if exist "%LOGDIR%\atlas-worker.log" move /y "%LOGDIR%\atlas-worker.log" "%LOGDIR%\atlas-worker.1.log" >nul

REM Both are started detached and windowless -- the person using this should
REM never see a console, and closing one must not take the app down.
start "" /b /min cmd /c "cd backend && node src\server.js >> "%LOGDIR%\atlas-api.log" 2>&1"
start "" /b /min cmd /c "cd backend && node src\workers\runner.js >> "%LOGDIR%\atlas-worker.log" 2>&1"

echo Atlas starting. Open http://localhost:5000
echo Logs: %LOGDIR%\atlas-api.log and %LOGDIR%\atlas-worker.log
