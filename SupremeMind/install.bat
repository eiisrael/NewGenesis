@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo A instalacao falhou. Revise a mensagem acima.
  exit /b 1
)
echo.
pause
