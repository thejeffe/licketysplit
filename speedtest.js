'use strict';
// Internet speed test against Cloudflare's speed-test endpoints (no client software, no account):
//  - latency: the network round-trip Cloudflare measured on several tiny requests (median = ping, change between them = jitter)
//  - download: 8 streams of 25 MB (200 MB, the same budget as before, stopping at 10 s), rated on the steady part only: from 1 s after
//    the data starts (each connection ramps up first) to when the first stream finishes (after that, fewer streams
//    are left to fill the line). That's what the line carries, like the big speed-test sites report.
//  - upload: 4 streams of 2 x 25 MB, counting only the time data is moving (see busyTime), pieces as Cloudflare
//    confirms them. (Upload used to send 48 MB in 4 MB
//    pieces, waiting for each reply: on a gigabit line that read ~150 Mbps low.)
// Results are Mbps. Numbers are what this server sees: a VM on a gigabit LAN usually measures the
// internet line itself; a slow Wi-Fi client would see less.
const CF = process.env.LS_SPEED_BASE || 'https://speed.cloudflare.com';
const STREAMS = 4, DOWN_STREAMS = 8, DOWN_PIECES = 1, CAP_MS = 10000, RAMP_MS = 1000;
// a fixed budget per test (about 200 MB each way), so hourly tests stay well inside Cloudflare's limits
const PIECE = 25 * 1000 * 1000, PIECES = 2;

// Cloudflare reports the connection's measured round-trip (TCP rtt, in µs) in each answer's Server-Timing header;
// that is the network's ping without Cloudflare's own processing time. Wall-clock time minus that processing is the fallback.
function refused(r) {
  const e = new Error(r.status === 429 ? 'the test server says too many tests from here' : `the test server answered HTTP ${r.status}`);
  const after = +r.headers.get('retry-after');
  if (r.status === 429) e.until = Date.now() + (after > 0 ? after : 3600) * 1000;     // don't try again before this
  return e;
}

async function latency(n) {
  const t = [];
  for (let i = 0; i < (n || 8); i++) {
    const t0 = process.hrtime.bigint();
    const r = await fetch(`${CF}/__down?bytes=0&r=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw refused(r);
    const wall = Number(process.hrtime.bigint() - t0) / 1e6;
    await r.arrayBuffer();
    if (i === 0) continue;                                    // the first one includes connecting
    const st = r.headers.get('server-timing') || '';
    const rtt = /[?&]rtt=(\d+)/.exec(st), work = /cfSpeedWorker;dur=([\d.]+)/.exec(st), edge = /cfSpeedEdge;dur=([\d.]+)/.exec(st);
    t.push(rtt ? +rtt[1] / 1000 : Math.max(0.1, wall - (work ? +work[1] : 0) - (edge ? +edge[1] : 0)));
  }
  // jitter: the average change from one ping to the next (in the order they were measured)
  const jitter = t.length > 1 ? t.slice(1).reduce((s, v, i) => s + Math.abs(v - t[i]), 0) / (t.length - 1) : 0;
  const sorted = [...t].sort((a, b) => a - b), ping = sorted[Math.floor(sorted.length / 2)];
  return { ping: Math.round(ping * 10) / 10, jitter: Math.round(jitter * 10) / 10 };
}

// Only time spent moving data counts. Dead time is left out: opening connections (warmed up first, untimed), waiting
// for a download's first byte, waiting for Cloudflare's reply after an upload (one ping per piece), and moments when
// no stream is transferring. Rate = bytes / the time at least one stream was moving data.
function busyTime(spans) { // total length of the union of [start, end) spans (ms)
  const s = spans.filter((x) => x[1] > x[0]).sort((x, y) => x[0] - y[0]);
  let total = 0, cs = -1, ce = -1;
  for (const [a, b] of s) { if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; } else if (b > ce) ce = b; }
  if (ce > cs) total += ce - cs;
  return total;
}
async function warmUp(n) { // a connection per stream, opened before the clock starts
  await Promise.all(Array.from({ length: n || STREAMS }, async () => {
    const r = await fetch(`${CF}/__down?bytes=0&w=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw refused(r);
    await r.arrayBuffer();
  }));
}
const now = () => Number(process.hrtime.bigint()) / 1e6;

async function download() {
  await warmUp(DOWN_STREAMS);
  const t0 = now(), spans = [], marks = [], ends = [];   // marks: [time, bytes so far] as data arrives
  let total = 0;
  await Promise.all(Array.from({ length: DOWN_STREAMS }, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CAP_MS);
    try {
      for (let k = 0; k < DOWN_PIECES && now() - t0 < CAP_MS; k++) {
        const r = await fetch(`${CF}/__down?bytes=${PIECE}`, { signal: ac.signal, cache: 'no-store' });   // (Cloudflare refuses 100 MB)
        if (!r.ok) throw refused(r);                     // never retry a refusal in a loop
        const rd = r.body.getReader();
        let first = 0, last = 0;
        try {
          for (;;) {
            const { done, value } = await rd.read(); if (done) break;
            const t = now(); if (!first) first = t; last = t; total += value.length; marks.push([t, total]);
          }
        } finally { if (first) spans.push([first, last]); }  // from the first byte to the last (an abort keeps what came)
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
    finally { clearTimeout(timer); ends.push(now()); }
  }));
  // the steady part: from RAMP_MS after the first byte to when the first stream finished
  if (marks.length > 10) {
    const tFirst = marks[0][0], tEnd = Math.min(...ends);
    let a = tFirst + RAMP_MS;
    if (tEnd - a < 600) a = tFirst + (tEnd - tFirst) * 0.3;  // a short test: skip the first 30% instead
    const at = (t) => { let lo = 0, hi = marks.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (marks[m][0] <= t) lo = m; else hi = m - 1; } return marks[lo]; };
    const A = at(a), B = at(tEnd);
    if (B[0] - A[0] > 300) return (B[1] - A[1]) * 8 / ((B[0] - A[0]) / 1000) / 1e6;
  }
  const ms = busyTime(spans);                            // fallback: bytes over the time data moved
  return ms > 0 ? total * 8 / (ms / 1000) / 1e6 : 0;
}

async function upload(pingMs) {
  await warmUp();
  const body = Buffer.alloc(PIECE, 0x5a), t0 = now(), spans = [], rtt = Math.max(0, pingMs || 0);
  let total = 0;
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    for (let k = 0; k < PIECES && now() - t0 < CAP_MS; k++) {
      const a = now();
      const r = await fetch(`${CF}/__up`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(CAP_MS + 5000) });
      const b = now();                                  // the reply came: the data had arrived about one ping earlier
      await r.arrayBuffer();
      if (!r.ok) throw refused(r);
      spans.push([a, b - rtt]); total += PIECE;
    }
  }));
  const ms = busyTime(spans);
  return ms > 0 ? total * 8 / (ms / 1000) / 1e6 : 0;
}

// ---------- the official Speedtest by Ookla CLI, when it's installed ----------
// Lickety Split uses Ookla's own program (the speedtest.net engine) when it finds it: <install dir>/bin/speedtest, or
// LS_SPEEDTEST. It isn't in the repository (Ookla's license doesn't allow passing it on): download it from
// https://www.speedtest.net/apps/cli and put the `speedtest` file there. Its license is accepted on each run
// (--accept-license --accept-gdpr). If it's missing or a run fails, the built-in Cloudflare test runs instead.
const { execFile } = require('child_process');
const OOKLA = process.env.LS_SPEEDTEST || require('path').join(__dirname, 'bin', 'speedtest');
function ooklaReady() { try { require('fs').accessSync(OOKLA, require('fs').constants.X_OK); return true; } catch (e) { return false; } }
function ookla(home) {
  return new Promise((ok, no) => {
    execFile(OOKLA, ['--accept-license', '--accept-gdpr', '-f', 'json', '-p', 'no'],
      { timeout: 120000, maxBuffer: 1 << 20, env: Object.assign({}, process.env, home ? { HOME: home } : {}) }, (err, stdout, stderr) => {
        let j = null;
        for (const line of String(stdout || '').split('\n')) { try { const x = JSON.parse(line); if (x && x.type === 'result') j = x; } catch (e) { /* not JSON */ } }
        if (!j) {
          const why = (String(stderr || '').match(/\[error\].*|error.*$/im) || [])[0] || (err && err.message) || 'no result';
          return no(new Error('Speedtest (Ookla): ' + String(why).replace(/\s+/g, ' ').slice(0, 160)));
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

// Ookla's program first (when it's there), else the built-in test against Cloudflare.
async function runTest(opts) {
  const t = Date.now();
  if (ooklaReady()) {
    try { const r = await ookla(opts && opts.home); return Object.assign({ t }, r, { took: Date.now() - t }); }
    catch (e) { if (opts && opts.log) opts.log(e.message + ' (using the built-in test this time)'); }
  }
  const out = { t: Date.now(), engine: 'cloudflare' };
  const l = await latency();
  out.ping = l.ping; out.jitter = l.jitter;
  out.down = Math.round(await download() * 10) / 10;
  out.up = Math.round(await upload(l.ping) * 10) / 10;
  out.took = Date.now() - out.t;
  return out;
}

module.exports = { runTest, download, ooklaReady };
