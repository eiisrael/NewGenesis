@echo off
setlocal
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0SupremeMind-GUI.ps1" -Project "%~1"
if errorlevel 1 (
  echo.
  echo Nao foi possivel iniciar o SupremeMind Control Core.
  pause
  exit /b 1
)
