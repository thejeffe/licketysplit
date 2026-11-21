'use strict';
// Internet speed test against Cloudflare's speed-test endpoints (no client software, no account):
//  - latency: the network round-trip Cloudflare measured on several tiny requests (median = ping, change between them = jitter)
//  - download and upload the same way: 4 streams of 2 x 25 MB each (about 200 MB, stopping at 10 s), counting only
//    the time data is moving (see busyTime). Download counts bytes as they arrive; upload counts pieces as Cloudflare
//    confirms them. (Upload used to send 48 MB in 4 MB
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
async function warmUp() { // a connection per stream, opened before the clock starts
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    const r = await fetch(`${CF}/__down?bytes=0&w=${Math.random()}`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw refused(r);
    await r.arrayBuffer();
  }));
}
const now = () => Number(process.hrtime.bigint()) / 1e6;

async function download() {
  await warmUp();
  const t0 = now(), spans = [];
  let total = 0;
  await Promise.all(Array.from({ length: STREAMS }, async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CAP_MS);
    try {
      for (let k = 0; k < PIECES && now() - t0 < CAP_MS; k++) {
        const r = await fetch(`${CF}/__down?bytes=${PIECE}`, { signal: ac.signal, cache: 'no-store' });   // (Cloudflare refuses 100 MB)
        if (!r.ok) throw refused(r);                     // never retry a refusal in a loop
        const rd = r.body.getReader();
        let first = 0, last = 0;
        try {
          for (;;) {
            const { done, value } = await rd.read(); if (done) break;
            const t = now(); if (!first) first = t; last = t; total += value.length;
          }
        } finally { if (first) spans.push([first, last]); }  // from the first byte to the last (an abort keeps what came)
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
    finally { clearTimeout(timer); }
  }));
  const ms = busyTime(spans);
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

async function runTest() {
  const out = { t: Date.now() };
  const l = await latency();
  out.ping = l.ping; out.jitter = l.jitter;
  out.down = Math.round(await download() * 10) / 10;
  out.up = Math.round(await upload(l.ping) * 10) / 10;
  out.took = Date.now() - out.t;
  return out;
}

module.exports = { runTest };
