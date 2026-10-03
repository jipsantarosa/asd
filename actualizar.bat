@echo off
setlocal EnableExtensions
title Casino - Actualizar el bot
cd /d "%~dp0"

echo ==========================================================
echo                 CASINO - Actualizar el bot
echo ==========================================================
echo.
echo Se reemplaza SOLO el codigo. NO se tocan:
echo   - data\  = base de datos: saldos, canales, roles, casino...
echo   - .env   = token y duenos
echo.

where node >nul 2>nul
if errorlevel 1 goto :nonode
if not exist "scripts\actualizar.mjs" goto :noscript

echo [1/3] Cerrando el bot si esta abierto...
taskkill /FI "WINDOWTITLE eq Casino - Bot de Discord*" /T /F >nul 2>nul
timeout /t 3 /nobreak >nul

echo [2/3] Bajando la version nueva...
node scripts\actualizar.mjs
if errorlevel 1 goto :fail

echo.
echo [3/3] Listo. Arrancando el bot con tu configuracion de siempre...
echo       iniciar.bat instala dependencias, compila y arranca. Al conectarse aplica
echo       las migraciones, registra los comandos nuevos y actualiza los canales solos.
rem Si vino una version nueva de este archivo, se reemplaza en la misma linea en que se sale.
if exist "actualizar.bat.new" move /y "actualizar.bat.new" "actualizar.bat" >nul & start "" "%~dp0iniciar.bat" & exit /b 0
start "" "%~dp0iniciar.bat"
exit /b 0

:nonode
echo [ERROR] No se encontro Node.js. Instalalo desde https://nodejs.org - version 22 o mas nueva.
goto :end

:noscript
echo [ERROR] Falta scripts\actualizar.mjs. Esta vez baja el codigo a mano desde GitHub
echo         y copialo encima de esta carpeta SIN borrar data\ ni .env. Desde ahi, este archivo anda solo.
goto :end

:fail
echo.
echo No se pudo actualizar. Tu data\ y tu .env estan intactos.
echo Podes abrir iniciar.bat para arrancar la version que tenias.

:end
echo.
pause
exit /b 1
