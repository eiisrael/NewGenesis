@echo off
chcp 65001 >nul
echo [Genesis] Parando servidor na porta 7331...

for /f "tokens=5" %%P in ('netstat -ano ^| findstr :7331 ^| findstr LISTENING') do (
    echo [Genesis] Encerrando processo %%P
    taskkill /PID %%P /F >nul 2>&1
)

timeout /t 1 /nobreak >nul

netstat -ano | findstr :7331 >nul
if %errorlevel% equ 0 (
    echo [Genesis] Aviso: porta 7331 ainda em uso
) else (
    echo [Genesis] Servidor parado com sucesso
)
pause
