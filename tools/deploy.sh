#!/usr/bin/env bash
# Copy the code into /opt/licketysplit (no sudo needed after install.sh), then:  sudo systemctl restart licketysplit
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DST=/opt/licketysplit
[ -w "$DST/server.js" ] || { echo "Can't write to $DST. Run 'sudo bash install.sh' once first."; exit 1; }
node --check "$SRC/server.js"
cp "$SRC/server.js" "$DST/"
cp -r "$SRC/public/." "$DST/public/"
chmod -R a+rX "$DST"
echo "Copied to $DST. Now run:  sudo systemctl restart licketysplit"
