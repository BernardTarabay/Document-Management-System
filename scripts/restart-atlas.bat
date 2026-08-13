@echo off
REM Applies code changes: stops Atlas, optionally rebuilds the UI, starts it
REM again.
REM
REM Node reads a source file once at startup, so editing backend code does
REM nothing until the API and worker processes are replaced. The frontend is
REM served as a static build out of frontend\dist, so editing UI code does
REM nothing until it is rebuilt.
REM
REM   restart-atlas.bat          restart the two node processes only
REM   restart-atlas.bat build    rebuild the frontend first, then restart
REM   restart-atlas.bat force    stop a dev server too, then run in production mode
REM
REM On the client's machine none of this is needed -- Atlas starts at logon,
REM so a reboot applies everything.

cd /d "%~dp0.."

REM ---------------------------------------------------------------------
REM Refuse to run alongside `npm run dev`.
REM
REM This script starts Atlas the production way: two bare node processes,
REM with the UI served as a static build from frontend\dist on port 5000.
REM `npm run dev` starts the SAME app a different way: nodemon watching the
REM backend, and Vite serving the UI with hot reload on port 5173.
REM
REM Running both is not merely redundant, it actively breaks things, and it
REM did:
REM   - two API processes race for port 5000. The winner is arbitrary. Vite
REM     proxies to whichever won, so you can end up editing code that the
REM     server answering your browser never loaded.
REM   - two WORKERS both consume the job queues. The Gemini rate limiter is
REM     per-process, so two workers quietly double the request rate and blow
REM     through the API quota.
REM   - the loser of the port race stays alive but unbound, looking healthy
REM     in the process list while serving nothing.
REM
REM Nodemon already restarts the backend on save and Vite already hot-reloads
REM the frontend, so during development this script has nothing to add.
REM ---------------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$dev = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*nodemon*' }; if ($dev) { exit 1 } else { exit 0 }"

REM goto rather than a parenthesised if-block. Multi-line blocks in cmd are
REM parsed as one command, so an escaped parenthesis inside an echo can end
REM the block early -- which is what swallowed this script's exit code, making
REM the refusal invisible to anything checking it. Labels sidestep the whole
REM class of problem.
if errorlevel 1 goto devrunning
goto stopatlas

:devrunning
if /i "%~1"=="force" goto stopdev
echo.
echo   A development server is already running -- npm run dev / nodemon.
echo.
echo   You do not need this script while that is up:
echo     - nodemon restarts the backend automatically when you save
echo     - Vite hot-reloads the frontend automatically
echo     - your UI is on http://localhost:5173
echo.
echo   Running both would start a second API and a second worker. They
echo   fight over port 5000, and two workers double the Gemini request
echo   rate because the rate limiter is per-process.
echo.
echo   To stop the dev server and run in production mode instead:
echo     restart-atlas.bat force
echo.
exit /b 1

:stopdev
echo Stopping the development server as requested...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*nodemon*' } | ForEach-Object { Write-Host ('  stopping nodemon PID ' + $_.ProcessId); try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { Write-Host ('  COULD NOT STOP ' + $_.ProcessId + ': ' + $_.Exception.Message) } }"

:stopatlas

echo Stopping Atlas...
REM Match on the command line rather than killing every node.exe -- other
REM things on this machine (Adobe, editors, tooling) also run node, and
REM taskkill /IM node.exe would take them down too.
REM
REM cmd.exe is included deliberately. start-atlas.bat launches each process
REM as `cmd /c "node ... >> logfile"`, so it is the WRAPPER, not node, that
REM holds the log file open. Killing only node leaves that handle alive just
REM long enough for the next start to fail its redirect -- the API then runs
REM perfectly while writing its logs nowhere, which is the worst way to lose
REM diagnostics: silently, and only noticeable the day you need them.
REM
REM PowerShell rather than `for /f` over wmic. wmic emits CRLF, so the parsed
REM token is "1234<CR>" -- which ECHOES as a clean PID (the CR just returns
REM the cursor) while taskkill rejects it as invalid. Paired with a
REM `>nul 2>&1` that swallowed the error, this reported "stopping PID 1234"
REM and killed nothing, every single time, for every process.
REM
REM Forward AND backslash variants: the production scripts launch
REM "src\server.js", npm scripts launch "src/server.js", and a match on only
REM one spelling silently leaves the other running.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe' -or $_.Name -eq 'cmd.exe') -and ($_.CommandLine -match 'src[\\/]server\.js' -or $_.CommandLine -match 'workers[\\/]runner\.js') } | ForEach-Object { Write-Host ('  stopping ' + $_.Name + ' PID ' + $_.ProcessId); try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { Write-Host ('  COULD NOT STOP ' + $_.ProcessId + ': ' + $_.Exception.Message) } }"

REM Give the port a moment to release before rebinding it.
REM ping, not `timeout` -- timeout reads the console and dies with "Input
REM redirection is not supported" whenever this runs non-interactively (from
REM a script, a task, or a tool). ping loops with no stdin at all.
ping -n 3 127.0.0.1 >nul

if /i "%~1"=="build" (
    echo Rebuilding the frontend...
    pushd frontend
    call npm run build
    popd
    if errorlevel 1 (
        echo.
        echo BUILD FAILED -- not restarting. Fix the error above and run this again.
        exit /b 1
    )
)

echo Starting Atlas...
call "%~dp0start-atlas.bat"

echo.
echo Waiting for the API to answer...
REM Poll rather than sleeping a fixed guess: a cold start is slower than a
REM warm one, and "it didn't come up" should be reported, not assumed.
set TRIES=0
:wait
set /a TRIES+=1
curl -s -f http://localhost:5000/api/health >nul 2>&1
if not errorlevel 1 goto ready
if %TRIES% GEQ 20 (
    echo   API did not respond after 20 tries. Check %~dp0..\logs\atlas-api.log
    exit /b 1
)
ping -n 2 127.0.0.1 >nul
goto wait

:ready
echo   API is up.
echo.
echo Atlas is running. Open http://localhost:5000
echo Logs: %~dp0..\logs\atlas-api.log  and  %~dp0..\logs\atlas-worker.log
