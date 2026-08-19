@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [Genesis] Iniciando painel em http://127.0.0.1:7331
echo [Genesis] Pressione Ctrl+C para parar
npm start
pause
