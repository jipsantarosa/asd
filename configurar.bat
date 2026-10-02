@echo off
setlocal EnableExtensions
title Casino - Configurar el .env
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul

echo ==========================================================
echo              CASINO - Configurar el archivo .env
echo ==========================================================
echo.
echo Los datos se guardan SOLO en el archivo .env de esta PC.
echo.

:ask_token
set "TOKEN="
echo 1) TOKEN DEL BOT
echo    Developer Portal ^> tu app ^> Bot ^> Reset Token
set /p "TOKEN=   Pegalo aca y apreta Enter (vacio = dejar el actual): "

echo.
set "OWNERS="
echo 2) DUENOS DEL BOT - opcional
echo    IDs de Discord separados por coma. Pueden configurar el casino, torneos y saldos.
echo    El dueno de la aplicacion se detecta solo.
set /p "OWNERS=   IDs (vacio = dejar como esta): "

powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='.env'; $keep = Get-Content $f | Where-Object { $_ -notmatch '^(CLIENT_SECRET|ACTIVITY_PORT|GAME_CONFIG_PATH)=' -and ([string]::IsNullOrEmpty($env:TOKEN) -or $_ -notmatch '^DISCORD_TOKEN=') -and ([string]::IsNullOrEmpty($env:OWNERS) -or $_ -notmatch '^OWNER_IDS=') }; if (-not [string]::IsNullOrEmpty($env:TOKEN)) { $keep += 'DISCORD_TOKEN=' + $env:TOKEN.Trim() }; if (-not [string]::IsNullOrEmpty($env:OWNERS)) { $keep += 'OWNER_IDS=' + $env:OWNERS.Trim() }; Set-Content -Path $f -Value $keep -Encoding ascii"
if errorlevel 1 (
  echo.
  echo [ERROR] No pude guardar el archivo .env.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo   Listo: .env guardado.
echo   Ahora cerra la ventana del bot y abri iniciar.bat
echo ==========================================================
pause
