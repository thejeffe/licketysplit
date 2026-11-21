'use strict';
// Internet speed test against Cloudflare's speed-test endpoints (no client software, no account):
//  - latency: the network round-trip Cloudflare measured on several tiny requests (median = ping, change between them = jitter)
//  - download and upload the same way: 4 streams of 2 x 25 MB each (about 200 MB, stopping at 10 s). Download counts
//    bytes as they arrive; upload counts pieces as Cloudflare confirms them. (Upload used to send 48 MB in 4 MB
//    pieces, waiting for each reply: on a gigabit line that read ~150 Mbps low.)
// Results are Mbps. Numbers are what this server sees: a VM on a gigabit LAN usually measures the
// internet line itself; a slow Wi-Fi client would see less.
const CF = process.env.LS_SPEED_BASE || 'https://speed.cloudflare.com';
const STREAMS = 4, CAP_MS = 10000;
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

async function download() {
  const t0 = Date.now();
  let total = 0;
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CAP_MS);
    try {
      for (let k = 0; k < PIECES && Date.now() - t0 < CAP_MS; k++) {
        const r = await fetch(`${CF}/__down?bytes=${PIECE}`, { signal: ac.signal, cache: 'no-store' });   // (Cloudflare refuses 100 MB)
        if (!r.ok) throw refused(r);                     // never retry a refusal in a loop
        const rd = r.body.getReader();
        for (;;) { const { done, value } = await rd.read(); if (done) break; total += value.length; }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
    finally { clearTimeout(timer); }
  }));
  return total * 8 / ((Date.now() - t0) / 1000) / 1e6;
}

async function upload() {
  const body = Buffer.alloc(PIECE, 0x5a), t0 = Date.now();
  let total = 0;
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    for (let k = 0; k < PIECES && Date.now() - t0 < CAP_MS; k++) {
      const r = await fetch(`${CF}/__up`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(CAP_MS + 5000) });
      await r.arrayBuffer();
      if (!r.ok) throw refused(r);
      total += PIECE;
    }
  }));
  return total * 8 / ((Date.now() - t0) / 1000) / 1e6;
}

async function runTest() {
  const out = { t: Date.now() };
  const l = await latency();
  out.ping = l.ping; out.jitter = l.jitter;
  out.down = Math.round(await download() * 10) / 10;
  out.up = Math.round(await upload() * 10) / 10;
  out.took = Date.now() - out.t;
  return out;
}

module.exports = { runTest };
