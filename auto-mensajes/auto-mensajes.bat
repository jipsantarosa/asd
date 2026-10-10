@echo off
setlocal EnableExtensions
title Auto mensajes
cd /d "%~dp0"

echo ==========================================================
echo           Mensajes automaticos en Discord
echo ==========================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro Node.js.
  echo         Instalalo desde https://nodejs.org y volve a abrir este archivo.
  goto :fin
)

if not exist "node_modules\playwright-core" (
  echo Instalando lo necesario, solo la primera vez...
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 goto :fin
  echo.
)

node auto-mensajes.mjs

:fin
echo.
pause
