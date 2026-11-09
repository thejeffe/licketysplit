#!/usr/bin/env bash
# Installs Lickety Split as a systemd service. Run once with sudo from this folder:  sudo bash install.sh
# Afterwards, update the code without sudo:  tools/deploy.sh  then  sudo systemctl restart licketysplit
set -euo pipefail
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Needs Node.js 18 or newer."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || { echo "Needs Node.js 18 or newer (have $(node --version))."; exit 1; }
id licketysplit >/dev/null 2>&1 || useradd --system --home /var/lib/licketysplit --shell /usr/sbin/nologin licketysplit
mkdir -p /opt/licketysplit /var/lib/licketysplit
cp -r server.js public /opt/licketysplit/
OWNER="${SUDO_USER:-root}"; chown -R "$OWNER":"$OWNER" /opt/licketysplit; chmod -R a+rX /opt/licketysplit
chown -R licketysplit:licketysplit /var/lib/licketysplit
if [ ! -f /etc/licketysplit.env ]; then install -m 600 deploy/licketysplit.env /etc/licketysplit.env; fi
cp deploy/licketysplit.service /etc/systemd/system/licketysplit.service
systemctl daemon-reload
systemctl enable --now licketysplit
systemctl restart licketysplit
sleep 1
systemctl --no-pager --lines=5 status licketysplit || true
echo
echo "Lickety Split is on 127.0.0.1:8110 (https://licketysplit.jeffsawyer.us through Caddy)."
