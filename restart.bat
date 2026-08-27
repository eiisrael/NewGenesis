@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"

set "GENESIS_PORT=7331"
set "GENESIS_URL=http://127.0.0.1:%GENESIS_PORT%"
set "GENESIS_CONFIRMED=0"

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [Genesis] npm não foi encontrado. Instale o Node.js 20 ou superior.
    pause
    exit /b 1
)

echo [Genesis] Verificando a instância local na porta %GENESIS_PORT%...
powershell.exe -NoProfile -Command "$ErrorActionPreference='Stop'; try { $health=Invoke-RestMethod -Uri '%GENESIS_URL%/api/health' -TimeoutSec 3; if ($health.name -eq 'Genesis New') { exit 0 }; exit 2 } catch { exit 1 }" >nul 2>&1
if not errorlevel 1 set "GENESIS_CONFIRMED=1"

if "!GENESIS_CONFIRMED!"=="0" (
    netstat -ano | findstr /R /C:":%GENESIS_PORT% .*LISTENING" >nul
    if not errorlevel 1 (
        echo [Genesis] A porta %GENESIS_PORT% está ocupada por outro serviço. Reinício cancelado com segurança.
        pause
        exit /b 1
    )
    goto start_genesis
)

echo [Genesis] Solicitando encerramento seguro...
curl.exe -s -X POST -H "x-genesis-client: web" "%GENESIS_URL%/api/runtime/shutdown" >nul 2>&1

set /a GENESIS_WAIT=0
:wait_for_shutdown
netstat -ano | findstr /R /C:":%GENESIS_PORT% .*LISTENING" >nul
if errorlevel 1 goto start_genesis
set /a GENESIS_WAIT+=1
if !GENESIS_WAIT! geq 15 goto force_shutdown
timeout.exe /t 1 /nobreak >nul
goto wait_for_shutdown

:force_shutdown
echo [Genesis] O encerramento seguro excedeu 15 segundos. Finalizando somente a árvore confirmada do Genesis...
set "GENESIS_PID="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%GENESIS_PORT% .*LISTENING"') do set "GENESIS_PID=%%P"
if defined GENESIS_PID taskkill.exe /PID !GENESIS_PID! /T /F >nul 2>&1
timeout.exe /t 1 /nobreak >nul

netstat -ano | findstr /R /C:":%GENESIS_PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo [Genesis] Não foi possível liberar a porta %GENESIS_PORT%. Reinício cancelado.
    pause
    exit /b 1
)

:start_genesis
echo [Genesis] Iniciando uma nova instância em %GENESIS_URL%...
echo [Genesis] Pressione Ctrl+C para parar.
call npm start
set "GENESIS_EXIT=%ERRORLEVEL%"

if not "!GENESIS_EXIT!"=="0" echo [Genesis] O servidor encerrou com código !GENESIS_EXIT!.
pause
exit /b !GENESIS_EXIT!
