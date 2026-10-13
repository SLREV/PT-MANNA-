@echo off
chcp 65001 >nul
title PT. MANNA - Server
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] Node.js belum terpasang.
  echo      Download ^& install versi LTS dari https://nodejs.org lalu jalankan file ini lagi.
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=3000
start "" http://localhost:%PORT%
node backend\server.js
pause
