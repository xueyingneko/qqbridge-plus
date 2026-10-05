@echo off
REM dsh-plugin-qqbridge-plus one-click install (Windows).
REM
REM Thin wrapper: it only makes sure the repo is on disk, then hands over to
REM scripts\install.mjs, which does all the real work. The install logic lives in
REM exactly one place on purpose.
REM
REM Usage:
REM   scripts\install.cmd [--repo <git url>] [--profile desktop|web] [--bridge-dir <path>] [--dry-run]
REM
REM Style note: no nested if/else blocks and no delayed expansion. Both are easy to get
REM subtly wrong in cmd, and a broken installer is worse than a verbose one. Everything
REM that can be expressed as a plain statement is one.
setlocal
set "TARGET=%~dp0.."
set "REPO="
set "PASSTHRU="

REM Walk the args once: pull out --repo <url> (we need it here for cloning) and keep
REM everything else for install.mjs. Passing --repo through would make install.mjs fail
REM on an option it does not know.
set "NEXT_IS_REPO="
for %%A in (%*) do call :scan "%%~A"
goto after_scan

:scan
if defined NEXT_IS_REPO (
  set "REPO=%~1"
  set "NEXT_IS_REPO="
  exit /b
)
if /i "%~1"=="--repo" (
  set "NEXT_IS_REPO=1"
  exit /b
)
set "PASSTHRU=%PASSTHRU% %~1"
exit /b

:after_scan
set "ARGS=%PASSTHRU%"

if exist "%TARGET%\lib\index.js" goto have_repo

REM Not inside the repo: clone it, or use --repo if given.
if "%REPO%"=="" set "REPO=https://github.com/xueyingneko/qqbridge-plus.git"
set "TARGET=%USERPROFILE%\dsh-plugins\dsh-plugin-qqbridge-plus"
if exist "%TARGET%\lib\index.js" goto have_repo

where git >nul 2>&1
if errorlevel 1 goto no_git
echo - cloning %REPO%
if not exist "%USERPROFILE%\dsh-plugins" mkdir "%USERPROFILE%\dsh-plugins"
git clone --depth 1 "%REPO%" "%TARGET%"
if errorlevel 1 goto clone_failed

:have_repo
where node >nul 2>&1
if errorlevel 1 goto no_node
echo = repo: %TARGET%
node "%TARGET%\scripts\install.mjs" --dir "%TARGET%" %ARGS%
endlocal
exit /b %errorlevel%

:no_node
echo X need Node 18+ (node not found in PATH)
endlocal
exit /b 1

:no_git
echo X need git (git not found in PATH)
endlocal
exit /b 1

:clone_failed
echo X git clone failed
endlocal
exit /b 1
