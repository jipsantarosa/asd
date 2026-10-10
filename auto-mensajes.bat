@echo off
setlocal EnableExtensions
title Auto mensajes
cd /d "%~dp0"

echo ==========================================================
echo           Mensajes automaticos en Discord
echo ==========================================================
echo.

rem Sirve en la carpeta del bot (scripts\) o con los dos archivos en la misma carpeta.
set "SCRIPT=%~dp0scripts\auto-mensajes.ps1"
if not exist "%SCRIPT%" set "SCRIPT=%~dp0auto-mensajes.ps1"
if not exist "%SCRIPT%" (
  echo [ERROR] No encontre auto-mensajes.ps1. Ponelo en la misma carpeta que este .bat
  goto :fin
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"

echo.
echo El script se detuvo. Revisa el mensaje de arriba.
:fin
pause
