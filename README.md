# Lickety Split

https://licketysplit.jeffsawyer.us: a web page to flash and update the ESP32 devices.

- **Flash over USB** (Chrome/Edge on a computer): ESP Web Tools 10.4.0, served from `public/vendor`.
- **Update over Wi-Fi**: the server pushes the app image to the device's OTA endpoint
  (WLED and Matrixinator: multipart `POST /update`; airplay-esp32: raw `POST /api/ota/update`).

| Firmware | Built by | Release tag |
|---|---|---|
| Matrixinator (4848S040 screen) | `<owner>/matrixinator` | `vX.Y.Z` |
| AirPlay receiver + Signinator art (Marantz Stereo) | `<owner>/airplay-esp32`, workflow `signinator.yml` | `signinator-vX.Y.Z-N` |
| WLED ESP32 / ESP32-WROVER (sign, tree) | this repo, workflow `wled.yml` (official source, unchanged) | `wled-vX.Y.Z` |

The server copies release files into `/var/lib/licketysplit/firmware` (browsers can't download GitHub release
files directly), checks every 6 hours and on "Check for new builds". Set the GitHub owner in ⚙ Settings; for
private repos put a read-only token in `GITHUB_TOKEN` in `/etc/licketysplit.env`.

Install once: `sudo bash install.sh` (service `licketysplit`, user `licketysplit`, port 8110 on 127.0.0.1; Caddy
proxies the HTTPS name). Update: `tools/deploy.sh` then `sudo systemctl restart licketysplit`. No npm dependencies.
