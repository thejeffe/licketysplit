'use strict';
// Internet speed test: Speedtest by Ookla's official command-line program (the speedtest.net engine), run as is.
// It picks the nearest good server and reports ping, jitter, download, upload, packet loss and a link to the full
// result on speedtest.net. Numbers are what this server sees.
//
// The program isn't in the repository (Ookla's license doesn't allow passing it on): download it from
// https://www.speedtest.net/apps/cli (Linux, x86_64 or arm) and put the `speedtest` file in <install dir>/bin/, or
// point LS_SPEEDTEST at it. Its license is accepted on each run (--accept-license --accept-gdpr); it keeps a note of
// that in HOME (Lickety Split's data folder). There is no other test: when it's missing or a run fails, that try is
// recorded as failed and the chart carries its lines across the gap.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const OOKLA = process.env.LS_SPEEDTEST || path.join(__dirname, 'bin', 'speedtest');

function ooklaReady() { try { fs.accessSync(OOKLA, fs.constants.X_OK); return true; } catch (e) { return false; } }

function ookla(home) {
  return new Promise((ok, no) => {
    execFile(OOKLA, ['--accept-license', '--accept-gdpr', '-f', 'json', '-p', 'no'],
      { timeout: 120000, maxBuffer: 1 << 20, env: Object.assign({}, process.env, home ? { HOME: home } : {}) }, (err, stdout, stderr) => {
        let j = null;
        for (const line of String(stdout || '').split('\n')) { try { const x = JSON.parse(line); if (x && x.type === 'result') j = x; } catch (e) { /* not JSON */ } }
        if (!j) {
          const why = (String(stderr || '').match(/\[error\].*|error.*$/im) || [])[0] || (err && (err.killed ? 'no result in 2 minutes' : err.message)) || 'no result';
          return no(new Error('Speedtest: ' + String(why).replace(/\s+/g, ' ').slice(0, 160)));
        }
        const s = j.server || {};
        ok({
          ping: Math.round((j.ping || {}).latency * 10) / 10, jitter: Math.round((j.ping || {}).jitter * 10) / 10,
          down: Math.round((j.download || {}).bandwidth * 8 / 1e5) / 10, up: Math.round((j.upload || {}).bandwidth * 8 / 1e5) / 10,
          loss: j.packetLoss != null ? Math.round(j.packetLoss * 10) / 10 : null,
          engine: 'ookla', server: [s.name, s.location].filter(Boolean).join(' · ').slice(0, 80), isp: String(j.isp || '').slice(0, 60),
          url: j.result && /^https:\/\/www\.speedtest\.net\//.test(j.result.url || '') ? j.result.url : null,
        });
      });
  });
}

async function runTest(opts) {
  if (!ooklaReady()) throw new Error('Speedtest by Ookla isn’t installed (put its `speedtest` program in ' + path.dirname(OOKLA) + ')');
  const t = Date.now();
  const r = await ookla(opts && opts.home);
  return Object.assign({ t }, r, { took: Date.now() - t });
}

module.exports = { runTest, ooklaReady };
