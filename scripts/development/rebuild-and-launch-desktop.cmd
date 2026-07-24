@echo off
setlocal

cd /d "%~dp0\..\.."
if errorlevel 1 exit /b 1

echo [Omni Translate] Rebuilding the Tauri desktop release...
call npm.cmd run build:desktop-shell
if errorlevel 1 (
  echo.
  echo [Omni Translate] Build failed. The previous executable will not be launched.
  pause
  exit /b 1
)

set "OMNI_DESKTOP_EXE=%CD%\apps\desktop\src-tauri\target\release\omni-desktop-shell.exe"
if not exist "%OMNI_DESKTOP_EXE%" (
  echo.
  echo [Omni Translate] Build completed but the executable was not found:
  echo %OMNI_DESKTOP_EXE%
  pause
  exit /b 1
)

echo [Omni Translate] Launching the newly built desktop executable...
start "" "%OMNI_DESKTOP_EXE%"
exit /b 0
