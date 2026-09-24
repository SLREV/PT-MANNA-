@echo off
chcp 65001 >nul
title PT. MANNA - Akses Online (Cloudflare Tunnel)
cd /d "%~dp0"
REM Membuat alamat https publik agar aplikasi bisa dibuka dari HP/PC mana saja via internet.
REM Server (start-windows.bat) harus sudah berjalan di jendela lain.
where cloudflared >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [X] cloudflared belum terpasang. Pasang dengan perintah:
  echo        winget install --id Cloudflare.cloudflared
  echo      lalu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=3000
echo.
echo  Cari baris "https://....trycloudflare.com" di bawah — itu alamat online aplikasi.
echo  Buka alamat itu di HP Android lalu pilih "Install app".
echo.
cloudflared tunnel --url http://localhost:%PORT%
pause
