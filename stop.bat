@echo off
chcp 65001 >nul
echo [Genesis] Solicitando encerramento seguro na porta 7331...

curl.exe -s -X POST -H "x-genesis-client: web" http://127.0.0.1:7331/api/runtime/shutdown >nul 2>&1

for /f "tokens=5" %%P in ('netstat -ano ^| findstr :7331 ^| findstr LISTENING') do (
    powershell.exe -NoProfile -Command "Wait-Process -Id %%P -Timeout 15 -ErrorAction SilentlyContinue" >nul 2>&1
)

netstat -ano | findstr :7331 >nul
if %errorlevel% equ 0 (
    echo [Genesis] Aviso: o processo não encerrou. Use Ctrl+C na janela do servidor.
) else (
    echo [Genesis] Servidor encerrado com persistências drenadas.
)
pause
