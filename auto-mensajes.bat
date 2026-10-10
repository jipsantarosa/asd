@echo off
setlocal EnableExtensions
title Auto mensajes
cd /d "%~dp0"

echo ==========================================================
echo           Mensajes automaticos en Discord
echo ==========================================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\auto-mensajes.ps1"

echo.
echo El script se detuvo. Revisa el mensaje de arriba.
pause
