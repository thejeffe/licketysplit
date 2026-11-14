#!/usr/bin/env bash
# Copy the code into /opt/licketysplit (no sudo needed after install.sh), then:  sudo systemctl restart licketysplit
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"; DST=/opt/licketysplit
[ -w "$DST/server.js" ] || { echo "Can't write to $DST. Run 'sudo bash install.sh' once first."; exit 1; }
node --check "$SRC/server.js"; node --check "$SRC/netscan.js"; node --check "$SRC/monitor.js"; node --check "$SRC/speedtest.js"
cp "$SRC/server.js" "$SRC/netscan.js" "$SRC/monitor.js" "$SRC/speedtest.js" "$DST/"
cp -r "$SRC/public/." "$DST/public/"
# stamp the page's script and style links with this version, so browsers (and the home-screen app) never mix an old copy in
VER="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || date +%s)$(git -C "$SRC" diff --quiet 2>/dev/null || echo "-$(date +%s)")"
sed -i -E "s#(src=\"app\.js|href=\"style\.css)(\?v=[^\"]*)?\"#\1?v=$VER\"#g" "$DST/public/index.html"
chmod -R a+rX "$DST"
echo "Copied to $DST. Now run:  sudo systemctl restart licketysplit"
