#!/usr/bin/env bash
# PT. MANNA — jalankan server (Linux / macOS)
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "Node.js belum terpasang: https://nodejs.org"; exit 1; }
exec node backend/server.js
