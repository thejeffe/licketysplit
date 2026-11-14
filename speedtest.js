'use strict';
// Internet speed test against Cloudflare's speed-test endpoints (no client software, no account):
//  - latency: the network round-trip Cloudflare measured on several tiny requests (median = ping, change between them = jitter)
//  - download: 4 streams of 2 x 25 MB (stopping at 10 s), counting bytes as they arrive
//  - upload: 3 streams of 4 x 4 MB (stopping at 10 s), counting chunks that completed
// Results are Mbps. Numbers are what this server sees: a VM on a gigabit LAN usually measures the
// internet line itself; a slow Wi-Fi client would see less.
const CF = process.env.LS_SPEED_BASE || 'https://speed.cloudflare.com';
const STREAMS_DOWN = 4, STREAMS_UP = 3, CAP_MS = 10000, CHUNK = 4 * 1024 * 1024;
// a fixed budget per test (about 200 MB down, 48 MB up), so hourly tests stay well inside Cloudflare's limits
const DOWN_PIECE = 25 * 1000 * 1000, DOWN_PIECES = 2, UP_PIECES = 4;

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
  await Promise.all(Array.from({ length: STREAMS_DOWN }, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CAP_MS);
    try {
      for (let k = 0; k < DOWN_PIECES && Date.now() - t0 < CAP_MS; k++) {
        const r = await fetch(`${CF}/__down?bytes=${DOWN_PIECE}`, { signal: ac.signal, cache: 'no-store' });   // (Cloudflare refuses 100 MB)
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
  const body = Buffer.alloc(CHUNK, 0x5a), t0 = Date.now();
  let total = 0;
  await Promise.all(Array.from({ length: STREAMS_UP }, async () => {
    for (let k = 0; k < UP_PIECES && Date.now() - t0 < CAP_MS; k++) {
      const r = await fetch(`${CF}/__up`, { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream' }, signal: AbortSignal.timeout(CAP_MS + 5000) });
      await r.arrayBuffer();
      if (!r.ok) throw refused(r);
      total += CHUNK;
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
