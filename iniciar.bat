@echo off
setlocal EnableExtensions
title Casino - Bot de Discord
cd /d "%~dp0"

echo ==========================================================
echo                 CASINO - Iniciando el bot
echo ==========================================================
echo.

rem ---------- Requisitos ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js.
  echo         Instalalo desde https://nodejs.org (version 22 o mas nueva^) y volve a abrir este archivo.
  goto :fail
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [AVISO] No existia el archivo .env: lo cree y lo abro en el Bloc de notas.
  echo         Completa DISCORD_TOKEN, guarda y volve a abrir iniciar.bat
  notepad ".env"
  goto :fail
)

rem ---------- Dependencias ----------
rem Siempre se corre npm install: si una actualizacion trae una dependencia nueva, se instala sola.
if not exist "node_modules" (
  echo [1/3] Instalando dependencias, puede tardar unos minutos...
) else (
  echo [1/3] Revisando dependencias...
)
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto :fail

echo [2/3] Compilando el bot...
call npm run build
if errorlevel 1 goto :fail

rem Los comandos de barra los registra el bot solo al conectarse (si cambiaron).
if not exist "data" mkdir "data"

rem Evita que quede otra copia del bot corriendo en pm2 al mismo tiempo.
where pm2 >nul 2>nul
if not errorlevel 1 call pm2 delete valle >nul 2>nul

rem ---------- Bot con reinicio automatico ----------
echo [3/3] Iniciando el bot. Para detenerlo, cerra esta ventana.
echo.
:loop
node dist\index.js
echo.
echo [AVISO] El bot se detuvo. Se reinicia en 10 segundos. Si se repite, mira el error de arriba.
echo         (Las partidas abiertas no se pierden: al volver se retoman o se devuelve la apuesta.)
timeout /t 10 /nobreak >nul
goto :loop

:fail
echo.
echo No se pudo iniciar. Revisa el mensaje de arriba.
pause
exit /b 1
