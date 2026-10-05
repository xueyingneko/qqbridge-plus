@echo off
REM restart-dsh.cmd - restart DeepSeek Harness.
REM
REM Why this exists: while developing a DSH plugin you often need the loader to re-assemble
REM from disk. Killing the app and starting it again must be ONE operation that survives the
REM kill - a naive script is a child of the app and dies with it, leaving you with
REM "app closed, never restarted".
REM
REM Usage: adjust DSH_EXE below (and the task path), register the task once, then trigger it.
REM   set "DSH_EXE=<path to your DeepSeek Harness.exe>"
REM   schtasks /Create /TN "DSH-Restart" /TR "<path to this file>" /SC ONCE /ST 23:59 /F
REM   schtasks /Run    /TN "DSH-Restart"
REM
REM Running it via schtasks (rather than from inside the app) is the point: the scheduled task
REM is not a descendant of the app's process tree, so the taskkill below cannot kill it.
setlocal
REM ── CHANGE THIS to your own install path ──
set "DSH_EXE=<path\to\DeepSeek Harness.exe>"
timeout /t 3 /nobreak >nul
taskkill /IM "DeepSeek Harness.exe" /T /F >nul 2>&1
timeout /t 4 /nobreak >nul
start "" "%DSH_EXE%"
endlocal
