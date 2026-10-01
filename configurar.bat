@echo off
setlocal EnableExtensions
title El Valle - Configurar claves
cd /d "%~dp0"
if not exist ".env" copy ".env.example" ".env" >nul

echo ==========================================================
echo            EL VALLE - Configurar claves del .env
echo ==========================================================
echo.
echo Los datos se guardan SOLO en el archivo .env de esta PC.
echo.

:ask_secret
set "SECRET="
echo 1) CLIENT SECRET
echo    Developer Portal ^> tu app ^> OAuth2 ^> Client Secret ^> Reset Secret
echo    Es de unos 32 caracteres y NO tiene puntos.
set /p "SECRET=   Pegalo aca y apreta Enter: "
if not defined SECRET (
  echo    No pegaste nada. Proba de nuevo.
  echo.
  goto :ask_secret
)
echo %SECRET%| find "." >nul
if not errorlevel 1 (
  echo.
  echo    [OJO] Eso tiene puntos: parece el TOKEN del bot, no el Client Secret.
  echo          El Client Secret esta en la seccion OAuth2, no en Bot.
  echo.
  goto :ask_secret
)

echo.
set "TOKEN="
echo 2) TOKEN DEL BOT - opcional
echo    Si reseteaste el token en Developer Portal ^> Bot ^> Reset Token, pegalo aca.
set /p "TOKEN=   Si no lo cambiaste, solo apreta Enter: "

powershell -NoProfile -ExecutionPolicy Bypass -Command "$f='.env'; $keep = Get-Content $f | Where-Object { $_ -notmatch '^(CLIENT_SECRET|ACTIVITY_PORT)=' -and ([string]::IsNullOrEmpty($env:TOKEN) -or $_ -notmatch '^DISCORD_TOKEN=') }; if (-not [string]::IsNullOrEmpty($env:TOKEN)) { $keep += 'DISCORD_TOKEN=' + $env:TOKEN.Trim() }; $keep += 'CLIENT_SECRET=' + $env:SECRET.Trim(); $keep += 'ACTIVITY_PORT=3000'; Set-Content -Path $f -Value $keep -Encoding ascii"
if errorlevel 1 (
  echo.
  echo [ERROR] No pude guardar el archivo .env.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo   Listo: claves guardadas en .env
echo   Ahora cerra la ventana del bot y abri iniciar.bat
echo ==========================================================
pause
