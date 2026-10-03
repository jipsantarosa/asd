@echo off
setlocal EnableExtensions
title Casino - Actualizar el bot
cd /d "%~dp0"

echo ==========================================================
echo                 CASINO - Actualizar el bot
echo ==========================================================
echo.
echo Se reemplaza SOLO el codigo. NO se tocan:
echo   - data\  (base de datos: saldos, configuracion de canales, roles, casino...)
echo   - .env   (token y duenos)
echo.

rem ---------- Repositorio y rama (se pueden cambiar en el .env) ----------
set "REPO=jipsantarosa/asd"
set "BRANCH=claude/bot-besos-canales-temporales-qdksf6"
set "GHTOKEN="
set "SRCDIR="
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="UPDATE_REPO" if not "%%B"=="" set "REPO=%%B"
    if /i "%%A"=="UPDATE_BRANCH" if not "%%B"=="" set "BRANCH=%%B"
    if /i "%%A"=="GITHUB_TOKEN" set "GHTOKEN=%%B"
  )
)
echo Repositorio: %REPO%  rama: %BRANCH%
echo.

rem ---------- 1) Cerrar el bot ----------
echo [1/5] Cerrando el bot...
taskkill /FI "WINDOWTITLE eq Casino - Bot de Discord*" /T /F >nul 2>nul
powershell -NoProfile -Command "$here = (Get-Location).Path; Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dist\index.js*' -and $_.CommandLine -like ('*' + $here + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>nul
timeout /t 3 /nobreak >nul

rem ---------- 2) Copia de seguridad de la base ----------
echo [2/5] Copia de seguridad de la base de datos...
set "STAMP=%RANDOM%"
for /f %%D in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%D"
if exist "data\valle.db" (
  if not exist "data\backups" mkdir "data\backups"
  copy /y "data\valle.db" "data\backups\antes-de-actualizar-%STAMP%.db" >nul
  if exist "data\valle.db-wal" copy /y "data\valle.db-wal" "data\backups\antes-de-actualizar-%STAMP%.db-wal" >nul
  echo       Guardada en data\backups\antes-de-actualizar-%STAMP%.db
) else (
  echo       No hay base todavia: nada que respaldar.
)

rem ---------- 3) Bajar la version nueva ----------
echo [3/5] Bajando la version nueva...
if exist ".git" (
  where git >nul 2>nul
  if errorlevel 1 (
    echo [ERROR] Esta carpeta es un repositorio git pero git no esta instalado.
    goto :fail
  )
  git fetch origin "%BRANCH%"
  if errorlevel 1 goto :fail
  git checkout "%BRANCH%" >nul 2>nul
  git merge --ff-only "origin/%BRANCH%"
  if errorlevel 1 (
    echo [ERROR] No pude actualizar con git: hay cambios locales en el codigo. Guardalos o descartalos y volve a intentar.
    goto :fail
  )
  goto :build
)

set "TMPDIR=%TEMP%\casino-update"
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%"
mkdir "%TMPDIR%"
set "ZIP=%TMPDIR%\codigo.zip"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $h=@{ 'User-Agent'='casino-bot-updater' }; if ($env:GHTOKEN) { $h['Authorization']='Bearer ' + $env:GHTOKEN }; Invoke-WebRequest -UseBasicParsing -Headers $h -Uri ('https://api.github.com/repos/' + $env:REPO + '/zipball/' + $env:BRANCH) -OutFile $env:ZIP"
if errorlevel 1 (
  echo [ERROR] No pude bajar el codigo de GitHub.
  echo         Si el repositorio es privado, agrega GITHUB_TOKEN=... en el .env
  echo         (un token de GitHub con permiso de lectura del repositorio).
  goto :fail
)
powershell -NoProfile -Command "Expand-Archive -Force -Path $env:ZIP -DestinationPath $env:TMPDIR"
if errorlevel 1 goto :fail
set "SRCDIR="
for /d %%F in ("%TMPDIR%\*") do set "SRCDIR=%%F"
if not exist "%SRCDIR%\package.json" (
  echo [ERROR] El archivo bajado no tiene el codigo del bot.
  goto :fail
)

rem Carpetas de codigo: se reflejan exactas (los archivos borrados en la version nueva tambien se borran aca).
for %%S in (src test wiki docs) do (
  if exist "%SRCDIR%\%%S" robocopy "%SRCDIR%\%%S" "%%S" /MIR /NFL /NDL /NJH /NJS /NP >nul
)
rem Archivos sueltos de la raiz (nunca .env ni este mismo archivo, que se actualiza al final).
robocopy "%SRCDIR%" "." *.* /LEV:1 /XF .env actualizar.bat /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 (
  echo [ERROR] Fallo la copia de archivos.
  goto :fail
)

:build
rem ---------- 4) Dependencias y compilacion ----------
echo [4/5] Instalando dependencias y compilando...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 goto :fail
call npm run build
if errorlevel 1 goto :fail

rem ---------- 5) Arrancar ----------
echo [5/5] Listo. Arrancando el bot con tu configuracion de siempre...
echo       Al conectarse aplica las migraciones, registra los comandos nuevos y
echo       actualiza solos los canales de registros y voz temporal.
echo.
rem Este archivo se reemplaza en la misma linea en que se sale (cmd ya la leyo entera).
if defined SRCDIR if exist "%SRCDIR%\actualizar.bat" (copy /y "%SRCDIR%\actualizar.bat" "%~f0" >nul & start "" "%~dp0iniciar.bat" & exit /b 0)
start "" "%~dp0iniciar.bat"
exit /b 0

:fail
echo.
echo No se pudo actualizar. El bot NO se modifico de mas: tu data\ y tu .env estan intactos.
echo Podes volver a abrir iniciar.bat para arrancar la version que tenias.
pause
exit /b 1
