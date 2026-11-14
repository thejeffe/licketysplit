'use strict';
// Duck Hunting: home checks every minute, a report on the page, and email when something goes wrong.
//  - Home Assistant (one template call): reachable, locks unlocked too long or jammed, garage open too long, broken automations (switched off is fine),
//    devices with every entity unavailable, low batteries, updates waiting
//  - Pi-hole: answering DNS, blocking on, block lists fresh, Pi-hole update waiting
//  - your devices (the Firmware tab's list) and extra web addresses to watch (Signinator, tree-show, ...)
//  - this server: free disk space
// Problems are "alerts" (something is wrong: emails) or "notices" (worth knowing: listed, and in the weekly summary).
// An alert only counts once it has lasted GRACE (doors and garage use their own open-too-long times instead).
// Email: Gmail (or any SMTP server with TLS on port 465) with an app password. No npm packages.
const fs = require('fs');
const os = require('os');
const tls = require('tls');
const dns = require('dns');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');

const FAST = process.env.LS_MONITOR_FAST === '1';   // tests only: no waiting
const GRACE = FAST ? 0 : 3 * 60000;           // an alert must last this long before it counts
const EMAIL_GAP = FAST ? 0 : 10 * 60000;      // at most one "something's wrong" email per this long (new problems wait and batch)
const CLEAR_AFTER = FAST ? 0 : 5 * 60000;     // all clear once everything has been fine this long
const PIHOLE_EVERY = 5 * 60000;

const DEFAULTS = {
  enabled: false,
  every: 5,              // minutes between checks
  ducks: {},             // which ducks are hunted: { locks: false, ... } (missing = on)
  ignore: [],            // problem ids you chose to ignore (e.g. a lock's unreliable door sensor)
  to: '',                // where the email goes (comma-separated)
  from: '',              // the Gmail address that sends it
  password: '',          // its app password (never sent back to the page)
  smtpHost: 'smtp.gmail.com', smtpPort: 465,
  doorMin: 15, garageMin: 30, battery: 15, diskGb: 1,
  weeklyDay: 1, weeklyHour: 8,  // Monday 8:00 (local time); weeklyDay -1 = no weekly summary
  notifyNew: true, notifyClear: true,
  watch: [],             // [{ name, url }] extra web addresses that should answer
  ducks: {},
  // Proxmox: API token (Datacenter -> Permissions -> API Tokens; a user with the PVEAuditor role on /)
  pveUrl: '', pveToken: '', pveSecret: '', pveFingerprint: '',   // the certificate's fingerprint, pinned at first contact
  services: ['signinator', 'tree-show', 'shairport-sync', 'nqptp', 'caddy'],   // systemd services on this server that must run
  printerUrl: '', tonerPct: 10,                                   // an HP printer's address (its web page), toner alert level
  ringBattery: 20,                                                // Ring camera battery alert level (%)
};

// ---------- https with a pinned certificate (Proxmox's is self-signed) ----------
function webGet(url, { headers, fingerprint, timeout } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url), mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({ hostname: u.hostname, port: u.port || (mod === https ? 443 : 80), path: u.pathname + u.search, method: 'GET',
      headers: headers || {}, rejectUnauthorized: false, checkServerIdentity: () => undefined, timeout: timeout || 15000 }, (res) => {
      const cert = mod === https && res.socket.getPeerCertificate ? res.socket.getPeerCertificate() : null;
      const fp = (cert && cert.fingerprint256) || '';
      if (fingerprint && fp !== fingerprint) { res.destroy(); return reject(new Error(`its certificate changed (now ${fp.slice(0, 23)}\u2026). If that was you, save the Proxmox settings again to accept it.`)); }
      let b = '';
      res.on('data', (d) => { if (b.length < 8e6) b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, fingerprint: fp }));
    });
    req.on('timeout', () => req.destroy(new Error('no answer')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'connection refused' : e.code === 'ENOTFOUND' ? `can\u2019t find ${u.hostname}` : e.message)));
    req.end();
  });
}

// ---------- Proxmox ----------
async function proxmoxCheck(c, pin) {
  const base = c.pveUrl.replace(/\/+$/, '');
  const headers = { Authorization: `PVEAPIToken=${c.pveToken}=${c.pveSecret}` };
  let fingerprint = c.pveFingerprint;
  const api = async (p) => {
    const r = await webGet(base + '/api2/json' + p, { headers, fingerprint });
    if (!fingerprint && r.fingerprint) { fingerprint = r.fingerprint; pin(fingerprint); }
    if (r.status === 401) throw new Error('Proxmox refused the token (check the token id and secret)');
    if (r.status === 403) { const e = new Error('no permission'); e.forbidden = true; throw e; }
    if (r.status !== 200) throw new Error(`Proxmox answered ${r.status}`);
    return JSON.parse(r.body).data;
  };
  const res = await api('/cluster/resources');
  const out = { nodes: [], guests: [], storage: [], disks: [], pools: [], failedBackups: [], updates: {}, noUpdatePerm: false };
  for (const r of res) {
    if (r.type === 'node') out.nodes.push({ name: r.node, status: r.status, mem: r.mem, maxmem: r.maxmem, disk: r.disk, maxdisk: r.maxdisk, uptime: r.uptime });
    else if (r.type === 'qemu' || r.type === 'lxc') out.guests.push({ vmid: r.vmid, name: r.name || String(r.vmid), node: r.node, status: r.status, template: !!r.template, kind: r.type === 'qemu' ? 'VM' : 'container' });
    else if (r.type === 'storage') out.storage.push({ name: r.storage, node: r.node, status: r.status, disk: r.disk, maxdisk: r.maxdisk, shared: !!r.shared });
  }
  const tasks = await api('/cluster/tasks').catch(() => []);
  const cut = Date.now() / 1000 - 3 * 86400;
  for (const t of tasks || []) {
    if (t.type === 'vzdump' && t.status && t.status !== 'OK' && (t.endtime || t.starttime) > cut) out.failedBackups.push({ node: t.node, at: (t.endtime || t.starttime) * 1000, status: String(t.status).slice(0, 120), upid: t.upid });
  }
  for (const n of out.nodes) {
    if (n.status !== 'online') continue;
    const [disks, zfs, apt] = await Promise.all([
      api(`/nodes/${n.name}/disks/list`).catch(() => []), api(`/nodes/${n.name}/disks/zfs`).catch(() => []),
      api(`/nodes/${n.name}/apt/update`).catch((e) => { if (e.forbidden) out.noUpdatePerm = true; return null; })]);
    for (const d of disks || []) out.disks.push({ node: n.name, dev: d.devpath, model: d.model, health: d.health || '', wearout: d.wearout });
    for (const z of zfs || []) out.pools.push({ node: n.name, name: z.name, health: z.health });
    if (apt) out.updates[n.name] = apt.length;
  }
  return out;
}

// ---------- this server: systemd services and apt updates ----------
function run(cmd, args, ms) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: ms || 20000, env: Object.assign({}, process.env, { LC_ALL: 'C' }) },
    (err, stdout, stderr) => resolve({ err, out: String(stdout || ''), stderr: String(stderr || '') })));
}
let aptCache = { at: 0, n: null, stamp: '' };
const aptStamp = () => ['/var/lib/dpkg/status', '/var/lib/apt/lists'].map((f) => { try { return String(fs.statSync(f).mtimeMs); } catch (e) { return ''; } }).join('|');
async function serverCheck(services, force) {
  const out = { services: {}, aptUpdates: null };
  if (services.length) {
    const r = await run('systemctl', ['is-active', ...services]);
    const lines = r.out.trim().split('\n');
    services.forEach((svc, i) => { out.services[svc] = (lines[i] || 'unknown').trim(); });
  }
  // recount when packages were installed or the lists refreshed (or on Check now), else at most hourly
  const stamp = aptStamp();
  if (force || stamp !== aptCache.stamp || Date.now() - aptCache.at > 3600000) {
    const r = await run('apt', ['list', '--upgradable'], 30000);
    if (!r.err) aptCache = { at: Date.now(), n: r.out.split('\n').filter((l) => /\/.*\[upgradable/.test(l)).length, stamp };
  }
  out.aptUpdates = aptCache.n;
  return out;
}

// ---------- HP printer (its web server's status XML) ----------
const PRINTER_FINE = new Set(['ready', 'processing', 'initializing', 'inpowersave', 'sleep', 'standby', 'warmup', 'calibrating', 'canceling', 'cancelling', 'shuttingdown', 'cartridgelow', 'closedoorordoorsclosed', 'busy']);
async function printerCheck(url) {
  const base = url.replace(/\/+$/, '');
  const get = async (p) => { const r = await webGet(base + p, { timeout: 8000 }); if (r.status !== 200) throw new Error('HTTP ' + r.status); return r.body; };
  const [status, cons] = await Promise.all([get('/DevMgmt/ProductStatusDyn.xml'), get('/DevMgmt/ConsumableConfigDyn.xml').catch(() => '')]);
  const cats = [...status.matchAll(/<\w+:StatusCategory>([^<]+)</g)].map((m) => m[1].trim());
  const words = [...status.matchAll(/<\w+:LocString[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  // alerts: <ad:ProductStatusAlertID>jamInPrinter</…> with <ad:Severity>Error|Warning|Info</…>
  const ids = [...status.matchAll(/<\w+:ProductStatusAlertID>([^<]+)</g)].map((m) => m[1].trim());
  const sev = [...status.matchAll(/<\w+:Severity>([^<]+)</g)].map((m) => m[1].trim());
  const errors = ids.filter((id, i) => /^(error|critical)$/i.test(sev[i] || '') && !/genuine|cartridge/i.test(id));
  const toner = [];
  for (const block of cons.split('<ccdyn:ConsumableInfo>').slice(1)) {
    const g = (tag) => (new RegExp(`<dd:${tag}>([^<]*)<`).exec(block) || [])[1];
    const pct = g('ConsumablePercentageLevelRemaining');
    if (g('ConsumableTypeEnum') === 'toner' && pct !== undefined) toner.push({ part: g('ProductNumber') || g('ConsumableSelectibilityNumber') || 'toner', pct: +pct, color: (g('MarkerColor') || '').toLowerCase() });
  }
  const bad = cats.filter((x) => !PRINTER_FINE.has(x.toLowerCase())).concat(errors);
  const nice = (x) => x.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { cats, words, toner, problem: bad.length ? (words.find((w) => !/standby|ready|sleep|power save/i.test(w)) || bad.map(nice).join(', ')) : '' };
}

// ---------- email (SMTP over TLS) ----------
function smtpSend(o) {
  return new Promise((resolve, reject) => {
    const rcpts = o.to.split(/[,;\s]+/).filter(Boolean);
    // each step: the reply code we wait for, then what we send next
    const plan = [
      [220, 'EHLO licketysplit'],
      [250, 'AUTH PLAIN ' + Buffer.from(`\0${o.user}\0${o.pass}`).toString('base64')],
      [235, `MAIL FROM:<${o.from}>`],
      ...rcpts.map((r) => [250, `RCPT TO:<${r}>`]),
      [250, 'DATA'],
      [354, o.message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.'],
      [250, 'QUIT'],
    ];
    const sock = tls.connect({ host: o.host, port: o.port, servername: o.host, rejectUnauthorized: !o.insecure });
    let buf = '', step = 0, done = false;
    const end = (err) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err instanceof Error ? err : new Error(err)) : resolve(); };
    const timer = setTimeout(() => end('the mail server didn’t answer'), 30000);
    sock.on('data', (d) => {
      buf += d.toString();
      let m;
      while ((m = /^(\d{3})([ -])(.*)\r?\n/m.exec(buf))) {
        buf = buf.slice(m.index + m[0].length);
        if (m[2] === '-') continue;                        // more lines of the same reply
        if (step >= plan.length) return end();              // (the reply to QUIT)
        const [want, next] = plan[step++];
        if (+m[1] !== want) {
          return end(+m[1] === 535 ? 'the mail server refused the login (check the Gmail address and app password)' : `mail server: ${m[1]} ${m[3]}`);
        }
        sock.write(next + '\r\n');
        if (next === 'QUIT') return end();                  // the message was accepted
      }
    });
    sock.on('error', (e) => end(e.code === 'ENOTFOUND' ? `can't find ${o.host}` : e.message));
    sock.on('close', () => end(step >= plan.length ? null : 'the mail server hung up'));
  });
}
const b64lines = (s) => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
// text + html, and (optional) inline images the html shows as <img src="cid:...">
function buildMessage({ from, to, subject, text, html, images }) {
  const b = 'ls-' + crypto.randomBytes(8).toString('hex'), r = 'lsr-' + crypto.randomBytes(8).toString('hex');
  const head = [
    `From: Lickety Split <${from}>`, `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@licketysplit>`, 'MIME-Version: 1.0'];
  const alt = [
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text),
    `--${b}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(html),
    `--${b}--`];
  if (!images || !images.length) return [...head, `Content-Type: multipart/alternative; boundary="${b}"`, '', ...alt, ''].join('\r\n');
  return [...head, `Content-Type: multipart/related; boundary="${r}"`, '',
    `--${r}`, `Content-Type: multipart/alternative; boundary="${b}"`, '', ...alt,
    ...images.flatMap((im) => [`--${r}`, `Content-Type: ${im.type}; name="${im.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-ID: <${im.cid}>`, `Content-Disposition: inline; filename="${im.name}"`, '', im.data.toString('base64').replace(/.{76}/g, '$&\r\n')]),
    `--${r}--`, ''].join('\r\n');
}
// the duck sidekick, flying (an animated GIF made from the page's drawing)
let duckGif = null;
try { duckGif = fs.readFileSync(require('path').join(__dirname, 'public', 'duck.gif')); } catch (e) { /* no duck: plain email */ }

// ---------- the checks ----------
const HA_TEMPLATE = `{%- set ns = namespace(locks=[], garage=[], autos=[], batt=[], upd=[], dead=[], seen=[], ring=[], rseen=[]) -%}
{%- for e in integration_entities('ring') -%}{%- set d = device_id(e) -%}
{%- if d and d not in ns.rseen -%}{%- set ns.rseen = ns.rseen + [d] -%}{%- set ents = device_entities(d) -%}
{%- set bl = ents | select('match', 'sensor\\.') | select('is_state_attr', 'device_class', 'battery') | map('states') | select('is_number') | map('float') | list -%}
{%- set ns.ring = ns.ring + [{'id': d, 'name': device_attr(d, 'name_by_user') or device_attr(d, 'name'), 'area': area_name(d), 'model': device_attr(d, 'model'), 'avail': ents | select('has_value') | list | length > 0, 'batt': (bl | min) if bl else -1}] -%}
{%- endif -%}{%- endfor -%}
{%- for s in states.lock -%}{%- if s.state in ['unlocked', 'open', 'opening', 'unlocking', 'jammed'] -%}
{%- set ns.locks = ns.locks + [{'id': s.entity_id, 'name': s.name, 'state': s.state, 'since': as_timestamp(s.last_changed, 0)}] -%}{%- endif -%}{%- endfor -%}
{%- for s in states.binary_sensor -%}{%- set dc = s.attributes.get('device_class') -%}
{%- if dc == 'garage_door' and s.state == 'on' -%}
{%- set ns.garage = ns.garage + [{'id': s.entity_id, 'name': s.name, 'since': as_timestamp(s.last_changed, 0)}] -%}{%- endif -%}
{%- if dc == 'battery' and s.state == 'on' -%}{%- set ns.batt = ns.batt + [{'id': s.entity_id, 'name': s.name, 'v': -1}] -%}{%- endif -%}
{%- endfor -%}
{%- for s in states.cover -%}{%- if (s.attributes.get('device_class') in ['garage', 'gate'] or 'garage' in s.entity_id) and s.state in ['open', 'opening'] -%}
{%- set ns.garage = ns.garage + [{'id': s.entity_id, 'name': s.name, 'since': as_timestamp(s.last_changed, 0)}] -%}{%- endif -%}{%- endfor -%}
{%- for s in states.automation -%}{%- if s.state == 'unavailable' -%}
{%- set ns.autos = ns.autos + [{'id': s.entity_id, 'name': s.name, 'state': s.state, 'since': as_timestamp(s.last_changed, 0)}] -%}{%- endif -%}{%- endfor -%}
{%- for s in states.sensor -%}{%- if s.attributes.get('device_class') == 'battery' and s.state | is_number -%}
{%- set ns.batt = ns.batt + [{'id': s.entity_id, 'name': s.name, 'v': s.state | float}] -%}{%- endif -%}{%- endfor -%}
{%- for s in states.update -%}{%- if s.state == 'on' -%}
{%- set ns.upd = ns.upd + [{'id': s.entity_id, 'name': s.attributes.get('title') or s.name, 'inst': s.attributes.get('installed_version'), 'latest': s.attributes.get('latest_version')}] -%}{%- endif -%}{%- endfor -%}
{%- for s in states -%}{%- if s.state == 'unavailable' -%}{%- set d = device_id(s.entity_id) -%}
{%- if d and d not in ns.seen -%}{%- set ns.seen = ns.seen + [d] -%}
{%- set ents = device_entities(d) -%}{%- if ents | select('has_value') | list | length == 0 -%}
{%- set ns.dead = ns.dead + [{'id': d, 'name': device_attr(d, 'name_by_user') or device_attr(d, 'name'), 'area': area_name(d), 'since': as_timestamp(s.last_changed, 0)}] -%}
{%- endif -%}{%- endif -%}{%- endif -%}{%- endfor -%}
{{ {'ring': ns.ring, 'locks': ns.locks, 'garage': ns.garage, 'autos': ns.autos, 'batt': ns.batt, 'upd': ns.upd, 'dead': ns.dead} | to_json }}`;

async function haCheck(url, token) {
  const r = await fetch(url.replace(/\/+$/, '') + '/api/template', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: HA_TEMPLATE }), signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(r.status === 401 ? 'Home Assistant refused the token' : `Home Assistant answered ${r.status}${t ? ': ' + t : ''}`);
  }
  return JSON.parse(await r.text());
}

async function piholeCheck(url, password) {
  const base = url.replace(/\/+$/, '');
  const out = { dnsOk: false };
  // 1. does it answer DNS? (ask it directly, by its address)
  const host = new URL(base).hostname;
  const ip = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : (await dns.promises.lookup(host, 4)).address;
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  r.setServers([ip]);
  try { await r.resolve4('example.com'); out.dnsOk = true; } catch (e) { out.dnsError = e.code || e.message; }
  // 2. its API: blocking, block list age, versions
  const call = async (method, p, sid, body) => {
    const res = await fetch(base + p, { method, signal: AbortSignal.timeout(15000),
      headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'X-FTL-SID': sid } : {}), body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) throw new Error('Pi-hole refused the password');
    if (!res.ok) throw new Error('Pi-hole API: HTTP ' + res.status);
    return res.status === 204 ? null : res.json();
  };
  const a = await call('POST', '/api/auth', null, { password });
  const sid = a.session && a.session.sid;
  try {
    const [blk, sum, ver] = await Promise.all([
      call('GET', '/api/dns/blocking', sid), call('GET', '/api/stats/summary', sid), call('GET', '/api/info/version', sid).catch(() => null)]);
    out.blocking = blk && blk.blocking;
    out.gravityAt = sum && sum.gravity && sum.gravity.last_update ? sum.gravity.last_update * 1000 : 0;
    const v = (ver && ver.version) || {};
    out.updates = ['core', 'web', 'ftl'].map((k) => {
      const x = v[k] || {}, loc = (x.local && x.local.version) || '', rem = (x.remote && x.remote.version) || '';
      return loc && rem && loc !== rem ? { part: k === 'ftl' ? 'FTL' : k === 'web' ? 'Web' : 'Core', loc, rem } : null;
    }).filter(Boolean);
  } finally {
    if (sid) await call('DELETE', '/api/auth', sid).catch(() => {});
  }
  return out;
}

async function webCheck(url) {
  const t0 = Date.now();
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual' });
  if (r.status >= 500) throw new Error('HTTP ' + r.status);
  return Date.now() - t0;
}

function diskFree(p) {
  try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch (e) { return null; }
}

const mins = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} days`; };

// ---------- how to fix it ----------
// one or two sentences of advice for each kind of problem and update
function adviceFor(f, devices) {
  const id = f.id, t = f.title;
  if (id.startsWith('lock:')) return /jammed/.test(t)
    ? 'Something stopped the bolt: make sure the door is fully shut and the strike plate lines up, then lock it again (from the lock or Home Assistant).'
    : 'Lock it from Home Assistant or the lock\u2019s app. If it says unlocked but is locked, check the lock\u2019s battery and its connection to Home Assistant.';
  if (id.startsWith('door:')) return 'Close the door. If it is shut, the sensor is wrong: check its magnet or recalibrate it in the lock’s app, or press Ignore.';
  if (id.startsWith('garage:')) return 'Close it from Home Assistant (or the wall button). If it is shut, check the garage tilt/position sensor and its battery.';
  if (id.startsWith('auto:')) return 'Home Assistant → Settings → Automations: open it and look for the red error (usually an entity that was renamed or removed). Also check Settings → Repairs, then reload automations.';
  if (id === 'ha') return 'Check the Home Assistant machine is on and on the network (open its page). If the page doesn’t load, restart it; if it loads slowly, check Settings → System → Repairs and the disk space.';
  if (id === 'pihole') return 'Open the Pi-hole page. If it is down, run "sudo systemctl restart pihole-FTL" on the Pi (or restart its container).';
  if (id === 'piholeblk') return 'Pi-hole → Settings → turn blocking back on, or run "pihole enable" on the Pi. Someone (or a timer) switched it off.';
  if (id === 'piholegrav') return 'Pi-hole → Tools → Update Gravity, or "pihole -g" on the Pi.';
  if (id === 'piholeapi') return 'DNS works; restart the web part with "sudo systemctl restart pihole-FTL" on the Pi.';
  if (id === 'disk' || id === 'disklow') return 'On this server: "sudo apt clean", "sudo journalctl --vacuum-size=200M", and remove old backups. "sudo du -xh / | sort -h | tail" shows what is big.';
  if (id === 'ping') return 'Usually the internet connection: check the eero app. If the internet works, check that this server can reach the ping address.';
  if (id.startsWith('dev:')) {
    const d = (devices || []).find((x) => 'dev:' + x.id === id), fw = d && d.fw;
    const base = 'Check it has power and Wi-Fi (its page at ' + (d ? d.host : 'its address') + '). Unplug it for 10 seconds, or press Restart on the Firmware tab if its page still answers.';
    if (fw === 'airplay') return base + ' The AirPlay receiver also drops off when its Wi-Fi is weak.';
    if (fw && fw.startsWith('wled')) return base + ' If it keeps dropping, reflash it from the Firmware tab.';
    return base;
  }
  if (id.startsWith('web:')) {
    const u = id.slice(4);
    const svc = /:8080\b/.test(u) ? 'signinator' : /:8100\b/.test(u) ? 'tree-show' : /:8110\b/.test(u) ? 'licketysplit' : '';
    return svc ? `On this server: "sudo systemctl restart ${svc}", then "journalctl -u ${svc} -n 50" if it stops again.` : 'Open the address in a browser; restart the service or device behind it.';
  }
  if (id === 'pve') return 'Open the Proxmox web page (port 8006). If it doesn\u2019t load, the host is down or off the network: check its power and console.';
  if (id.startsWith('pvenode:')) return 'The node is offline: check the machine\u2019s power and network. Its VMs and containers are down with it.';
  if (id.startsWith('pveguest:')) return 'It was running and stopped. Proxmox \u2192 the VM/container \u2192 Start; its Task History and Syslog say why it stopped. If you stopped it on purpose, press Ignore.';
  if (id.startsWith('pvedisk:')) return 'The drive reports failing SMART health: back up what is on it and replace it soon. Proxmox \u2192 node \u2192 Disks shows the details.';
  if (id.startsWith('pvezfs:')) return 'A ZFS pool is degraded or faulted: Proxmox \u2192 node \u2192 Disks \u2192 ZFS, then "zpool status" on the node to see which drive. Replace it and resilver.';
  if (id.startsWith('pvestore:')) return 'Free space: delete old backups and unused ISOs/templates (Proxmox \u2192 the storage \u2192 Content), or prune snapshots.';
  if (id.startsWith('pvemem:')) return 'The node is nearly out of RAM: lower a VM\u2019s memory, enable ballooning, or stop something you don\u2019t need.';
  if (id.startsWith('pvebackup:')) return 'Proxmox \u2192 Datacenter \u2192 Backup \u2192 the job \u2192 Run now, and read the task log (usually the backup storage is full or unreachable).';
  if (id.startsWith('svc:')) { const n = id.slice(4); return `On this server: "sudo systemctl restart ${n}", then "journalctl -u ${n} -n 50" to see why it stopped.`; }
  if (id.startsWith('ringbatt:')) return 'Charge or swap the camera\u2019s battery (Ring app \u2192 the device \u2192 Device Health shows the level). A Stick Up Cam has a removable pack; the doorbell comes off its plate with the security screw.';
  if (id.startsWith('ring:')) return 'The camera is offline: check its battery (or power) and Wi-Fi in the Ring app \u2192 Device Health. Power-cycle it (hold the setup button) if the battery is fine.';
  if (id === 'speed') return 'Two tests in a row were slow. Check the eero app for an outage or a speed test from the eero itself; restart the modem and the eero if it\u2019s still slow; compare with a wired laptop to rule out this server.';
  if (id.startsWith('printertoner:')) return 'Order a new cartridge (the part number is in the message) and swap it when it gets to a few percent.';
  if (id.startsWith('printer:')) return 'Look at the printer\u2019s display: a jam, open door or empty tray. Its web page (the address in Settings) shows the same status.';
  if (id.startsWith('upd:') || id.startsWith('piholeupd:')) {
    if (/^Update: Proxmox/.test(t)) return 'Proxmox \u2192 the node \u2192 Updates \u2192 Refresh, then Upgrade (or "apt update && apt dist-upgrade" on the node). Kernel updates need a reboot.';
    if (id.startsWith('aptupd:')) return 'On this server: "sudo apt update && sudo apt upgrade". Reboot if it says a new kernel was installed.';
    if (/pi-?hole/i.test(t)) return 'On the Pi: "sudo pihole -up" (all parts at once; DNS pauses for a moment). In Docker: pull the new image and recreate the container.';
    if (/home assistant (core|operating system|supervisor)/i.test(t)) return 'Home Assistant → Settings → System → Updates → Install (it offers a backup first: take it).';
    if (/esphome/i.test(t)) return 'ESPHome dashboard (Home Assistant add-on) → the device → Install → Wirelessly.';
    if (/^0x/i.test(f.detail)) return 'A Matter/Thread device: Home Assistant → Settings → System → Updates → Install. Thread updates are slow (20–60 min); leave it near a border router.';
    if (/wled/i.test(t)) return 'Use Lickety Split’s Firmware tab, not Home Assistant: HA would install plain WLED without the temporal dithering.';
    return 'Home Assistant → Settings → System → Updates → Install.';
  }
  return '';
}

// which duck (a setting on the Ducks tab) a problem belongs to
function duckOf(id) {
  const k = id.split(':')[0];
  return { lock: 'locks', garage: 'garage', auto: 'automations', ha: 'ha', pihole: 'pihole', piholeblk: 'pihole', piholegrav: 'pihole',
    piholeapi: 'pihole', upd: 'updates', piholeupd: 'updates', dev: 'devices', web: 'watch', disk: 'disk', disklow: 'disk',
    pve: 'proxmox', pvenode: 'proxmox', pveguest: 'proxmox', pvedisk: 'proxmox', pvezfs: 'proxmox', pvestore: 'proxmox', pvemem: 'proxmox', pvebackup: 'proxmox', pveupd: 'updates',
    svc: 'server', aptupd: 'updates', ring: 'ring', ringbatt: 'ring', printer: 'printer', printertoner: 'printer', speed: 'speed' }[k] || k;
}

// ---------- the monitor ----------
function createMonitor(deps) {
  // deps: { cfg() -> monitor settings, net() -> conf.net, devices() -> conf.devices, probe(dev), dataDir, log,
  //         netResult() (for the weekly summary), pingSummary() }
  const FILE = deps.dataDir + '/monitor.json';
  let st = { active: {}, history: [], emails: [], lastAlertEmail: 0, alertMailed: false, okSince: 0, lastWeekly: 0, checks: {} };
  try { st = Object.assign(st, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* first run */ }
  const save = () => fs.writeFile(FILE + '.tmp', JSON.stringify(st), (e) => { if (!e) fs.rename(FILE + '.tmp', FILE, () => {}); });
  let pihole = { at: 0, res: null, err: null }, running = false, fails = {};
  const cfg = () => Object.assign({}, DEFAULTS, deps.cfg() || {});

  function check(name, ok, detail) { st.checks[name] = { at: Date.now(), ok, detail: detail || '' }; }

  async function gather(force) {
    const c = cfg(), net = deps.net(), now = Date.now(), found = [];
    let haAnswer = null;
    const add = (id, sev, cat, title, detail, since, grace) => found.push({ id, sev, cat, title, detail: detail || '', since: since || 0, grace: grace == null ? GRACE : grace });

    // Pi-hole first (every 5 minutes, or now when asked): its own answer on updates beats Home Assistant's
    if (net.piholeUrl && net.piholePassword && (force || now - pihole.at >= PIHOLE_EVERY - 5000)) {
      try { pihole = { at: now, res: await piholeCheck(net.piholeUrl, net.piholePassword), err: null }; }
      catch (e) { pihole = { at: now, res: pihole.res && Object.assign({}, pihole.res, { dnsOk: pihole.res.dnsOk }), err: e.message }; }
    }

    // Home Assistant
    if (net.haUrl && net.haToken) {
      try {
        const h = await haCheck(net.haUrl, net.haToken);
        haAnswer = h;
        check('Home Assistant', true, `${h.locks.length} unlocked · ${h.garage.length} garage open · ${h.autos.length} automations broken · ${h.upd.length} updates`);
        // locks: unlocked longer than doorMin minutes; jammed at once (door sensors aren't watched: doors may stand open)
        for (const l of h.locks || []) {
          const since = l.since * 1000;
          if (l.state === 'jammed') add('lock:' + l.id, 'alert', 'Locks', `${l.name} is jammed`, 'the bolt didn\u2019t finish moving', since, 0);
          else if (now - since >= c.doorMin * 60000) add('lock:' + l.id, 'alert', 'Locks', `${l.name} unlocked for ${mins(now - since)}`, l.state, since, 0);
        }
        for (const g of h.garage) {
          const since = g.since * 1000;
          if (now - since >= c.garageMin * 60000) add('garage:' + g.id, 'alert', 'Doors', `${g.name} open for ${mins(now - since)}`, 'garage', since, 0);
        }
        for (const a of h.autos) {
          add('auto:' + a.id, 'alert', 'Automations', `Automation broken: ${a.name}`, 'unavailable', a.since * 1000);
        }
        for (const d of h.dead) add('dead:' + d.id, 'notice', 'Devices', `${d.name} unavailable`, [d.area, 'all its entities unavailable'].filter(Boolean).join(' · '), d.since * 1000, 0);
        for (const b of h.batt) if (b.v < 0 || b.v <= c.battery) add('batt:' + b.id, 'notice', 'Batteries', `${b.name}: ${b.v < 0 ? 'low' : Math.round(b.v) + '%'}`, '', 0, 0);
        const piFresh = () => pihole.res && !pihole.err && Date.now() - pihole.at < 15 * 60000;
        for (const u of h.upd) if (!(/pi-?hole/i.test(u.name + ' ' + u.id) && piFresh())) add('upd:' + u.id, 'notice', 'Updates', `Update: ${u.name}`, [u.inst, u.latest].filter(Boolean).join(' → '), 0, 0);
      } catch (e) {
        check('Home Assistant', false, e.message);
        add('ha', 'alert', 'Home Assistant', 'Home Assistant isn’t answering', e.name === 'TimeoutError' ? 'no answer' : e.message);
      }
    }

    // Pi-hole results
    if (net.piholeUrl && (pihole.res || pihole.err)) {
      const p = pihole.res || {};
      if (pihole.err && !p.dnsOk) add('pihole', 'alert', 'Pi-hole', 'Pi-hole isn’t answering', pihole.err);
      else if (p.dnsOk === false) add('pihole', 'alert', 'Pi-hole', 'Pi-hole isn’t answering DNS', p.dnsError || '');
      else if (pihole.err) add('piholeapi', 'notice', 'Pi-hole', 'Pi-hole’s web API isn’t answering', pihole.err, 0);
      if (p.blocking && p.blocking !== 'enabled') add('piholeblk', 'alert', 'Pi-hole', `Pi-hole blocking is ${p.blocking}`, 'ads and trackers aren’t blocked');
      if (p.gravityAt && now - p.gravityAt > 8 * 86400000) add('piholegrav', 'notice', 'Pi-hole', `Pi-hole block lists last updated ${mins(now - p.gravityAt)} ago`, 'Tools → Update Gravity', 0, 0);
      for (const u of p.updates || []) add('piholeupd:' + u.part, 'notice', 'Updates', `Update: Pi-hole ${u.part}`, `${u.loc} → ${u.rem}`, 0, 0);
      check('Pi-hole', !!p.dnsOk && !pihole.err, pihole.err || (p.dnsOk ? `DNS OK · blocking ${p.blocking || '?'}` : 'DNS not answering'));
    }

    // Ring cameras (from Home Assistant's answer above)
    if (haAnswer) {
      for (const r of haAnswer.ring || []) {
        const where = [r.area, r.model].filter(Boolean).join(' · ');
        if (!r.avail) add('ring:' + r.id, 'alert', 'Ring', `${r.name} is offline`, where);
        else if (r.batt >= 0 && r.batt <= c.ringBattery) add('ringbatt:' + r.id, 'alert', 'Ring', `${r.name} battery at ${Math.round(r.batt)}%`, where, 0, 0);
      }
      check('Ring cameras', true, `${(haAnswer.ring || []).length} cameras, ${(haAnswer.ring || []).filter((r) => !r.avail).length} offline`);
    }

    // Proxmox
    if (c.pveUrl && c.pveToken && c.pveSecret) {
      try {
        const p = await proxmoxCheck(c, (fp) => deps.setCfg && deps.setCfg({ pveFingerprint: fp }));
        const running = {};
        for (const n of p.nodes) {
          if (n.status !== 'online') { add('pvenode:' + n.name, 'alert', 'Proxmox', `Proxmox node ${n.name} is offline`, ''); continue; }
          if (n.maxmem && n.mem / n.maxmem > 0.95) add('pvemem:' + n.name, 'alert', 'Proxmox', `${n.name} is nearly out of RAM`, `${Math.round(100 * n.mem / n.maxmem)}% used`, 0, 0);
          if (n.maxdisk && n.disk / n.maxdisk > 0.9) add('pvestore:' + n.name + ':root', 'alert', 'Proxmox', `${n.name}: system disk ${Math.round(100 * n.disk / n.maxdisk)}% full`, '', 0, 0);
          if (p.updates[n.name]) add('pveupd:' + n.name, 'notice', 'Updates', `Update: Proxmox ${n.name}`, `${p.updates[n.name]} package${p.updates[n.name] > 1 ? 's' : ''}`, 0, 0);
        }
        for (const g of p.guests) {
          if (g.template) continue;
          if (g.status === 'running') running[g.vmid] = g.name;
          else if (st.pveRunning && st.pveRunning[g.vmid]) add('pveguest:' + g.vmid, 'alert', 'Proxmox', `${g.kind} ${g.name} stopped`, `${g.vmid} on ${g.node} · was running`, 0, 0);
        }
        // guests that just stopped stay "expected running" (so the alert persists until they run again or are ignored)
        st.pveRunning = Object.assign({}, st.pveRunning || {}, running);
        for (const id of Object.keys(st.pveRunning)) if (!p.guests.some((g) => String(g.vmid) === String(id))) delete st.pveRunning[id];
        for (const sto of p.storage) if (sto.status === 'available' && sto.maxdisk && sto.disk / sto.maxdisk > 0.9)
          add('pvestore:' + (sto.shared ? '' : sto.node + ':') + sto.name, 'alert', 'Proxmox', `Storage ${sto.name} ${Math.round(100 * sto.disk / sto.maxdisk)}% full`, sto.shared ? '' : 'on ' + sto.node, 0, 0);
        for (const d of p.disks) if (d.health && !/^(PASSED|OK|UNKNOWN)$/i.test(d.health))
          add('pvedisk:' + d.node + ':' + d.dev, 'alert', 'Proxmox', `Drive ${d.dev} on ${d.node}: SMART ${d.health}`, d.model || '', 0, 0);
        for (const z of p.pools) if (z.health && z.health !== 'ONLINE') add('pvezfs:' + z.node + ':' + z.name, 'alert', 'Proxmox', `ZFS pool ${z.name} is ${z.health}`, 'on ' + z.node, 0, 0);
        for (const b of p.failedBackups) add('pvebackup:' + b.upid, 'alert', 'Proxmox', `Backup failed on ${b.node}`, `${new Date(b.at).toLocaleString()} · ${b.status}`, b.at, 0);
        check('Proxmox', true, `${p.nodes.filter((n) => n.status === 'online').length}/${p.nodes.length} nodes · ${Object.keys(running).length} running` + (p.noUpdatePerm ? ' · updates: no permission' : ''));
      } catch (e) {
        check('Proxmox', false, e.message);
        add('pve', 'alert', 'Proxmox', 'Proxmox isn\u2019t answering', e.message);
      }
    }

    // this server
    try {
      const sv = await serverCheck(c.services || [], force);
      const down = Object.entries(sv.services).filter(([, state]) => state !== 'active');
      for (const [name, state] of down) add('svc:' + name, 'alert', 'Server', `${name} isn\u2019t running`, `${state} on ${os.hostname()}`);
      if (sv.aptUpdates) add('aptupd:' + os.hostname(), 'notice', 'Updates', `Update: ${os.hostname()} (this server)`, `${sv.aptUpdates} package${sv.aptUpdates > 1 ? 's' : ''}`, 0, 0);
      check('Services on ' + os.hostname(), !down.length, down.length ? down.map(([n]) => n).join(', ') + ' down' : `${Object.keys(sv.services).length} running`);
    } catch (e) { check('Services on ' + os.hostname(), false, e.message); }

    // printer
    if (c.printerUrl) {
      try {
        const pr = await printerCheck(c.printerUrl);
        if (pr.problem) add('printer:status', 'alert', 'Printer', `Printer: ${pr.problem}`, pr.cats.join(', '), 0, 0);
        for (const t of pr.toner) if (t.pct <= c.tonerPct) add('printertoner:' + t.part, 'alert', 'Printer', `Printer toner at ${t.pct}%`, `${t.color ? t.color + ' ' : ''}cartridge ${t.part}`, 0, 0);
        check('Printer', !pr.problem, pr.toner.map((t) => `toner ${t.pct}%`).join(', ') + (pr.words[0] ? ' · ' + pr.words[0] : ''));
      } catch (e) { check('Printer', true, 'off or not answering (' + e.message + ')'); }   // a printer that's switched off is normal
    }

    // internet speed: the last two tests both under the limit
    const sp = deps.speed && deps.speed();
    if (sp && sp.cfg && (sp.cfg.minDown || sp.cfg.minUp) && sp.last.length >= 2) {
      const slowDown = sp.cfg.minDown && sp.last.every((r) => r.down < sp.cfg.minDown);
      const slowUp = sp.cfg.minUp && sp.last.every((r) => r.up < sp.cfg.minUp);
      const l = sp.last[sp.last.length - 1];
      if (slowDown || slowUp) add('speed', 'alert', 'Internet', `Internet is slow: ${slowDown ? l.down + ' Mbps down' : ''}${slowDown && slowUp ? ', ' : ''}${slowUp ? l.up + ' Mbps up' : ''}`, `limit ${sp.cfg.minDown || '–'} down / ${sp.cfg.minUp || '–'} up`, sp.last[0].t, 0);
      check('Internet speed', !(slowDown || slowUp), `${l.down} down / ${l.up} up Mbps`);
    } else if (sp && sp.last.length) { const l = sp.last[sp.last.length - 1]; check('Internet speed', true, `${l.down} down / ${l.up} up Mbps`); }

    // your devices + watched web addresses (down = 3 misses in a row)
    const targets = deps.devices().map((d) => ({ key: 'dev:' + d.id, name: d.name, run: () => deps.probe(d).then((p) => { if (!p.online) throw new Error(p.detail || 'no answer'); }) }))
      .concat((c.watch || []).map((w) => ({ key: 'web:' + w.url, name: w.name, run: () => webCheck(w.url) })));
    await Promise.all(targets.map(async (t) => {
      try { await t.run(); fails[t.key] = 0; check(t.name, true, ''); }
      catch (e) {
        fails[t.key] = (fails[t.key] || 0) + 1;
        check(t.name, false, e.message);
        if (fails[t.key] >= (c.every >= 3 ? 1 : 3)) add(t.key, 'alert', 'Devices', `${t.name} isn’t answering`, e.name === 'TimeoutError' ? 'no answer' : e.message);
      }
    }));

    // this server
    const free = diskFree('/'), freeData = diskFree(deps.dataDir);
    const low = Math.min(free == null ? Infinity : free, freeData == null ? Infinity : freeData);
    if (low !== Infinity) {
      const gb = low / 1e9;
      check('Disk space', gb > c.diskGb, `${gb.toFixed(1)} GB free`);
      if (gb <= c.diskGb) add('disk', 'alert', 'Server', `${os.hostname()}: only ${gb.toFixed(1)} GB of disk left`, '', 0, 0);
      else if (gb <= c.diskGb * 2.5) add('disklow', 'notice', 'Server', `${os.hostname()}: ${gb.toFixed(1)} GB of disk left`, '', 0, 0);
    }
    // health ping failing
    const pg = deps.pingSummary && deps.pingSummary();
    if (pg && pg.last && !pg.last.ok && now - pg.last.at < 10 * 60000) add('ping', 'notice', 'Server', 'Health ping failing', pg.last.status, 0, 0);
    return found;
  }

  // keep the list of problems: when each started, whether it's confirmed (lasted its grace time), history of fixed ones
  function update(found) {
    const now = Date.now(), seen = new Set(), ign = new Set(cfg().ignore || []), ducks = cfg().ducks || {};
    // only what needs doing: problems, and updates waiting to be installed (each update once, wherever it came from)
    const upd = new Set();
    found = found.filter((f) => {
      if (ign.has(f.id) || ducks[duckOf(f.id)] === false) return false;
      if (f.sev === 'alert') return true;
      if (f.cat !== 'Updates') return false;
      const k = f.title.toLowerCase().replace(/\s+(update|dns)$/g, '').replace(/\s+/g, ' ') + '|' + f.detail.toLowerCase().replace(/^v/, '').replace(/\u2192 v/, '\u2192 ');
      if (upd.has(k)) return false;
      upd.add(k); return true;
    });
    st.titles = st.titles || {};
    for (const f of found) {
      seen.add(f.id);
      st.titles[f.id] = f.title.replace(/ open for .*$/, '').replace(/ isn\u2019t answering$/, '');
      const a = st.active[f.id];
      st.active[f.id] = Object.assign({}, f, { first: a ? a.first : now, mailed: a ? a.mailed : false, fix: adviceFor(f, deps.devices()) });
    }
    for (const id of Object.keys(st.active)) {
      if (seen.has(id)) continue;
      const a = st.active[id];
      if (a.sev === 'alert' && now - a.first >= a.grace) st.history.unshift({ title: a.title, cat: a.cat, from: a.first, to: now });
      delete st.active[id];
    }
    st.history = st.history.slice(0, 50);
  }
  const confirmed = () => Object.values(st.active).filter((a) => a.sev === 'alert' && Date.now() - a.first >= a.grace);
  const notices = () => Object.values(st.active).filter((a) => a.sev === 'notice');

  // ---------- the report (page and email share it) ----------
  function report() {
    const now = Date.now(), al = confirmed(), pending = Object.values(st.active).filter((a) => a.sev === 'alert' && now - a.first < a.grace);
    return { at: st.at || 0, enabled: cfg().enabled, every: +cfg().every || 5, alerts: al.sort((a, b) => a.first - b.first), pending, notices: notices().sort((a, b) => a.cat.localeCompare(b.cat) || a.title.localeCompare(b.title)),
      perDuck: Object.values(st.active).filter((a) => a.sev === 'alert' || a.cat === 'Updates').reduce((m, a) => { const k = duckOf(a.id); m[k] = (m[k] || 0) + 1; return m; }, {}),
      checks: st.checks, history: st.history.slice(0, 20), emails: st.emails.slice(0, 15), ignored: (cfg().ignore || []).map((id) => ({ id, title: (st.titles || {})[id] || id })) };
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function emailBody(kind, extra) {
    const r = report(), when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const sec = (title, items, fmt) => items.length ? { title, items: items.map(fmt) } : null;
    const parts = [
      kind === 'clear' ? { title: 'All clear', items: ['Everything is working again.'] } : null,
      sec('What’s wrong', r.alerts, (a) => ({ line: `${a.title}${a.detail ? ' — ' + a.detail : ''} (since ${when(a.first)})`, fix: a.fix })),
      sec('Updates to install', r.notices, (a) => ({ line: `${a.title}${a.detail ? ' — ' + a.detail : ''}`, fix: a.fix })),
      kind !== 'alert' ? sec('Fixed recently', r.history.filter((h) => now() - h.to < 7 * 86400000).slice(0, 15), (h) => `${h.title} (${when(h.from)} – ${when(h.to)})`) : null,
      ...(extra || []),
    ].filter(Boolean);
    function now() { return Date.now(); }
    const line = (i) => (typeof i === 'string' ? i : i.line), fix = (i) => (typeof i === 'string' ? '' : i.fix || '');
    const text = parts.map((p) => `${p.title.toUpperCase()}\n${p.items.map((i) => '  - ' + line(i) + (fix(i) ? '\n    How to fix: ' + fix(i) : '')).join('\n')}`).join('\n\n') + '\n\n— Lickety Split (Duck Hunting)\n';
    const n = r.alerts.length;
    const headline = kind === 'test' ? 'Test email: the duck can reach you.' : n ? `The duck found ${n} thing${n > 1 ? 's' : ''} to fix.` : 'All good \u2014 the duck is on patrol.';
    const html = `<div style="font:15px/1.45 -apple-system,Segoe UI,Arial,sans-serif;color:#1B2836;max-width:640px">`
      + (duckGif ? `<img src="cid:duck@licketysplit" width="220" height="110" alt="Lickety Split\u2019s duck sidekick" style="display:block;border:0;margin:0 0 4px">` : '')
      + `<div style="font:italic 800 22px/1.15 Arial Narrow,Arial,sans-serif;text-transform:uppercase;color:${n && kind !== 'clear' ? '#C23B3B' : '#2E8B57'}">${esc(headline)}</div>`
      + parts.map((p) => `<h3 style="margin:18px 0 6px;font-size:16px;color:${p.title === 'What’s wrong' ? '#C23B3B' : p.title === 'All clear' ? '#2E8B57' : '#1B2836'}">${esc(p.title)}</h3><ul style="margin:0;padding-left:20px">${p.items.map((i) => `<li style="margin:5px 0">${esc(line(i))}${fix(i) ? `<div style="color:#5B6B7B;font-size:13px;margin-top:2px"><b style="color:#1B2836">How to fix:</b> ${esc(fix(i))}</div>` : ''}</li>`).join('')}</ul>`).join('')
      + `<p style="color:#5B6B7B;font-size:12px;margin-top:22px">— Lickety Split (Duck Hunting)</p></div>`;
    return { text, html };
  }
  async function sendEmail(kind, subject, extra) {
    const c = cfg();
    if (!c.to || !c.from || !c.password) throw new Error('Set the email address, the Gmail address and its app password first.');
    const { text, html } = emailBody(kind, extra);
    await smtpSend({ host: process.env.LS_SMTP_HOST || c.smtpHost, port: +process.env.LS_SMTP_PORT || c.smtpPort, insecure: process.env.LS_SMTP_INSECURE === '1', user: c.from, pass: c.password, from: c.from, to: c.to,
      message: buildMessage({ from: c.from, to: c.to, subject, text, html,
        images: duckGif ? [{ cid: 'duck@licketysplit', name: 'duck.gif', type: 'image/gif', data: duckGif }] : [] }) });
    st.emails.unshift({ at: Date.now(), kind, subject, ok: true });
    st.emails = st.emails.slice(0, 40); save();
    deps.log(`Duck Hunting email sent: ${subject}`);
  }
  async function trySend(kind, subject, extra) {
    try { await sendEmail(kind, subject, extra); return true; }
    catch (e) {
      st.emails.unshift({ at: Date.now(), kind, subject, ok: false, error: e.message }); st.emails = st.emails.slice(0, 40); save();
      deps.log('Duck Hunting email failed: ' + e.message); return false;
    }
  }
  const duck = '🦆';
  const alertSubject = (al) => `${duck} Duck Hunting: ${al.length === 1 ? al[0].title : `${al.length} things wrong — ${al.slice(0, 3).map((a) => a.title).join(', ')}${al.length > 3 ? '…' : ''}`}`;

  function weeklyExtra() {
    const r = deps.netResult && deps.netResult(), now = Date.now(), out = [];
    if (r && r.hosts) {
      const fresh = r.hosts.filter((h) => h.firstSeen && now - h.firstSeen < 7 * 86400000 && h.firstSeen > r.hosts.reduce((m, x) => Math.min(m, x.firstSeen || now), now) + 3600000);
      if (fresh.length) out.push({ title: 'New on the network this week', items: fresh.map((h) => `${h.name || h.brand || 'Unknown device'} (${h.ip || h.ipv6 || ''}${h.mac ? ', ' + h.mac : ''})`) });
      const gone = r.hosts.filter((h) => !h.online && h.lastSeen && now - h.lastSeen < 7 * 86400000);
      if (gone.length) out.push({ title: 'Gone quiet this week', items: gone.map((h) => `${h.name || h.brand || 'Unknown device'} (last seen ${new Date(h.lastSeen).toLocaleDateString()})`) });
      const d = r.dnsStats;
      if (d) out.push({ title: 'DNS (last 24 h)', items: [`${d.total.toLocaleString()} queries, ${d.blocked.toLocaleString()} blocked (${(+d.percent).toFixed(1)}%)`] });
    }
    const pg = deps.pingSummary && deps.pingSummary();
    if (pg && pg.ok + pg.fail) out.push({ title: 'Health ping (24 h)', items: [`${pg.ok} of ${pg.ok + pg.fail} OK`] });
    return out;
  }
  function weeklyDue() {
    const c = cfg();
    if (c.weeklyDay < 0) return false;
    const d = new Date();
    const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() - c.weeklyDay + 7) % 7), c.weeklyHour, 0, 0).getTime();
    return Date.now() >= slot && st.lastWeekly < slot;
  }

  async function tick(force) {
    if (running) return;
    running = true;
    try {
      const found = await gather(force);
      update(found);
      st.at = Date.now();
      const c = cfg(), al = confirmed(), now = Date.now();
      if (c.enabled) {
        const unmailed = al.filter((a) => !a.mailed);
        if (c.notifyNew && unmailed.length && now - st.lastAlertEmail >= EMAIL_GAP) {
          st.lastAlertEmail = now;                     // (a failed email is tried again after the same gap)
          if (await trySend('alert', alertSubject(al))) {
            for (const a of al) st.active[a.id].mailed = true;
            st.alertMailed = true;
          }
        }
        if (al.length) st.okSince = 0;
        else if (st.alertMailed) {
          st.okSince = st.okSince || now;
          if (now - st.okSince >= CLEAR_AFTER) {
            if (!c.notifyClear || await trySend('clear', `${duck} Duck Hunting: all clear`)) { st.alertMailed = false; st.okSince = 0; }
          }
        }
        if (!st.lastWeekly) st.lastWeekly = now;     // just turned on: the first summary comes at the next weekly time
        if (weeklyDue()) {
          const n = al.length, k = notices().length;
          await trySend('weekly', `${duck} Duck Hunting weekly: ${n ? n + ' thing' + (n > 1 ? 's' : '') + ' wrong' : 'all good'}${k ? ', ' + k + ' to know' : ''}`, weeklyExtra());
          st.lastWeekly = Date.now();
        }
      }
      save();
    } catch (e) {
      deps.log('Duck Hunting check failed: ' + e.message);
    } finally { running = false; }
  }

  // runs the checks when they're due (every "every" minutes); the server calls this often
  function maybeTick() {
    const every = Math.max(1, +cfg().every || 5) * 60000;
    if (!st.at || Date.now() - st.at >= every - 15000) tick();
  }

  return {
    tick, report, maybeTick,
    sendTest: () => sendEmail('test', `${duck} Duck Hunting: test email`, [{ title: 'Test', items: ['If you can read this, Lickety Split can email you.'] }]),
    sendReport: () => { const al = confirmed(); return sendEmail('report', al.length ? alertSubject(al) : `${duck} Duck Hunting report: all good`, weeklyExtra()); },
    DEFAULTS,
  };
}

module.exports = { createMonitor, DEFAULTS, _test: { buildMessage, smtpSend, HA_TEMPLATE } };
