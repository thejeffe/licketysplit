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
const netscan = require('./netscan');

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
const DEFAULT_NET = {
  enabled: false,       // check the network every hour
  subnet: '',           // '' = this server's own network
  dns: '',              // '' = the system's DNS server
  haUrl: 'http://homeassistant.local:8123',
  haToken: '',          // Home Assistant long-lived access token (never sent back to the page)
  piholeUrl: '',        // e.g. https://pi.hole (Pi-hole v6): host names, local DNS records, query counts
  piholePassword: '',   // its web password or an app password (never sent back to the page)
  piholeNames: false,   // give named devices without a DNS name a local DNS record in Pi-hole
  piholeSuffix: 'lan',  // ... as <name>.<suffix>
  piholeManaged: [],    // records Lickety Split made, by device: { mac, ip, host, seen, device }. The only ones it changes.
  piholeOverrides: {},  // per MAC: { host: 'my-name.lan' } (renamed on the page) or { skip: true } (removed: don't name it)
};
const DEFAULT_PING = { url: '', every: 60 };   // health ping (e.g. a healthchecks.io URL), seconds between pings
const DEFAULT_CONF = {
  owner: '',
  ping: DEFAULT_PING,
  devices: [],          // added on the page; saved in DATA_DIR/config.json
  net: DEFAULT_NET,
};
let conf;
function loadConf() {
  try { conf = Object.assign({}, DEFAULT_CONF, JSON.parse(fs.readFileSync(CONF_FILE, 'utf8'))); } catch (e) { conf = JSON.parse(JSON.stringify(DEFAULT_CONF)); }
  conf.net = Object.assign({}, DEFAULT_NET, conf.net || {});
  conf.ping = Object.assign({}, DEFAULT_PING, conf.ping || {});
}
function saveConf() {
  fs.mkdirSync(CFG.dataDir, { recursive: true });
  fs.writeFileSync(CONF_FILE + '.tmp', JSON.stringify(conf, null, 1), { mode: 0o600 }); fs.renameSync(CONF_FILE + '.tmp', CONF_FILE);
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
    if (!buf) { if (kind === 'factory') return { ok: false, error: `${rel.tag} isn\u2019t downloadable yet (GitHub is still publishing it). Try again in a minute.` }; continue; }
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

// Restart a device: WLED and Matrixinator take WLED's {"rb":true}; the AirPlay receiver has its own endpoint.
async function restart(dev) {
  const fw = fwById(dev.fw);
  const air = fw && fw.probe === 'airplay';
  const r = await fetch(`http://${dev.host}${air ? '/api/system/restart' : '/json/state'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: air ? '{}' : '{"rb":true}', signal: AbortSignal.timeout(6000),
  }).catch((e) => { if (e.name === 'TimeoutError' || /terminated|socket|reset/i.test(String(e.cause || e.message))) return { ok: true }; throw e; });
  if (!r.ok) throw new Error(`${dev.host} answered ${r.status}`);   // (a device may hang up as it restarts: that's fine)
  log(`Restarted ${dev.name} (${dev.host})`);
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

// ---------- network check (netscan.js) ----------
const NET_FILE = path.join(CFG.dataDir, 'network.json');
const NET_EVERY = 3600 * 1000;
let netResult = null, netRun = null, netError = null;
try { netResult = JSON.parse(fs.readFileSync(NET_FILE, 'utf8')); } catch (e) { /* none yet */ }
function publicNet() {
  const n = conf.net;
  return { enabled: n.enabled, subnet: n.subnet, dns: n.dns, haUrl: n.haUrl, haTokenSet: !!n.haToken,
    piholeUrl: n.piholeUrl, piholePasswordSet: !!n.piholePassword, piholeNames: n.piholeNames, piholeSuffix: n.piholeSuffix,
    piholeManaged: (n.piholeManaged || []).filter((m) => m && m.mac),
    piholeSkipped: Object.entries(n.piholeOverrides || {}).filter(([, o]) => o.skip).map(([mac]) => mac),
    autoSubnet: (netscan.localNets()[0] || {}).cidr || '' };
}
function scanNetwork() {
  if (netRun) return netRun;
  netRun = netscan.scan({ subnet: conf.net.subnet, dns: conf.net.dns, haUrl: conf.net.haUrl, haToken: conf.net.haToken,
    piholeUrl: conf.net.piholeUrl, piholePassword: conf.net.piholePassword, dataDir: CFG.dataDir })
    .then((r) => {
      netResult = netscan.merge(netResult, r); netError = null;
      return syncNames(netResult).then((sync) => { if (sync) netResult.piSync = sync; return r; });
    })
    .then((r) => {
      fs.writeFileSync(NET_FILE + '.tmp', JSON.stringify(netResult)); fs.renameSync(NET_FILE + '.tmp', NET_FILE);
      log(`Network check: ${r.hosts.length} devices in ${Math.round(r.took / 1000)} s (HA ${r.sources.ha}, Pi-hole ${r.sources.pihole}, mDNS ${r.sources.mdns}, DNS ${r.sources.dns})`);
      return netResult;
    })
    .catch((e) => { netError = e.message; log('Network check failed: ' + e.message); throw e; })
    .finally(() => { netRun = null; });
  return netRun;
}
function netTick() {
  if (conf.net.enabled && !netRun && (!netResult || Date.now() - netResult.at >= NET_EVERY)) scanNetwork().catch(() => {});
}
function cleanNet(b) {
  const n = Object.assign({}, conf.net);
  if ('enabled' in b) n.enabled = !!b.enabled;
  if ('subnet' in b) { const v = String(b.subnet || '').trim(); n.subnet = v ? netscan.parseCidr(v).cidr : ''; }
  if ('dns' in b) {
    const v = String(b.dns || '').trim();
    if (v && !require('net').isIP(v)) throw new Error('The DNS server should be an IP address.');
    n.dns = v;
  }
  if ('haUrl' in b) {
    const v = String(b.haUrl || '').trim().replace(/\/+$/, '');
    if (v && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(v)) throw new Error('Home Assistant\u2019s address should look like http://homeassistant.local:8123');
    n.haUrl = v;
  }
  if (typeof b.haToken === 'string' && b.haToken.trim()) n.haToken = b.haToken.trim().slice(0, 600);
  if ('piholeUrl' in b) {
    const v = String(b.piholeUrl || '').trim().replace(/\/+$/, '').replace(/\/admin$/, '');
    if (v && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(v)) throw new Error('Pi-hole\u2019s address should look like https://pi.hole');
    n.piholeUrl = v;
  }
  if (typeof b.piholePassword === 'string' && b.piholePassword) n.piholePassword = b.piholePassword.slice(0, 200);
  if ('piholeNames' in b) n.piholeNames = !!b.piholeNames;
  n.piholeOverrides = n.piholeOverrides || {};
  if ('piholeSuffix' in b) {
    const v = String(b.piholeSuffix || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
    if (!/^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?){0,3}$/.test(v)) throw new Error('The name ending should be like lan or home.arpa');
    n.piholeSuffix = v;
  }
  if (b.haTokenClear) n.haToken = '';
  return n;
}

// per device (MAC): its DNS name, or the name Lickety Split suggests (and would give it in Pi-hole)
function dnsNames() {
  const out = {};
  if (!netResult) return out;
  const n = conf.net, suffix = n.piholeSuffix || 'lan';
  const managed = (n.piholeManaged || []).filter((m) => m && m.mac);
  const ourHosts = new Set(managed.map((m) => m.host));
  for (const m of managed) out[m.mac] = { dns: m.host, ours: true };
  // what a naming run would do now, ignoring "removed" marks only for showing (removed ones show no suggestion)
  const plan = netscan.planNames(netResult, { managed, suffix, overrides: n.piholeOverrides || {}, piRecords: (netResult.piRecords || []).concat(managed.map((m) => `${m.ip} ${m.host}`)) });
  for (const e of plan.want) if (!out[e.mac]) out[e.mac] = { suggest: e.host };
  for (const h of netResult.hosts) {
    const own = (h.dnsAll || []).filter((x) => !ourHosts.has(x));
    if (h.mac && own.length) out[h.mac] = { dns: own[0] };
  }
  return out;
}

// local DNS records in Pi-hole for devices that have a name but no DNS name (setting "piholeNames")
let lastOnline = 0;
async function syncNames(r, why) {
  const n = conf.net, managed = (n.piholeManaged || []).filter((m) => m && m.mac);
  if (!n.piholeUrl || !n.piholePassword || !r || (r.sources && r.sources.pihole !== 'ok')) return null;
  if (!n.piholeNames && !managed.length) return null;
  const online = r.hosts.filter((h) => h.online && h.ip).length;
  // safety brake: a check that saw far fewer devices than before (Wi-Fi blip, wrong network) changes nothing
  if (why !== 'page' && lastOnline && online < lastOnline * 0.5) {
    log(`Pi-hole names: only ${online} devices seen (was ${lastOnline}); not changing anything this time`);
    return { at: Date.now(), added: [], removed: [], count: managed.length, error: `Only ${online} devices answered (usually ${lastOnline}), so nothing was changed this time.` };
  }
  lastOnline = Math.max(online, Math.round(lastOnline * 0.9));
  const suffix = n.piholeSuffix || 'lan';
  try {
    const res = await netscan.piholeSync(n.piholeUrl, n.piholePassword, (records) => {
      const p = n.piholeNames ? netscan.planNames(r, { managed, suffix, overrides: n.piholeOverrides || {}, piRecords: records })
        : { want: [], userRemoved: [] };
      return Object.assign(p, { managed });
    });
    n.piholeOverrides = n.piholeOverrides || {};
    for (const mac of res.userRemoved) (n.piholeOverrides[mac] = n.piholeOverrides[mac] || {}).skip = true;
    n.piholeManaged = res.want; saveConf();
    const plan = res;
    if (res.added.length || res.removed.length || plan.userRemoved.length)
      log(`Pi-hole names: ${res.added.length} added, ${res.removed.length} removed, ${plan.userRemoved.length} removed by hand`);
    return { at: Date.now(), added: res.added, removed: res.removed, count: plan.want.length, error: null };
  } catch (e) {
    saveConf();
    log('Pi-hole names: ' + e.message);
    return { at: Date.now(), added: [], removed: [], count: managed.length, error: e.message };
  }
}

// ---------- health ping: "I'm alive" to a monitoring URL (healthchecks.io and similar) ----------
let pingLast = null;      // { at, ok, status }
let pingBusy = false;
async function pingNow() {
  const u = conf.ping.url;
  if (!u || pingBusy) return;
  pingBusy = true;
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'licketysplit' }, signal: AbortSignal.timeout(10000) });
    pingLast = { at: Date.now(), ok: r.ok, status: 'HTTP ' + r.status };
    if (!r.ok) log(`Health ping: HTTP ${r.status}`);
  } catch (e) {
    pingLast = { at: Date.now(), ok: false, status: e.name === 'TimeoutError' ? 'no answer' : String((e.cause && e.cause.code) || e.message) };
    log('Health ping failed: ' + pingLast.status);
  } finally { pingBusy = false; }
}
function pingTick() {
  if (conf.ping.url && (!pingLast || Date.now() - pingLast.at >= conf.ping.every * 1000 - 2000)) pingNow();
}
function publicPing() {
  let host = '';
  try { host = conf.ping.url ? new URL(conf.ping.url).host : ''; } catch (e) { /* bad url */ }
  return { set: !!conf.ping.url, host, every: conf.ping.every, last: pingLast };
}
function cleanPing(b) {
  const p = Object.assign({}, conf.ping);
  if (typeof b.url === 'string' && b.url.trim()) {
    const v = b.url.trim();
    if (!/^https?:\/\/[^\s]+$/.test(v) || v.length > 500) throw new Error('The health ping should be a web address, like https://hc-ping.com/…');
    p.url = v;
  }
  if (b.clear) p.url = '';
  if ('every' in b) p.every = [60, 300, 900, 3600].includes(+b.every) ? +b.every : 60;
  return p;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.bin': 'application/octet-stream' };
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
      return send(res, 200, { owner: conf.owner, firmware: catalog(), devices: conf.devices, ota: otaRuns, refreshing: !!refreshing, lastRefresh: lastRefresh.at, tokenSet: !!CFG.token, net: publicNet(), ping: publicPing() });
    }
    if (p === '/api/settings' && req.method === 'PUT') {
      const b = await readBody(req);
      if ('owner' in b) {
        const owner = String(b.owner || '').trim();
        if (owner && !/^[A-Za-z0-9-]{1,39}$/.test(owner)) throw new Error('That isn’t a GitHub user or organization name.');
        conf.owner = owner;
      }
      const wasOn = conf.net.enabled;
      if (b.net && typeof b.net === 'object') conf.net = cleanNet(b.net);
      const hadPing = conf.ping.url;
      if (b.ping && typeof b.ping === 'object') conf.ping = cleanPing(b.ping);
      if (conf.ping.url && conf.ping.url !== hadPing) { pingLast = null; setTimeout(pingTick, 100); }
      saveConf();
      if (conf.net.enabled && !wasOn) netTick();
      return send(res, 200, { owner: conf.owner, net: publicNet(), ping: publicPing() });
    }
    if (p === '/api/network' && req.method === 'GET') {
      return send(res, 200, { settings: publicNet(), scanning: !!netRun, error: netError, result: netResult, names: dnsNames() });
    }
    if (p === '/api/network/names' && req.method === 'POST') {       // rename / remove / allow again one Pi-hole name
      const b = await readBody(req), mac = String(b.mac || '').toLowerCase();
      if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) throw new Error('Which device?');
      const o = conf.net.piholeOverrides = conf.net.piholeOverrides || {};
      if (b.action === 'remove') o[mac] = { skip: true };
      else if (b.action === 'allow') delete o[mac];
      else if (b.action === 'rename') {
        const suffix = conf.net.piholeSuffix || 'lan';
        let h = String(b.host || '').trim().toLowerCase().replace(/\.+$/, '');
        if (h && !h.includes('.')) h += '.' + suffix;
        if (!/^[a-z0-9]([a-z0-9-]{0,62})(\.[a-z0-9]([a-z0-9-]{0,62}))+$/.test(h)) throw new Error('Use letters, numbers and dashes, like kitchen-plug');
        const clash = (conf.net.piholeManaged || []).find((m) => m.host === h && m.mac !== mac);
        if (clash) throw new Error(`${h} is already ${clash.device || clash.ip}`);
        o[mac] = { host: h };
      } else throw new Error('Unknown action.');
      saveConf();
      const sync = netResult ? await syncNames(netResult, 'page') : null;
      if (sync && netResult) netResult.piSync = sync;
      return send(res, 200, { settings: publicNet(), sync, names: dnsNames() });
    }
    if (p === '/api/network/scan' && req.method === 'POST') {
      const r = await scanNetwork();
      return send(res, 200, { settings: publicNet(), scanning: false, error: null, result: r, names: dnsNames() });
    }
    if (p === '/api/refresh' && req.method === 'POST') { const r = await refreshAll(); return send(res, 200, { results: r.results, firmware: catalog() }); }
    if (p === '/api/devices' && req.method === 'POST') {
      if (conf.devices.length >= 50) throw new Error('That’s a lot of devices. Remove some first.');
      const d = Object.assign({ id: 'd' + crypto.randomBytes(4).toString('hex') }, cleanDevice(await readBody(req)));
      conf.devices.push(d); saveConf(); return send(res, 200, d);
    }
    let m = p.match(/^\/api\/devices\/([\w-]{1,40})(\/probe|\/ota|\/restart)?$/);
    if (m) {
      const dev = conf.devices.find((d) => d.id === m[1]);
      if (!dev) return send(res, 404, { error: 'No such device.' });
      if (!m[2] && req.method === 'PUT') { Object.assign(dev, cleanDevice(await readBody(req))); saveConf(); return send(res, 200, dev); }
      if (!m[2] && req.method === 'DELETE') { conf.devices = conf.devices.filter((d) => d !== dev); saveConf(); return send(res, 200, { ok: true }); }
      if (m[2] === '/probe' && req.method === 'GET') return send(res, 200, await probe(dev));
      if (m[2] === '/restart' && req.method === 'POST') { await restart(dev); return send(res, 200, { ok: true }); }
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
setTimeout(netTick, 20000);
setInterval(netTick, 60000);
setTimeout(pingTick, 5000);
setInterval(pingTick, 10000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
