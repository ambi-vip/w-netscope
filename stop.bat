@echo off
rem NetScope stop - ASCII only (see start.bat for the reason)
setlocal EnableExtensions
title NetScope - Stop and release ports
cd /d "%~dp0"

echo ============================================================
echo   NetScope - stop all instances and release ports
echo ============================================================
echo.

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if defined NODE_EXE goto RUN

echo   [!] Node.js not found. Stop the service manually:
echo       netstat -ano ^| findstr :8899
echo       taskkill /F /PID ^<the PID shown above^>
echo.
pause
exit /b 1

:RUN
"%NODE_EXE%" server.js stop
echo.
pause
