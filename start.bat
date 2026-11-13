@echo off
rem NetScope launcher - ASCII only on purpose: cmd.exe mis-parses UTF-8 Chinese
rem batch files (garbled text executed as commands). Keep this file ASCII.
setlocal EnableExtensions
title NetScope Launcher
cd /d "%~dp0"

echo ============================================================
echo   NetScope - Network Oscilloscope
echo ============================================================
echo.

rem ---- 1) Locate node.exe ----
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE goto NONODE

echo   Node.js found. Starting NetScope...
echo   The browser opens automatically when ready.
echo   Stop: close this window, or press Ctrl+C.
echo   Clean up all instances: run stop.bat
echo.
"%NODE_EXE%" server.js
goto END

:NONODE
echo   [!] Node.js was NOT found on this computer.
echo.
echo   NetScope needs Node.js (LTS version recommended).
echo   This launcher can install it automatically via winget
echo   (built into Windows 10 1709+ and Windows 11),
echo   or you can install it yourself from:
echo       https://nodejs.org/zh-cn/download
echo.
set "TRY="
set /p TRY=Install Node.js automatically now? [Y/N]:
if /i "%TRY%"=="Y" goto AUTOINSTALL
goto MANUAL

:AUTOINSTALL
echo.
echo   Installing Node.js LTS via winget...
echo   (about 30 MB, may take a few minutes - please wait)
echo.
winget install OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
if not errorlevel 1 goto CHECKAGAIN

echo.
echo   Direct Node.js install did not succeed.
echo   Trying the fnm route instead...
echo.
winget install Schniz.fnm -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 goto MANUAL
set "FNM_EXE=%LOCALAPPDATA%\Microsoft\WinGet\Links\fnm.exe"
if not exist "%FNM_EXE%" goto MANUAL
echo   Installing Node.js 24 via fnm...
"%FNM_EXE%" install 24
if errorlevel 1 goto MANUAL

:CHECKAGAIN
rem ---- 2) Re-locate node.exe after installation ----
set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE for /f "delims=" %%i in ('dir /s /b "%LOCALAPPDATA%\fnm\node.exe" "%APPDATA%\fnm\node.exe" "%USERPROFILE%\.fnm\node.exe" 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE goto MANUAL

echo.
echo   Node.js installed successfully. Starting NetScope...
echo.
"%NODE_EXE%" server.js
goto END

:MANUAL
echo.
echo   Automatic install was not completed.
start "" "https://nodejs.org/zh-cn/download"
echo   The Node.js download page has been opened in your browser.
echo   1. Download the LTS "Windows Installer (.msi)"
echo   2. Run it with default options (it configures PATH for you)
echo   3. Double-click start.bat again
echo.

:END
echo.
pause
