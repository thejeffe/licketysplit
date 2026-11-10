'use strict';
// Lickety Split: flash and update Jeff's ESP32 devices from a web page.
//  - "Flash over USB": ESP Web Tools in the browser (Chrome/Edge), using full images built by GitHub Actions.
//  - "Update over Wi-Fi": this server pushes the app image to a device's own OTA endpoint.
// Firmware comes from GitHub Releases; this server copies the files here (browsers can't download GitHub release
// files directly) and serves an ESP Web Tools manifest for each one. No npm dependencies.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CFG = {
  port: +(process.env.PORT || 8110),
  bind: process.env.BIND || '127.0.0.1',
  dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
  token: process.env.GITHUB_TOKEN || '',        // only needed for private repos
};
const PUBLIC = path.join(__dirname, 'public');
const FW_DIR = path.join(CFG.dataDir, 'firmware');
const CONF_FILE = path.join(CFG.dataDir, 'config.json');
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(:\d{1,5})?$/;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- what can be flashed ----------
// repo: "{owner}/name" uses the GitHub owner from Settings. tag: which releases belong to this firmware.
// ota: how a running device takes an update ("multipart" form upload like WLED, or the raw .bin as the body).
const FIRMWARE = [
  { id: 'matrixinator', name: 'Matrixinator', what: 'Shows the LED sign on the 4" touch screen (acts like WLED for Signinator).',
    board: 'Guition ESP32-S3-4848S040', chip: 'ESP32-S3', repo: '{owner}/matrixinator', tag: /^v\d/,
    factory: 'matrixinator-4848s040-factory.bin', ota: 'matrixinator-4848s040-ota.bin',
    otaMode: 'multipart', otaPath: '/update', improv: true, probe: 'wled' },
  { id: 'airplay', name: 'AirPlay receiver + album art', what: 'airplay-esp32 with the Signinator now-playing forwarder (Marantz Stereo).',
    board: 'ESP32-S3 + I2S DAC', chip: 'ESP32-S3', repo: '{owner}/airplay-esp32', tag: /^signinator-v/,
    factory: 'airplay-signinator-esp32s3-factory.bin', ota: 'airplay-signinator-esp32s3-ota.bin',
    otaMode: 'raw', otaPath: '/api/ota/update', improv: false, probe: 'airplay' },
  { id: 'wled-esp32', name: 'WLED (ESP32)', what: 'WLED for the sign and tree LED controllers ("ESP32" build), with temporal dithering (Config → Usermods).',
    board: 'ESP32 / ESP32-WROVER', chip: 'ESP32', repo: '{owner}/licketysplit', tag: /^wled-v/,
    factory: 'wled-esp32-factory.bin', ota: 'wled-esp32-ota.bin',
    otaMode: 'multipart', otaPath: '/update', improv: true, probe: 'wled' },
];
const fwById = (id) => FIRMWARE.find((f) => f.id === id);

// ---------- saved settings ----------
const DEFAULT_CONF = {
  owner: '',
  devices: [
    { id: 'sign', name: 'Signinator sign', host: '1.led.jeffsawyer.us', fw: 'wled-esp32' },
    { id: 'tree', name: 'Treeinator tree', host: '3.led.jeffsawyer.us', fw: 'wled-esp32' },
    { id: 'marantz', name: 'Marantz Stereo', host: '192.168.215.36', fw: 'airplay' },
  ],
};
let conf;
function loadConf() {
  try { conf = Object.assign({}, DEFAULT_CONF, JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))); } catch (e) { conf = JSON.parse(JSON.stringify(DEFAULT_CONF)); }
}
function saveConf() {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(CONF_FILE + '.tmp', JSON.stringify(conf, null, 1)); fs.renameSync(CONF_FILE + '.tmp', CONF_FILE);
}

// ---------- firmware store ----------
// FW_DIR/<id>/current.json = { tag, version, published, url, files: { factory: {name, size, sha256}, ota: {...} }, fetched }
function current(id) { try { return JSON.parse(fs.readFileSync(path.join(FW_DIR, id, 'current.json'), 'utf8')); } catch (e) { return null; } }
const versionOf = (tag) => tag.replace(/^(signinator-|wled-)?v/, '');

// GitHub allows 60 API requests an hour without a token. Release lists are asked with ETags (an unchanged
// answer, 304, doesn't count) and public files come from the normal download links (not the API).
const etags = {};   // url -> { etag, body }
async function gh(url, accept) {
  const headers = { 'User-Agent': 'licketysplit', Accept: accept || 'application/vnd.github+json' };
  if (CFG.token) headers.Authorization = 'Bearer ' + CFG.token;
  const cached = !accept && etags[url];
  if (cached) headers['If-None-Match'] = cached.etag;
  const r = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (r.status === 304 && cached) return { json: async () => cached.body };
  if (!r.ok) {
    const left = r.headers.get('x-ratelimit-remaining'), reset = +r.headers.get('x-ratelimit-reset');
    if ((r.status === 403 || r.status === 429) && left === '0')
      throw new Error(`GitHub's limit for checks without a token is used up until ${new Date(reset * 1000).toLocaleTimeString()}.`);
    throw new Error(`GitHub ${r.status} for ${url.replace('https://api.github.com', '')}`);
  }
  if (!accept && r.headers.get('etag')) {
    const body = await r.json();
    etags[url] = { etag: r.headers.get('etag'), body };
    return { json: async () => body };
  }
  return r;
}

let refreshing = null, lastRefresh = { at: 0, results: {} };
// Without a token: the public release feed (releases.atom) and the normal download links, which don't use
// GitHub's API limit (60 an hour per internet address). With GITHUB_TOKEN: the API (works for private repos).
async function latestRelease(repo, fw) {
  if (CFG.token) {
    const rels = await (await gh(`https://api.github.com/repos/${repo}/releases?per_page=30`)).json();
    const rel = rels.find((r) => !r.draft && fw.tag.test(r.tag_name) && r.assets.some((a) => a.name === fw.factory));
    if (!rel) return null;
    const asset = (name) => { const a = rel.assets.find((x) => x.name === name); return a && { url: a.url, size: a.size, api: true }; };
    return { tag: rel.tag_name, published: rel.published_at, url: rel.html_url, factory: asset(fw.factory), ota: asset(fw.ota) };
  }
  const r = await fetch(`https://github.com/${repo}/releases.atom`, { headers: { 'User-Agent': 'licketysplit' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`GitHub ${r.status} for ${repo}/releases.atom`);
  const xml = await r.text();
  for (const e of xml.split('<entry>').slice(1)) {
    const tag = decodeURIComponent((/\/releases\/tag\/([^"]+)"/.exec(e) || [])[1] || '');
    if (!tag || !fw.tag.test(tag)) continue;
    const dl = (name) => ({ url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${name}` });
    return { tag, published: (/<updated>([^<]+)</.exec(e) || [])[1], url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
      factory: dl(fw.factory), ota: dl(fw.ota) };
  }
  return null;
}
async function download(a) {
  const r = a.api ? await gh(a.url, 'application/octet-stream')
    : await fetch(a.url, { headers: { 'User-Agent': 'licketysplit' }, redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`Download failed: HTTP ${r.status} for ${a.url.replace(/^https:\/\/[^/]+/, '')}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (a.size != null && buf.length !== a.size) throw new Error(`Got ${buf.length} bytes, expected ${a.size}`);
  return buf;
}

async function refreshOne(fw) {
  if (!conf.owner) return { ok: false, error: 'Set the GitHub owner first.' };
  const repo = fw.repo.replace('{owner}', conf.owner);
  const rel = await latestRelease(repo, fw);
  if (!rel) return { ok: false, error: `No release in ${repo} has ${fw.factory} yet.` };
  const cur = current(fw.id);
  if (cur && cur.tag === rel.tag) return { ok: true, tag: rel.tag, changed: false };
  const dir = path.join(FW_DIR, fw.id, rel.tag);
  const files = {};
  for (const kind of ['factory', 'ota']) {
    if (!rel[kind]) continue;
    const buf = await download(rel[kind]);
    if (!buf) { if (kind === 'factory') return { ok: false, error: `${rel.tag} has no ${fw.factory}.` }; continue; }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fw[kind]), buf);
    files[kind] = { name: fw[kind], size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
  }
  const info = { tag: rel.tag, version: versionOf(rel.tag), published: rel.published, url: rel.url, files, fetched: new Date().toISOString() };
  fs.writeFileSync(path.join(FW_DIR, fw.id, 'current.json'), JSON.stringify(info, null, 1));
  // keep the newest 3 versions
  const old = fs.readdirSync(path.join(FW_DIR, fw.id), { withFileTypes: true }).filter((d) => d.isDirectory())
    .map((d) => ({ n: d.name, t: fs.statSync(path.join(FW_DIR, fw.id, d.name)).mtimeMs })).sort((a, b) => b.t - a.t).slice(3);
  for (const o of old) fs.rmSync(path.join(FW_DIR, fw.id, o.n), { recursive: true, force: true });
  log(`${fw.id}: now ${rel.tag}`);
  return { ok: true, tag: rel.tag, changed: true };
}
function refreshAll() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const results = {};
    for (const fw of FIRMWARE) {
      try { results[fw.id] = await refreshOne(fw); } catch (e) { results[fw.id] = { ok: false, error: e.message }; log(`${fw.id}: ${e.message}`); }
    }
    lastRefresh = { at: Date.now(), results };
    return lastRefresh;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function catalog() {
  return FIRMWARE.map((f) => ({ id: f.id, name: f.name, what: f.what, board: f.board, chip: f.chip, improv: f.improv,
    repo: conf.owner ? f.repo.replace('{owner}', conf.owner) : null, current: current(f.id),
    status: lastRefresh.results[f.id] || null }));
}
function manifest(fw) {
  const cur = current(fw.id);
  if (!cur || !cur.files.factory) return null;
  return {
    name: fw.name, version: cur.version, new_install_prompt_erase: true,
    new_install_improv_wait_time: fw.improv ? 20 : 0,
    builds: [{ chipFamily: fw.chip, improv: fw.improv, parts: [{ path: `/fw/${fw.id}/${encodeURIComponent(cur.tag)}/${cur.files.factory.name}`, offset: 0 }] }],
  };
}

// ---------- devices on the network ----------
async function getJson(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms || 4000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function probe(dev) {
  const fw = fwById(dev.fw);
  const out = { id: dev.id, online: false, version: null, detail: '' };
  try {
    if (fw && fw.probe === 'airplay') {
      const j = await getJson(`http://${dev.host}/api/system/info`);
      const i = j.info || {};
      Object.assign(out, { online: true, version: i.firmware_version || null, detail: i.device_name || '' });
    } else {
      const i = await getJson(`http://${dev.host}/json/info`);
      const m = /matrixinator-(.+)$/.exec(i.ver || '');
      const ver = m ? m[1] : i.ver ? i.ver + (i.dither && i.dither.fw ? '-' + i.dither.fw : '') : null;
      Object.assign(out, { online: true, version: ver, detail: [i.name, i.release || i.arch, i.leds ? i.leds.count + ' LEDs' : ''].filter(Boolean).join(' · ') });
      if (i.release) out.release = i.release;
    }
  } catch (e) { out.detail = e.name === 'TimeoutError' ? 'no answer' : e.message; }
  return out;
}

const otaRuns = {}; // device id -> { state: 'sending' | 'done' | 'error', msg, at }
async function ota(dev) {
  const fw = fwById(dev.fw), cur = fw && current(fw.id);
  if (!cur || !cur.files.ota) throw new Error('No Wi-Fi update file for this firmware yet. Check for new builds first.');
  const bin = fs.readFileSync(path.join(FW_DIR, fw.id, cur.tag, cur.files.ota.name));
  let body, type;
  if (fw.otaMode === 'raw') { body = bin; type = 'application/octet-stream'; }
  else {
    const b = '----licketysplit' + crypto.randomBytes(8).toString('hex');
    body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="update"; filename="${cur.files.ota.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bin, Buffer.from(`\r\n--${b}--\r\n`)]);
    type = 'multipart/form-data; boundary=' + b;
  }
  log(`OTA ${dev.name} (${dev.host}) <- ${fw.id} ${cur.tag}, ${bin.length} bytes`);
  const r = await fetch(`http://${dev.host}${fw.otaPath}`, { method: 'POST', body, headers: { 'Content-Type': type }, signal: AbortSignal.timeout(180000) });
  const raw = await r.text();
  // devices answer with plain text or a whole web page: keep only readable words
  const text = raw.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!r.ok || /update failed|failed!/i.test(text)) throw new Error(`${dev.host} answered ${r.status}${text ? ': ' + text : ''}`);
  return `${fw.name} ${cur.version} sent to ${dev.name}; it restarts by itself.`;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.bin': 'application/octet-stream' };
function send(res, code, body, type, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type || 'application/json', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 64 * 1024) { reject(new Error('Too much data.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(n ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('Bad JSON.')); } });
    req.on('error', reject);
  });
}
function cleanDevice(b) {
  const name = String(b.name || '').trim().slice(0, 60), host = String(b.host || '').trim();
  if (!name) throw new Error('Give the device a name.');
  if (!HOST_RE.test(host)) throw new Error('Host should be a hostname or IP address, like 192.168.1.50.');
  if (!fwById(b.fw)) throw new Error('Pick the firmware it runs.');
  return { name, host, fw: b.fw };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), p = url.pathname;
  try {
    if (p === '/api/state' && req.method === 'GET') {
      return send(res, 200, { owner: conf.owner, firmware: catalog(), devices: conf.devices, ota: otaRuns, refreshing: !!refreshing, lastRefresh: lastRefresh.at, tokenSet: !!CFG.token });
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req), owner = String(b.owner || '').trim();
      if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new Error('That isn’t a GitHub user or organization name.');
      conf.owner = owner; saveConf(); return send(res, 200, { owner });
    }
    if (p === '/api/refresh' && req.method === 'POST') { const r = await refreshAll(); return send(res, 200, { results: r.results, firmware: catalog() }); }
    if (p === '/api/devices' && req.method === 'POST') {
      if (conf.devices.length >= 50) throw new Error('That’s a lot of devices. Remove some first.');
      const d = Object.assign({ id: 'd' + crypto.randomBytes(4).toString('hex') }, cleanDevice(await readBody(req)));
      conf.devices.push(d); saveConf(); return send(res, 200, d);
    }
    let m = p.match(/^\/api\/devices\/([\w-]{1,40})(\/probe|\/ota)?$/);
    if (m) {
      const dev = conf.devices.find((d) => d.id === m[1]);
      if (!dev) return send(res, 404, { error: 'No such device.' });
      if (!m[2] && req.method === 'PUT') { Object.assign(dev, cleanDevice(await readBody(req))); saveConf(); return send(res, 200, dev); }
      if (!m[2] && req.method === 'DELETE') { conf.devices = conf.devices.filter((d) => d !== dev); saveConf(); return send(res, 200, { ok: true }); }
      if (m[2] === '/probe' && req.method === 'GET') return send(res, 200, await probe(dev));
      if (m[2] === '/ota' && req.method === 'POST') {
        if (otaRuns[dev.id] && otaRuns[dev.id].state === 'sending') return send(res, 409, { error: 'An update is already running for this device.' });
        otaRuns[dev.id] = { state: 'sending', msg: 'Sending the update…', at: Date.now() };
        ota(dev).then((msg) => { otaRuns[dev.id] = { state: 'done', msg, at: Date.now() }; log(msg); })
          .catch((e) => { otaRuns[dev.id] = { state: 'error', msg: e.message, at: Date.now() }; log(`OTA ${dev.name} failed: ${e.message}`); });
        return send(res, 202, otaRuns[dev.id]);
      }
    }
    m = p.match(/^\/fw\/([\w-]+)\/manifest\.json$/);
    if (m) { const fw = fwById(m[1]), mf = fw && manifest(fw); return mf ? send(res, 200, mf) : send(res, 404, { error: 'No build yet.' }); }
    m = p.match(/^\/fw\/([\w-]+)\/([\w.%-]+)\/([\w.-]+\.bin)$/);
    if (m && fwById(m[1])) {
      const file = path.join(FW_DIR, m[1], decodeURIComponent(m[2]), m[3]);
      if (!file.startsWith(FW_DIR + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
      return fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, buf, MIME['.bin'], { 'Cache-Control': 'public, max-age=86400' }));
    }
    if (p === '/health') return send(res, 200, { ok: true });
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => err ? send(res, 404, 'Not found', 'text/plain')
      : send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': file.includes('/vendor/') ? 'public, max-age=86400' : 'no-cache' }));
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

loadConf();
fs.mkdirSync(FW_DIR, { recursive: true });
server.listen(CFG.port, CFG.bind, () => log(`Lickety Split on http://${CFG.bind}:${CFG.port} · data ${CFG.dataDir} · GitHub owner ${conf.owner || '(not set)'}`));
setTimeout(() => refreshAll(), 5000);
setInterval(() => refreshAll(), 6 * 3600 * 1000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
