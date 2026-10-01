@echo off
setlocal EnableExtensions EnableDelayedExpansion
title El Valle - Bot de Discord
cd /d "%~dp0"

echo ==========================================================
echo                EL VALLE - Iniciando el bot
echo ==========================================================
echo.

rem ---------- Requisitos ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js.
  echo         Instalalo desde https://nodejs.org y volve a abrir este archivo.
  goto :fail
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo [AVISO] No existia el archivo .env: lo cree y lo abro en el Bloc de notas.
  echo         Completa DISCORD_TOKEN, CLIENT_ID y CLIENT_SECRET, guarda y volve a abrir iniciar.bat
  notepad ".env"
  goto :fail
)

rem ---------- Leer el puerto y el secreto del .env ----------
set "PORT=3000"
set "SECRET="
for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
  if /i "%%A"=="ACTIVITY_PORT" if not "%%B"=="" set "PORT=%%B"
  if /i "%%A"=="CLIENT_SECRET" set "SECRET=%%B"
)

rem ---------- Dependencias ----------
rem Siempre se corre npm install: si una actualizacion trae una dependencia nueva, se instala sola.
rem Cuando no hay nada nuevo tarda solo unos segundos.
if not exist "node_modules" (
  echo [1/4] Instalando dependencias, puede tardar unos minutos...
) else (
  echo [1/4] Revisando dependencias...
)
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto :fail

echo [2/4] Base de datos: se usa better-sqlite3 si funciona, o el SQLite incluido en Node.

echo [3/4] Compilando el bot y el juego...
call npm run build
if errorlevel 1 goto :fail

rem Los comandos de barra los registra el bot solo al conectarse (si cambiaron).
rem Ya no hace falta CLIENT_ID: el ID de la aplicacion sale del token.
if not exist "data" mkdir "data"

rem Evita que quede otra copia del bot corriendo en pm2 al mismo tiempo.
where pm2 >nul 2>nul
if not errorlevel 1 call pm2 delete valle >nul 2>nul

rem Cierra una copia anterior del bot que haya quedado ocupando el puerto, y el tunel viejo.
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; if ($p -and $p.ProcessName -eq 'node') { Stop-Process -Id $p.Id -Force; Write-Host '      Cerre una copia anterior del bot que seguia abierta.' } }"
taskkill /IM cloudflared.exe /F >nul 2>nul

rem ---------- Tunel HTTPS para la Actividad ----------
if not defined SECRET (
  echo [4/4] Sin CLIENT_SECRET en .env: el juego como Actividad queda desactivado.
  goto :run
)

set "CF="
where cloudflared >nul 2>nul && set "CF=cloudflared"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF (
  echo [4/4] No encontre cloudflared. Instalalo con:  winget install --id Cloudflare.cloudflared
  echo       El bot va a funcionar igual, pero el juego como Actividad no se va a poder abrir.
  goto :run
)

echo [4/4] Abriendo el tunel HTTPS en otra ventana...
set "TLOG=%TEMP%\valle-tunel.log"
if exist "%TLOG%" del "%TLOG%" >nul 2>nul
start "El Valle - Tunel (no cerrar)" /min "%CF%" tunnel --url http://localhost:%PORT% --logfile "%TLOG%"

set "URL="
for /l %%i in (1,1,40) do (
  if not defined URL (
    for /f "usebackq delims=" %%U in (`powershell -NoProfile -Command "if (Test-Path $env:TLOG) { $m = Select-String -Path $env:TLOG -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $m.Matches[0].Value } }"`) do set "URL=%%U"
    if not defined URL timeout /t 1 /nobreak >nul
  )
)

if not defined URL (
  echo       No pude leer la direccion del tunel. Buscala en la ventana "El Valle - Tunel".
  goto :run
)
set "HOST=%URL:https://=%"
echo %HOST%| clip
echo.
echo ==========================================================
echo   DIRECCION DEL TUNEL - ya esta copiada al portapapeles:
echo.
echo       %HOST%
echo.
echo   Pegala en Developer Portal ^> Activities ^> URL Mappings
echo   como Target del prefijo /  y guarda los cambios.
echo   Cambia cada vez que abris este archivo.
echo ==========================================================
echo.

rem ---------- Bot con reinicio automatico ----------
:run
echo.
echo Iniciando el bot. Para detenerlo, cerra esta ventana.
echo.
:loop
node dist\index.js
echo.
echo [AVISO] El bot se detuvo. Se reinicia en 10 segundos. Si se repite, mira el error de arriba.
timeout /t 10 /nobreak >nul
goto :loop

:fail
echo.
echo No se pudo iniciar. Revisa el mensaje de arriba.
pause
exit /b 1
