'use strict';
// Network check: finds the devices on the local network and names and describes each one, from
//  - the scan itself: a quick connection attempt to every address (port 80), then the kernel's ARP table
//    (an address that answers ARP is a device, even if it refuses the connection) for its MAC address,
//  - Home Assistant: device names, makers, models and areas (matched by MAC address or the device's own
//    web address), and router device trackers (IP + MAC), through the REST API's template endpoint,
//  - mDNS (avahi-browse): what each device announces (AirPlay, Cast, HomeKit, printers, ...) and its name,
//  - DNS: the reverse name of each address (from the local DNS server),
//  - a short look at its web page: WLED / Matrixinator info, the AirPlay receiver's status, or the page title.
// Never connects to AirPlay's RTSP port: airplay speakers drop the playing session for a new connection.
const net = require('net');
const os = require('os');
const fs = require('fs');
const dns = require('dns');
const { spawn } = require('child_process');

const SWEEP_PORT = 80, SWEEP_TIMEOUT = 1500, SWEEP_PAR = 64, HTTP_PAR = 16;
const KEEP_DAYS = 30;            // forget a device not seen for this long
const OUI_URL = 'https://www.wireshark.org/download/automated/data/manuf', OUI_MAX_AGE = 30 * 86400000;

// names that are really IDs (Matter, Spotify Connect, UUIDs, bare MACs, "none-4") say nothing
const JUNK_NAME = /^(?:[0-9a-f]{12,}(?:-[0-9a-f]+)*|[0-9a-f]{8}-[0-9a-f-]{20,}|none(?:-\d+)?|linux(?:-\d+)?|SpotifyConnect(?: #\d+| \(\d+\))?|Spotify Desktop Launcher|esp32-[0-9a-f]+|amzn\.dmgr:.*|(?:ip-)?\d{1,3}(?:[-.]\d{1,3}){3}(?:\..*)?)$/i;
const usable = (n) => !!n && !JUNK_NAME.test(String(n).trim());

// ---------- MAC address makers (Wireshark's list, kept in the data folder, refreshed monthly) ----------
let oui = null;
async function loadOui(dataDir) {
  const file = dataDir + '/manuf.txt';
  let txt = null, age = Infinity;
  try { age = Date.now() - fs.statSync(file).mtimeMs; txt = fs.readFileSync(file, 'utf8'); } catch (e) { /* not downloaded yet */ }
  if (!txt || age > OUI_MAX_AGE) {
    try {
      const r = await fetch(OUI_URL, { headers: { 'User-Agent': 'licketysplit' }, signal: AbortSignal.timeout(60000) });
      if (r.ok) { const t = await r.text(); if (t.length > 100000) { txt = t; age = 0; fs.writeFileSync(file + '.tmp', t); fs.renameSync(file + '.tmp', file); } }
    } catch (e) { /* use the old copy, or go without makers */ }
  }
  if (!txt) return null;
  if (oui && oui.len === txt.length) return oui.map;
  const map = new Map();
  for (const line of txt.split('\n')) {
    const m = /^([0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2})\s+(\S[^\t]*?)\s*(?:\t+\s*(\S.*?))?\s*$/i.exec(line);
    if (m) map.set(m[1].toLowerCase(), (m[3] || m[2]).replace(/,? (Inc|Co|Ltd|LLC|Corp|Corporation|Limited|GmbH)\.?$/i, '').trim());
  }
  oui = { len: txt.length, map };
  return map;
}
function makerOf(mac, map) {
  if (!mac) return '';
  if (parseInt(mac.slice(0, 2), 16) & 2) return 'private address';   // phones and computers hide their real MAC
  return (map && map.get(mac.slice(0, 8))) || '';
}

// ---------- addresses ----------
const ip2n = (ip) => ip.split('.').reduce((a, b) => a * 256 + +b, 0);
const n2ip = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join('.');
function parseCidr(s) {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(String(s || '').trim());
  if (!m || m[1].split('.').some((x) => +x > 255)) throw new Error('Network should look like 192.168.1.0/24.');
  const bits = +m[2];
  if (bits < 22 || bits > 30) throw new Error('The network can be /22 (1022 addresses) to /30.');
  const size = 2 ** (32 - bits), base = Math.floor(ip2n(m[1]) / size) * size;
  return { cidr: `${n2ip(base)}/${bits}`, first: base + 1, last: base + size - 2 };
}
function localNets() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !a.cidr) continue;
      const bits = Math.max(22, +a.cidr.split('/')[1]);
      out.push({ ifname, ip: a.address, mac: a.mac, cidr: parseCidr(`${a.address}/${Math.min(30, bits)}`).cidr });
    }
  }
  return out;
}

// ---------- 1. sweep + ARP ----------
function tryConnect(ip) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port: SWEEP_PORT });
    let done = false;
    const fin = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.setTimeout(SWEEP_TIMEOUT, () => fin(null));
    s.on('connect', () => fin('open'));
    s.on('error', (e) => fin(e.code === 'ECONNREFUSED' ? 'refused' : null));
  });
}
async function pool(items, par, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(par, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}
function readArp() {
  const out = {};
  try {
    for (const line of fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 4 && f[2] !== '0x0' && f[3] !== '00:00:00:00:00:00') out[f[0]] = f[3].toLowerCase();
    }
  } catch (e) { /* no ARP table: the sweep answers still count */ }
  return out;
}

// ---------- 2. mDNS ----------
// avahi-browse -p escapes bytes as \DDD (decimal) and other characters as \X
function unescapeAvahi(s) {
  const bytes = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && /^\d{3}$/.test(s.substr(i + 1, 3))) { bytes.push(+s.substr(i + 1, 3)); i += 3; }
    else if (s[i] === '\\' && i + 1 < s.length) { bytes.push(...Buffer.from(s[++i])); }
    else bytes.push(...Buffer.from(s[i]));
  }
  return Buffer.from(bytes).toString('utf8');
}
function browseMdns(ms) {
  return new Promise((resolve) => {
    let out = '', err = null;
    let p;
    try { p = spawn('avahi-browse', ['-a', '-t', '-r', '-p', '-k'], { stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (e) { return resolve({ error: 'avahi-browse is missing', byIp: {}, matter: [] }); }
    const timer = setTimeout(() => p.kill('SIGTERM'), ms);
    p.stdout.on('data', (d) => { if (out.length < 4e6) out += d; });
    p.on('error', (e) => { err = e.code === 'ENOENT' ? 'avahi-browse is missing (apt install avahi-utils)' : e.message; });
    p.on('close', () => {
      clearTimeout(timer);
      const byIp = {}, matter = {};
      for (const line of out.split('\n')) {
        if (!line.startsWith('=;')) continue;
        const f = line.split(';');
        if (f.length < 9) continue;
        const ip = f[7], txt = {};
        for (const m of f.slice(9).join(';').matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
          const kv = unescapeAvahi(m[1]), eq = kv.indexOf('=');
          if (eq > 0) txt[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1);
        }
        // Matter nodes (often Thread devices with only IPv6 addresses): "<fabric>-<node>" once set up
        // (_matter._tcp), or waiting to be set up (_matterc._udp, with its device name and vendor/product)
        if (f[4] === '_matter._tcp' || f[4] === '_matterc._udp') {
          const inst = unescapeAvahi(f[3]), host = unescapeAvahi(f[6]);
          const key = f[4] === '_matter._tcp' ? inst.toUpperCase() : 'c:' + host;
          const n = matter[key] || (matter[key] = { key, op: f[4] === '_matter._tcp', host, ipv4: '', ipv6: '', txt });
          if (!ip.includes(':')) n.ipv4 = ip; else if (!n.ipv6 || !/^fe80/i.test(ip)) n.ipv6 = ip;
        }
        if (ip.includes(':')) continue;             // (the IPv4/IPv6 column is how avahi heard it, not the address)
        const h = byIp[ip] || (byIp[ip] = { host: '', services: {} });
        h.host = h.host || unescapeAvahi(f[6]);
        const type = f[4];
        if (!h.services[type]) h.services[type] = { name: unescapeAvahi(f[3]), txt };
      }
      resolve({ error: Object.keys(byIp).length ? null : err, byIp, matter: Object.values(matter) });
    });
  });
}
const SERVICE_KIND = {
  '_raop._tcp': 'AirPlay speaker', '_airplay._tcp': 'AirPlay', '_googlecast._tcp': 'Google Cast',
  '_hap._tcp': 'HomeKit', '_homekit._tcp': 'HomeKit', '_matter._tcp': 'Matter', '_matterc._udp': 'Matter',
  '_companion-link._tcp': 'Apple device', '_ipp._tcp': 'Printer', '_ipps._tcp': 'Printer', '_printer._tcp': 'Printer',
  '_pdl-datastream._tcp': 'Printer', '_uscan._tcp': 'Scanner', '_scanner._tcp': 'Scanner', '_wled._tcp': 'WLED',
  '_esphomelib._tcp': 'ESPHome', '_home-assistant._tcp': 'Home Assistant', '_spotify-connect._tcp': 'Spotify Connect',
  '_sonos._tcp': 'Sonos', '_smb._tcp': 'File sharing', '_afpovertcp._tcp': 'File sharing', '_adisk._tcp': 'Time Machine',
  '_ssh._tcp': 'SSH', '_mqtt._tcp': 'MQTT broker', '_hue._tcp': 'Philips Hue', '_shelly._tcp': 'Shelly',
  '_androidtvremote2._tcp': 'Android TV', '_roku-rcp._tcp': 'Roku', '_amzn-wplay._tcp': 'Amazon Fire TV',
  '_meshcop._udp': 'Thread border router', '_elg._tcp': 'Elgato', '_nut._tcp': 'UPS', '_workstation._tcp': 'Computer',
  '_http._tcp': 'Web page', '_https._tcp': 'Web page', '_daap._tcp': 'Music sharing', '_ipcam._tcp': 'Camera',
  '_rtsp._tcp': 'Video stream', '_axis-video._tcp': 'Camera', '_device-info._tcp': '',
};
// what the mDNS announcements say: a name, kinds, a model
function mdnsFacts(m) {
  if (!m) return {};
  const s = m.services, kinds = [];
  for (const t of Object.keys(s)) { const k = SERVICE_KIND[t]; if (k && !kinds.includes(k)) kinds.push(k); }
  if (kinds.includes('AirPlay speaker') && kinds.includes('AirPlay')) kinds.splice(kinds.indexOf('AirPlay'), 1);
  const g = s['_googlecast._tcp'], di = s['_device-info._tcp'], ap = s['_airplay._tcp'], hap = s['_hap._tcp'], raop = s['_raop._tcp'];
  let name = [(g && g.txt.fn), (ap && ap.name), (raop && raop.name.replace(/^[0-9A-F]{12}@/i, '')), (hap && hap.name)].find(usable) || '';
  if (!name) {
    for (const [t, v] of Object.entries(s)) {
      if (t === '_workstation._tcp' || t.startsWith('_sleep-proxy') || t.startsWith('_matter') || t === '_spotify-connect._tcp'
        || t === '_meshcop._udp' || t === '_trel._udp' || !usable(v.name)) continue;
      name = v.name; break;
    }
  }
  if (!name && s['_workstation._tcp']) name = s['_workstation._tcp'].name.replace(/\s*\[[0-9a-f:]+\]$/i, '');
  const model = (g && g.txt.md) || (di && di.txt.model) || (ap && ap.txt.model) || (hap && hap.txt.md) || (raop && raop.txt.am) || '';
  const host = m.host.replace(/\.local$/, '');
  const esp = s['_esphomelib._tcp'];
  return { name: name.trim(), kinds, model, host: usable(host) ? host : '', mdnsHost: m.host,
    esphome: esp ? (esp.txt.version || '?') : '', shelly: !!s['_shelly._tcp'],
    matter: !!(s['_matter._tcp'] || s['_matterc._udp']), thread: !!s['_meshcop._udp'] };
}

// ---------- 3. DNS ----------
async function reverseNames(ips, server) {
  const r = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  if (server) r.setServers([server]);
  const out = {};
  let ok = 0, failed = 0;
  await pool(ips, 16, async (ip) => {
    try { const n = await r.reverse(ip); if (n && n[0]) out[ip] = n[0].replace(/\.$/, ''); ok++; }
    catch (e) { if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') ok++; else failed++; }
  });
  return { names: out, error: failed && !ok ? 'the DNS server didn’t answer' : null };
}

// ---------- 4. Home Assistant ----------
// One template call lists every device that has entities (name, maker, model, area, MACs, web address)
// plus router device trackers (they carry ip + mac).
const HA_TEMPLATE = `{%- set ns = namespace(seen=[], devs=[], trk=[], upd=[]) -%}
{%- for s in states -%}{%- set d = device_id(s.entity_id) -%}
{%- if d and d not in ns.seen -%}{%- set ns.seen = ns.seen + [d] -%}
{%- set c = namespace(macs=[], doms=[], mids=[]) -%}
{%- for x in (device_attr(d, 'connections') or []) -%}{%- if x[0] == 'mac' -%}{%- set c.macs = c.macs + [x[1] | lower] -%}{%- endif -%}{%- endfor -%}
{%- for x in (device_attr(d, 'identifiers') or []) -%}{%- if x[0] not in c.doms -%}{%- set c.doms = c.doms + [x[0]] -%}{%- endif -%}
{%- if x[0] == 'matter' and (x[1] | string).startswith('deviceid_') -%}{%- set c.mids = c.mids + [(x[1] | string)[9:] | upper] -%}{%- endif -%}{%- endfor -%}
{%- set ns.devs = ns.devs + [{'id': d, 'name': device_attr(d, 'name_by_user') or device_attr(d, 'name'), 'maker': device_attr(d, 'manufacturer'), 'model': device_attr(d, 'model'), 'sw': device_attr(d, 'sw_version'), 'area': area_name(d), 'macs': c.macs, 'doms': c.doms, 'mids': c.mids, 'url': device_attr(d, 'configuration_url'), 'type': device_attr(d, 'entry_type') | string}] -%}
{%- endif -%}{%- endfor -%}
{%- for s in states.device_tracker -%}{%- if s.attributes.get('ip') or s.attributes.get('mac') -%}
{%- set ns.trk = ns.trk + [{'name': s.name, 'ip': s.attributes.get('ip'), 'mac': (s.attributes.get('mac') or '') | lower, 'host': s.attributes.get('host_name')}] -%}
{%- endif -%}{%- endfor -%}
{%- for s in states.update -%}
{%- set ns.upd = ns.upd + [{'dev': device_id(s.entity_id), 'eid': s.entity_id, 'title': s.attributes.get('title') or s.name, 'inst': s.attributes.get('installed_version'), 'latest': s.attributes.get('latest_version'), 'on': s.state == 'on'}] -%}
{%- endfor -%}
{{ {'devices': ns.devs, 'trackers': ns.trk, 'updates': ns.upd} | to_json }}`;
async function haDevices(url, token) {
  if (!url || !token) return { error: null, skipped: true, devices: [], trackers: [], updates: [] };
  const r = await fetch(url.replace(/\/+$/, '') + '/api/template', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: HA_TEMPLATE }), signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401) throw new Error('Home Assistant refused the token');
  if (!r.ok) {
    const t = (await r.text().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new Error(`Home Assistant answered ${r.status}${t ? ': ' + t : ''}`);
  }
  const j = JSON.parse(await r.text());
  return { error: null, devices: j.devices || [], trackers: j.trackers || [], updates: j.updates || [] };
}
// ---------- Pi-hole (v6 API): its network table, local DNS records, DHCP leases, client comments ----------
async function piholeInfo(url, password) {
  if (!url) return { skipped: true };
  const base = url.replace(/\/+$/, '').replace(/\/admin$/, '');
  const call = async (method, p, sid, body) => {
    const r = await fetch(base + p, { method, signal: AbortSignal.timeout(15000),
      headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'X-FTL-SID': sid } : {}), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) throw new Error('unauthorized');
    if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
    return j;
  };
  const a = await call('POST', '/api/auth', null, { password: password || '' }).catch((e) => { throw new Error(/unauthor|password/i.test(e.message) ? 'Pi-hole refused the password' : e.message); });
  const sid = a.session && a.session.sid;
  if (a.session && a.session.totp && !sid) throw new Error('Pi-hole asks for a 2-factor code: use an app password instead');
  try {
    const [devs, hosts, cnames, leases, clients, summary, topC, topB, topD, topBD] = await Promise.all([
      call('GET', '/api/network/devices?max_devices=1000&max_addresses=8', sid),
      call('GET', '/api/config/dns/hosts', sid).catch(() => null),
      call('GET', '/api/config/dns/cnameRecords', sid).catch(() => null),
      call('GET', '/api/dhcp/leases', sid).catch(() => null),
      call('GET', '/api/clients', sid).catch(() => null),
      // statistics (Pi-hole's last 24 hours)
      call('GET', '/api/stats/summary', sid).catch(() => null),
      call('GET', '/api/stats/top_clients?count=15', sid).catch(() => null),
      call('GET', '/api/stats/top_clients?blocked=true&count=15', sid).catch(() => null),
      call('GET', '/api/stats/top_domains?count=10', sid).catch(() => null),
      call('GET', '/api/stats/top_domains?blocked=true&count=15', sid).catch(() => null),
    ]);
    // what the most-blocked devices keep asking for
    const blockedBy = {};
    await Promise.all(((topB && topB.clients) || []).slice(0, 8).map(async (c) => {
      const q = await call('GET', `/api/queries?client_ip=${encodeURIComponent(c.ip)}&upstream=blocklist&length=500`, sid).catch(() => null);
      const n = {};
      for (const x of (q && q.queries) || []) if (x.domain) n[x.domain] = (n[x.domain] || 0) + 1;
      blockedBy[c.ip] = Object.entries(n).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([domain, count]) => ({ domain, count }));
    }));
    const qs = (summary && summary.queries) || {};
    const stats = summary ? {
      total: qs.total || 0, blocked: qs.blocked || 0, percent: qs.percent_blocked || 0, cached: qs.cached || 0, forwarded: qs.forwarded || 0,
      uniqueDomains: qs.unique_domains || 0, clients: (summary.clients && summary.clients.active) || 0,
      listed: (summary.gravity && summary.gravity.domains_being_blocked) || 0,
      topClients: ((topC && topC.clients) || []).map((c) => ({ ip: c.ip, name: c.name || '', count: c.count })),
      topBlocked: ((topB && topB.clients) || []).map((c) => ({ ip: c.ip, name: c.name || '', count: c.count, domains: blockedBy[c.ip] || [] })),
      topDomains: ((topD && topD.domains) || []).map((d) => ({ domain: d.domain, count: d.count })),
      topBlockedDomains: ((topBD && topBD.domains) || []).map((d) => ({ domain: d.domain, count: d.count })),
    } : null;
    const byIp = {}, byMac = {};
    const get = (ip) => byIp[ip] || (byIp[ip] = { names: [], records: [], comment: '', vendor: '', queries: 0, lastQuery: 0, lease: '' });
    for (const d of devs.devices || []) {
      const mac = String(d.hwaddr || '').toLowerCase();
      for (const a2 of d.ips || []) {
        if (!a2.ip || a2.ip.includes(':')) continue;
        const e = get(a2.ip);
        if (a2.name && !e.names.includes(a2.name)) e.names.push(a2.name);
        if (/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) { e.mac = mac; byMac[mac] = e; }
        e.vendor = e.vendor || d.macVendor || '';
        e.queries = Math.max(e.queries, d.numQueries || 0);
        e.lastQuery = Math.max(e.lastQuery, (d.lastQuery || 0) * 1000);
      }
    }
    const recs = (((hosts || {}).config || {}).dns || {}).hosts || [];
    for (const line of recs) {
      const [ip, ...names] = String(line).trim().split(/\s+/);
      if (ip && !ip.includes(':')) for (const n of names) { const e = get(ip); if (!e.records.includes(n)) e.records.push(n); }
    }
    const cn = (((cnames || {}).config || {}).dns || {}).cnameRecords || [];
    const cnameOf = {};
    for (const line of cn) { const [alias, target] = String(line).split(','); if (alias && target) (cnameOf[target.trim()] = cnameOf[target.trim()] || []).push(alias.trim()); }
    for (const e of Object.values(byIp)) for (const n of [...e.records, ...e.names]) for (const al of cnameOf[n] || []) if (!e.records.includes(al)) e.records.push(al);
    for (const l of (leases || {}).leases || []) { if (l.ip && !l.ip.includes(':')) { const e = get(l.ip); e.lease = l.name && l.name !== '*' ? l.name : ''; } }
    for (const c of (clients || {}).clients || []) {
      if (!c.comment) continue;
      const k = String(c.client || '').toLowerCase();
      const e = byIp[k] || byMac[k];
      if (e) e.comment = c.comment;
    }
    return { byIp, byMac, stats, records: recs };
  } finally {
    if (sid) await call('DELETE', '/api/auth', sid).catch(() => {});   // free the session (Pi-hole allows only a few)
  }
}

const urlHost = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

// ---------- TP-Link Kasa / Tapo ----------
// Older Kasa devices answer the local protocol on TCP 9999 (XOR "autokey") with their name, model and firmware.
// Newer ones (KLAP) need the TP-Link account to log in, but answer the UDP 20002 discovery with model and type.
const kasaEnc = (str) => { const b = Buffer.from(str); let k = 171; const o = Buffer.alloc(b.length + 4); o.writeUInt32BE(b.length);
  for (let i = 0; i < b.length; i++) { k = b[i] ^ k; o[i + 4] = k; } return o; };
const kasaDec = (b) => { let k = 171; const o = Buffer.alloc(b.length); for (let i = 0; i < b.length; i++) { o[i] = b[i] ^ k; k = b[i]; } return o.toString(); };
function kasaSysinfo(ip) {
  return new Promise((resolve) => {
    const sock = net.connect(9999, ip);
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { sock.destroy(); resolve(null); }, 2500);
    sock.on('connect', () => sock.write(kasaEnc('{"system":{"get_sysinfo":{}}}')));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= buf.readUInt32BE(0) + 4) {
        clearTimeout(t); sock.destroy();
        try { resolve(JSON.parse(kasaDec(buf.slice(4))).system.get_sysinfo); } catch (e) { resolve(null); }
      }
    });
    sock.on('error', () => { clearTimeout(t); resolve(null); });
  });
}
function tplinkDiscover(ips, ms) {
  return new Promise((resolve) => {
    const dgram = require('dgram'), out = {};
    let sock;
    try { sock = dgram.createSocket('udp4'); } catch (e) { return resolve(out); }
    const pkt = Buffer.from('020000010000000000000000463cb5d3', 'hex');
    sock.on('message', (m, r) => { try { const x = JSON.parse(m.slice(16).toString()).result || {}; out[r.address] = { type: x.device_type || '', model: x.device_model || '', login: !!(x.mgt_encrypt_schm && x.mgt_encrypt_schm.encrypt_type) }; } catch (e) { /* not one */ } });
    sock.on('error', () => {});
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch (e) { /* fine */ }
      for (const ip of ips) sock.send(pkt, 20002, ip, () => {});
    });
    setTimeout(() => { try { sock.close(); } catch (e) { /* closed */ } resolve(out); }, ms || 3000);
  });
}
const KASA_KIND = { 'IOT.SMARTPLUGSWITCH': 'plug or switch', 'IOT.SMARTBULB': 'bulb', 'SMART.KASASWITCH': 'light switch', 'SMART.KASAPLUG': 'plug',
  'SMART.TAPOPLUG': 'plug', 'SMART.TAPOBULB': 'bulb', 'SMART.TAPOSWITCH': 'light switch', 'SMART.KASAHUB': 'hub', 'SMART.TAPOHUB': 'hub', 'SMART.IPCAMERA': 'camera' };

// ---------- 5. its web page ----------
async function getText(url, ms) {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms), redirect: 'manual' });
  const t = r.ok ? (await r.text()).slice(0, 200000) : '';
  return { ok: r.ok, status: r.status, text: t, server: r.headers.get('server') || '' };
}
async function lookAtWeb(ip) {
  const out = {};
  const [info, sys, home] = await Promise.allSettled([
    getText(`http://${ip}/json/info`, 2500), getText(`http://${ip}/api/system/info`, 2500), getText(`http://${ip}/`, 2500)]);
  try {
    const i = info.status === 'fulfilled' && info.value.ok && JSON.parse(info.value.text);
    if (i && i.ver && (i.leds || i.brand)) {
      const mx = /matrixinator-(.+)$/.exec(i.ver);
      out.kind = mx ? 'Matrixinator screen' : (i.brand && i.brand !== 'WLED' ? i.brand : 'WLED') + ' LED controller';
      out.name = i.name || '';
      out.version = mx ? mx[1] : i.ver + (i.dither && i.dither.fw ? '-' + i.dither.fw : '');
      out.extra = !mx && i.leds && i.leds.count ? i.leds.count + ' LEDs' : '';
      out.fw = mx ? 'matrixinator' : /esp32$/i.test(i.arch || '') ? 'wled-esp32' : '';
    }
  } catch (e) { /* not WLED */ }
  try {
    const s = !out.kind && sys.status === 'fulfilled' && sys.value.ok && JSON.parse(sys.value.text);
    if (s && s.info && s.info.firmware_version) {
      out.kind = 'AirPlay receiver (airplay-esp32)'; out.name = s.info.device_name || ''; out.version = s.info.firmware_version; out.fw = 'airplay';
    }
  } catch (e) { /* not the AirPlay receiver */ }
  if (home.status === 'fulfilled') {
    const t = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(home.value.text);
    if (t) out.title = t[1].replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    if (home.value.server) out.server = home.value.server.slice(0, 60);
  }
  return out;
}

// ---------- the whole check ----------
async function scan(opts) {
  const t0 = Date.now();
  const mine = localNets();
  let range;
  if (opts.subnet) range = parseCidr(opts.subnet);
  else {
    if (!mine.length) throw new Error('This server has no IPv4 network address.');
    range = parseCidr(mine[0].cidr);
  }
  const self = mine.find((a) => ip2n(a.ip) >= range.first && ip2n(a.ip) <= range.last);
  const ips = [];
  for (let n = range.first; n <= range.last; n++) ips.push(n2ip(n));

  const mdnsP = browseMdns(15000);                // runs while the sweep does
  const ouiP = opts.dataDir ? loadOui(opts.dataDir).catch(() => null) : Promise.resolve(null);
  const answer = {};
  await pool(ips, SWEEP_PAR, async (ip) => { const r = await tryConnect(ip); if (r) answer[ip] = r; });
  const arp = readArp();
  const live = ips.filter((ip) => answer[ip] || arp[ip] || (self && ip === self.ip));
  const sources = {};

  const [mdns, rdns, ha, makers, pi] = await Promise.all([
    mdnsP,
    reverseNames(live, opts.dns),
    haDevices(opts.haUrl, opts.haToken).catch((e) => ({ error: e.name === 'TimeoutError' ? 'Home Assistant didn’t answer' : e.message, devices: [], trackers: [], updates: [] })),
    ouiP,
    piholeInfo(opts.piholeUrl, opts.piholePassword).catch((e) => ({ error: e.name === 'TimeoutError' ? 'Pi-hole didn\u2019t answer' : e.message })),
  ]);
  sources.pihole = pi.skipped ? 'not set up' : pi.error || 'ok';
  const dnsStats = pi.stats || null;
  sources.mdns = mdns.error || 'ok';
  sources.dns = rdns.error || 'ok';
  sources.ha = ha.skipped ? 'not set up' : ha.error || 'ok';

  const web = {};
  const tpIps = live.filter((ip) => arp[ip] && /^tp-?link/i.test(makerOf(arp[ip], makers)));
  const [, tpDisc] = await Promise.all([
    pool(live.filter((ip) => answer[ip] === 'open'), HTTP_PAR, async (ip) => { web[ip] = await lookAtWeb(ip).catch(() => ({})); }),
    tplinkDiscover(tpIps, 3000),
  ]);
  const kasa = {};
  await pool(tpIps.filter((ip) => !tpDisc[ip] || !tpDisc[ip].login), 16, async (ip) => { const i = await kasaSysinfo(ip); if (i) kasa[ip] = i; });

  const haByMac = {}, haByHost = {}, haByMatter = {}, trkByIp = {}, trkByMac = {}, updByDev = {};
  for (const d of ha.devices) {
    for (const m of d.macs || []) haByMac[m] = d;
    for (const m of d.mids || []) haByMatter[m] = d;
    const h = urlHost(d.url); if (h) haByHost[h] = d;
  }
  for (const t of ha.trackers) { if (t.ip) trkByIp[t.ip] = t; if (t.mac) trkByMac[t.mac] = t; }
  for (const u of ha.updates) if (u.dev) (updByDev[u.dev] = updByDev[u.dev] || []).push(u);
  const used = new Set();                         // HA devices matched to an address

  // Home Assistant's own updates (Core, OS, Supervisor) belong to the machine it runs on
  const haSelfUpd = ha.updates.filter((u) => /^update\.home_assistant_(core|operating_system|supervisor)_update$/.test(u.eid));

  const hosts = live.map((ip) => {
    const mac = arp[ip] || (self && ip === self.ip ? self.mac : '');
    const pe = (pi.byIp && pi.byIp[ip]) || (mac && pi.byMac && pi.byMac[mac]) || null;
    const dnsNames = [...new Set([rdns.names[ip], ...((pe && pe.records) || []), ...((pe && pe.names) || []), pe && pe.lease].filter(Boolean))];
    const dnsName = dnsNames[0] || '';
    const short = (n) => n && n.split('.')[0];
    const md = mdnsFacts(mdns.byIp[ip]), w = web[ip] || {};
    const hd = (mac && haByMac[mac]) || haByHost[ip] || (dnsName && haByHost[dnsName.toLowerCase()])
      || (md.mdnsHost && haByHost[md.mdnsHost.toLowerCase()]) || null;
    if (hd) used.add(hd.id);
    const trk = trkByIp[ip] || (mac && trkByMac[mac]) || null;
    const isSelf = !!(self && ip === self.ip);
    const maker = makerOf(mac, makers) || (pe && pe.vendor) || '';
    const isHa = (md.kinds || []).includes('Home Assistant');
    const ks = kasa[ip], td = tpDisc[ip];
    if (ks || td) {                                   // a TP-Link Kasa/Tapo device: its own name, model, firmware
      const model = ((ks && ks.model) || (td && td.model) || '').replace(/\(.*\)$/, '');
      w.kind = ['Kasa', model, (ks && ks.dev_name) || (td && KASA_KIND[td.type]) || ''].filter(Boolean).join(' ');
      if (ks) { w.name = ks.alias || ''; w.version = (ks.sw_ver || '').split(' ')[0]; }
      w.kasaLogin = !!(td && td.login && !ks);
      if (!w.name && model) w.fallbackName = `Kasa ${model} ${(td && KASA_KIND[td.type]) || 'device'}`;
    }
    const name = (isSelf && os.hostname()) || [hd && hd.name, w.name].find(usable) || (isHa && 'Home Assistant')
      || [md.name, trk && trk.name, pe && pe.lease, ...dnsNames.map(short)].find(usable) || md.host || [trk && trk.host].find(usable)
      || w.fallbackName || '';
    const desc = [];
    if (isSelf) desc.push('This server (Lickety Split)');
    if (pe && pe.comment) desc.push(pe.comment);
    if (w.kind) desc.push(w.kind + (w.version ? ' ' + w.version : '') + (w.extra ? ', ' + w.extra : ''));
    if (hd && (hd.maker || hd.model)) {
      const mm = [hd.maker, hd.model].filter(Boolean).join(' ');
      if (!desc.some((d) => d.includes(mm))) desc.push(mm);
    } else if (md.model) desc.push(md.model);
    const kinds = md.kinds ? md.kinds.filter((k) => !(w.kind && (k === 'WLED' || k === 'Web page')) && k !== 'SSH') : [];
    if (kinds.length) desc.push(kinds.join(', '));
    if (maker && maker !== 'private address' && !desc.some((d) => d.toLowerCase().includes(maker.toLowerCase().split(/[ ,]/)[0]))) desc.push('Made by ' + brandOf(maker));
    if (w.kasaLogin && !hd) desc.push('its name needs the TP-Link login (or Home Assistant)');
    if (w.title && w.title !== name && desc.length < 2) desc.push('Web page: ' + w.title);
    else if (!w.title && w.server && desc.length < 2) desc.push('Web server: ' + w.server);
    if (maker === 'private address' && !desc.length) desc.push('Phone, tablet or computer (private Wi-Fi address)');
    const upd = updateWay({ w, md, hd, maker, isHa, ups: (hd && updByDev[hd.id]) || (isHa ? haSelfUpd : []) });
    const matter = !!(md.matter || md.thread || (hd && (hd.doms || []).some((x) => x === 'matter' || x === 'thread')));
    const brand = brandOf((hd && hd.maker) || maker);
    const home = !isSelf && !isHa && (HOME_BRAND.test(brand) || (md.kinds || []).some((k) => HOME_KINDS.includes(k))
      || !!(hd && (hd.doms || []).some((x) => HOME_DOMAINS.includes(x))));
    return {
      key: mac || ip, ip, mac, name, generic: !!(w.fallbackName && name === w.fallbackName), dns: dnsName, dnsAll: dnsNames, mdns: md.mdnsHost || '', area: (hd && hd.area) || '', maker, brand,
      desc: desc.join(' · '), inHa: !!hd, fw: w.fw || '', version: w.version || '', web: answer[ip] === 'open',
      matter, thread: !!md.thread, update: upd, group: groupOf(w.fw, matter, upd, isHa, home),
      queries: (pe && pe.queries) || 0, lastQuery: (pe && pe.lastQuery) || 0,
    };
  });

  // Matter devices without an IPv4 address of their own (mostly Thread): from mDNS and Home Assistant
  for (const n of mdns.matter) {
    if (n.ipv4 && hosts.some((h) => h.ip === n.ipv4)) continue;
    const hd = n.op ? haByMatter[n.key] : null;
    if (hd) { if (used.has(hd.id)) continue; used.add(hd.id); }
    const vp = (n.txt.vp || '').split('+');
    hosts.push({
      key: hd ? 'ha:' + hd.id : 'matter:' + n.key, ip: n.ipv4 || '', ipv6: n.ipv6, mac: '', dns: '', mdns: n.host,
      name: (hd && hd.name) || n.txt.dn || (n.op ? 'Matter device' : 'Matter device waiting to be set up'),
      area: (hd && hd.area) || '', maker: '', brand: brandOf(hd && hd.maker), inHa: !!hd, fw: '', version: (hd && hd.sw) || '', web: false, matter: true, thread: !n.ipv4,
      desc: [hd && [hd.maker, hd.model].filter(Boolean).join(' '), n.op ? '' : 'not set up yet' + (vp[0] ? ` (vendor ${vp[0]}, product ${vp[1] || '?'})` : ''),
        n.ipv4 ? 'Matter over Wi-Fi' : 'Matter over Thread'].filter(Boolean).join(' · '),
      update: hd ? updateWay({ w: {}, md: {}, hd, maker: '', ups: updByDev[hd.id] || [] }) : null, group: 'matter',
    });
  }
  // Home Assistant devices with no address here: Matter/Thread ones, and any with a firmware update entity
  for (const d of ha.devices) {
    if (used.has(d.id) || /service/i.test(d.type || '') || (d.doms || []).includes('hassio')) continue;
    const isMatter = (d.doms || []).some((x) => x === 'matter' || x === 'thread');
    const isEsp = (d.doms || []).includes('esphome');
    const ups = (updByDev[d.id] || []).filter((u) => !/^update\.home_assistant_/.test(u.eid));
    if (!isMatter && !isEsp && !ups.length) continue;
    used.add(d.id);
    const via = isEsp ? '' : isMatter ? 'Matter' : ({ zha: 'Zigbee', zwave_js: 'Z-Wave', hue: 'Hue bridge', deconz: 'Zigbee', mqtt: 'MQTT' })[(d.doms || [])[0]] || (d.doms || [])[0] || '';
    hosts.push({
      key: 'ha:' + d.id, ip: '', mac: '', dns: '', mdns: '', name: d.name || 'Home Assistant device', area: d.area || '', maker: '',
      inHa: true, fw: '', version: d.sw || '', web: false, matter: isMatter, thread: false,
      desc: [isEsp ? 'ESPHome' + (d.sw ? ' ' + d.sw : '') : '', [d.maker, d.model].filter((x) => x && !/^esphome$/i.test(x)).join(' '),
        isEsp ? 'not answering on the network now (asleep, off, or off the Wi-Fi?)' : via && 'via ' + via + ' (no address of its own)'].filter(Boolean).join(' · '),
      brand: brandOf(d.maker), update: updateWay({ w: {}, md: isEsp ? { esphome: d.sw || '?' } : {}, hd: d, maker: '', ups }),
      group: isMatter ? 'matter' : isEsp ? 'updatable' : 'home', away: isEsp,
    });
  }
  return { at: Date.now(), took: Date.now() - t0, subnet: range.cidr, sources, hosts, dnsStats, piRecords: pi.records || null };
}

// ---------- naming devices in Pi-hole ----------
// Devices with a good name (Home Assistant, mDNS, their own page…) but no DNS name get a local DNS record
// "<ip> <name>.<suffix>" in Pi-hole. Each record Lickety Split makes is remembered by the device's MAC address
// ({ mac, ip, host, seen }), so:
//  - a device keeps its name; when its address changes the record follows it (old one removed, new one added),
//  - when an address is reused by another device, the old record goes at once (a name never points elsewhere),
//  - a device that's away keeps its record for AWAY_KEEP, then it's removed,
//  - records Lickety Split didn't make are never touched, and a record you remove (here or in Pi-hole) stays removed.
const AWAY_KEEP = 24 * 3600 * 1000;
const slug = (n) => String(n).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
const lineOf = (e) => `${e.ip} ${e.host}`;
function planNames(res, opts) {
  const { managed = [], suffix = 'lan', overrides = {}, piRecords = [] } = opts;
  const now = res.at || Date.now();
  const ours = new Set(managed.map(lineOf));
  const recSet = new Set(piRecords);
  const userRemoved = managed.filter((m) => !recSet.has(lineOf(m))).map((m) => m.mac);   // gone from Pi-hole: removed by hand
  const skip = (mac) => (overrides[mac] && overrides[mac].skip) || userRemoved.includes(mac);
  const taken = new Set();                     // names in Pi-hole that aren't ours
  for (const line of piRecords) if (!ours.has(line)) for (const n of line.split(/\s+/).slice(1)) taken.add(n.toLowerCase());
  const ourNames = new Set(managed.map((m) => m.host));
  const byMac = {}, macAt = {};
  for (const h of res.hosts) if (h.online && h.ip && h.mac && !h.ip.includes(':')) { byMac[h.mac] = h; macAt[h.ip] = h.mac; }
  const hasOwnDns = (h) => (h.dnsAll || []).some((n) => !ourNames.has(n));
  const out = [], used = new Set(), usedIp = new Set();
  const take = (e) => { out.push(e); used.add(e.host); usedIp.add(e.ip); };
  const uniq = (base) => { let n = `${base}.${suffix}`, i = 2; while (taken.has(n) || used.has(n)) n = `${base}-${i++}.${suffix}`; return n; };
  const custom = (mac) => overrides[mac] && overrides[mac].host;
  // 1. records we already have: keep the name, follow the device
  for (const m of managed) {
    if (skip(m.mac)) continue;
    const h = byMac[m.mac];
    if (h) {
      if (hasOwnDns(h)) continue;                                   // it has a real DNS name now
      take({ mac: m.mac, ip: h.ip, host: custom(m.mac) || m.host, seen: now, device: h.name });
    } else if (macAt[m.ip] && macAt[m.ip] !== m.mac) continue;      // its address belongs to another device now
    else if (now - (m.seen || 0) < AWAY_KEEP) take(Object.assign({}, m, custom(m.mac) ? { host: custom(m.mac) } : {}));
  }
  // 2. newly named devices
  for (const h of Object.values(byMac)) {
    if (skip(h.mac) || out.some((e) => e.mac === h.mac) || usedIp.has(h.ip) || !h.name || h.generic || hasOwnDns(h)) continue;
    const base = custom(h.mac) ? null : slug(h.name);
    if (!custom(h.mac) && (!base || /^(unknown|phone-or-computer)$/.test(base))) continue;
    take({ mac: h.mac, ip: h.ip, host: custom(h.mac) || uniq(base), seen: now, device: h.name });
  }
  return { want: out, userRemoved };
}
// plan(records) gets Pi-hole's records as they are right now (read in the same session) and returns
// { want, userRemoved, managed }; only the difference between managed and want is sent.
async function piholeSync(url, password, plan) {
  const base = url.replace(/\/+$/, '');
  const call = async (method, p, sid, body) => {
    const r = await fetch(base + p, { method, signal: AbortSignal.timeout(15000),
      headers: Object.assign({ 'Content-Type': 'application/json' }, sid ? { 'X-FTL-SID': sid } : {}), body: body ? JSON.stringify(body) : undefined });
    if (r.status === 401) throw new Error('Pi-hole refused the password');
    if (!r.ok && r.status !== 404) { const j = await r.json().catch(() => ({})); throw new Error((j.error && (j.error.hint || j.error.message)) || 'HTTP ' + r.status); }
    return r;
  };
  const a = await (await call('POST', '/api/auth', null, { password })).json();
  const sid = a.session && a.session.sid;
  const removed = [], added = [];
  let p;
  try {
    const cur = await (await call('GET', '/api/config/dns/hosts', sid)).json();
    const records = (((cur || {}).config || {}).dns || {}).hosts || [];
    p = plan(records);
    const recSet = new Set(records);
    const wantLines = new Set(p.want.map(lineOf));
    const had = new Set(p.managed.map(lineOf).filter((l) => recSet.has(l)));   // (gone already: nothing to delete)
    for (const line of had) if (!wantLines.has(line)) { await call('DELETE', '/api/config/dns/hosts/' + encodeURIComponent(line), sid); removed.push(line); }
    for (const line of wantLines) if (!had.has(line)) {
      try { await call('PUT', '/api/config/dns/hosts/' + encodeURIComponent(line), sid); added.push(line); }
      catch (e) { if (!/exist|duplicate|already/i.test(e.message)) throw e; added.push(line); }
    }
  } finally {
    if (sid) await call('DELETE', '/api/auth', sid).catch(() => {});
  }
  return { added, removed, want: p.want, userRemoved: p.userRemoved };
}

// ---------- how a device's firmware gets updated ----------
// by: licketysplit | ha (an update entity) | esphome | web (its own page) | app (maker's app / automatic)
const APP_WAY = [
  [/^eero/i, 'eero app (automatic)'], [/^ecobee/i, 'automatic (ecobee)'], [/^Apple/i, 'automatic or Software Update'],
  [/^Amazon/i, 'automatic (Amazon)'], [/^Ring/i, 'automatic (Ring app)'], [/^(TP-Link|Tp-Link)/i, 'Kasa or Tapo app'],
  [/^Belkin/i, 'Wemo app'], [/^Google/i, 'automatic (Google Home)'], [/^Sonos/i, 'Sonos app'], [/^(Signify|Philips)/i, 'Hue app'],
  [/^Proxmox/i, 'system updates (a Proxmox VM or container: apt)'], [/^Raspberry/i, 'system updates (apt)'],
  [/^Nintendo/i, 'the console’s settings'], [/^Vizio/i, 'automatic (TV)'], [/^Orbit/i, 'B-hyve app'], [/^(GD )?Midea/i, 'Midea app'],
  [/^Roku/i, 'automatic (Roku)'], [/^(Samsung)/i, 'automatic or SmartThings'], [/^Hewlett|^HP/i, 'the printer’s web page'],
  [/^Intel/i, 'the computer’s system updates'], [/^Ubiquiti/i, 'UniFi app'], [/^Wyze/i, 'Wyze app'], [/^Lutron/i, 'Lutron app'],
];
function updateWay({ w, md, hd, maker, isHa, ups }) {
  const u = (ups || []).find((x) => x.on) || (ups || [])[0];
  if (w.fw) {
    return { by: 'licketysplit', how: 'Lickety Split' + (u ? ' (not Home Assistant’s update: that installs plain WLED without temporal dithering)' : ''),
      installed: w.version || '' };
  }
  if (u) {
    const esp = md.esphome || (hd && (hd.doms || []).includes('esphome'));
    const n = (ups || []).length > 1 ? ` (${ups.length} updates)` : '';
    return { by: esp ? 'esphome' : 'ha', how: (esp ? 'ESPHome, from Home Assistant' : isHa ? 'Home Assistant: Settings → Updates' : 'Home Assistant') + n,
      installed: u.inst || '', latest: u.latest || '', available: !!(ups || []).some((x) => x.on), entity: u.eid, title: u.title || '' };
  }
  if (md.esphome) return { by: 'esphome', how: 'ESPHome dashboard (or the ESPHome add-on in Home Assistant)', installed: md.esphome === '?' ? '' : md.esphome };
  if (md.shelly || /shelly/i.test(w.title || '')) return { by: 'web', how: 'its web page: Settings → Firmware', installed: '' };
  if (/tasmota/i.test(w.title || '')) return { by: 'web', how: 'its web page: Firmware Upgrade', installed: '' };
  if (/^WLED/.test(w.kind || '')) return { by: 'web', how: 'WLED’s page: Settings → Security & Updates', installed: w.version || '' };
  if (/octoprint/i.test(w.title || '')) return { by: 'web', how: 'OctoPrint’s software update', installed: '' };
  if (isHa) return { by: 'web', how: 'Home Assistant: Settings → Updates', installed: '' };
  const mk = (hd && hd.maker) || maker || '';
  for (const [re, how] of APP_WAY) if (re.test(mk)) return { by: 'app', how: /^Kasa/.test(w.kind || '') ? 'Kasa app' : how, installed: (hd && hd.sw) || w.version || '' };
  return null;
}
// home automation: plugs, switches, thermostats, sensors, cameras… (grouped by maker on the page)
const HOME_BRAND = /^(TP-Link|Belkin|Wemo|ecobee|Ring|Orbit|Midea|Signify|Philips|Lutron|Wyze|Tuya|Shelly|Sonoff|ITEAD|Meross|Govee|LIFX|Nanoleaf|Chamberlain|SimpliSafe|Arlo|Eufy|August|Yale|Rachio|Sense|Emporia|iRobot|Roborock|Ecovacs|Leviton|Jasco|Aqara|Lumi|Broadlink|SwitchBot|Mysa|Nest|Honeywell|Resideo|Sensibo|Rinnai|Hunter Douglas|Lockly|Kwikset|Schlage|MyQ|Konnected|Ezviz|Reolink|Amcrest|Hubitat|SmartThings|Insteon|Z-Wave|Zooz|Inovelli|Third Reality|Wiz)\b/i;
const HOME_KINDS = ['HomeKit', 'Shelly', 'Philips Hue'];
const HOME_DOMAINS = ['tplink', 'tplink_omada', 'wemo', 'ecobee', 'ring', 'hue', 'lutron_caseta', 'shelly', 'tuya', 'meross', 'govee', 'lifx',
  'nanoleaf', 'myq', 'rachio', 'roborock', 'wiz', 'switchbot', 'homekit_controller', 'kasa', 'midea_ac', 'august', 'yale', 'nest', 'mysa', 'bhyve'];
function brandOf(m) {
  m = String(m || '').trim();
  if (!m || m === 'private address') return '';
  if (/^tp-?link/i.test(m)) return 'TP-Link';
  if (/^belkin/i.test(m)) return 'Belkin (Wemo)';
  if (/midea/i.test(m)) return 'Midea';
  if (/^(signify|philips lighting)/i.test(m)) return 'Philips Hue';
  if (/^orbit/i.test(m)) return 'Orbit B-hyve';
  if (/^ring\b/i.test(m)) return 'Ring';
  return m.replace(/[\s,，]*(Technologies|Technology|Systems|International|Electronics|Corporate|Corporation|Inc\b|Co\.?,?\s*Ltd|Co\.|Ltd|LLC|GmbH|Limited)\b.*$/i, '').trim() || m;
}
function groupOf(fw, matter, upd, isHa, home) {
  if (fw) return 'licketysplit';
  if (isHa) return 'updatable';
  if (matter) return 'matter';
  if (home) return 'home';
  if (upd && upd.by !== 'app') return 'updatable';
  return 'other';
}

// keeps the list of devices between checks (devices that went away stay a while, marked offline)
function merge(prev, res) {
  const old = {};
  for (const h of (prev && prev.hosts) || []) old[h.key] = h;
  const seen = new Set();
  const hosts = res.hosts.map((h) => {
    seen.add(h.key);
    const o = old[h.key];
    return Object.assign({}, h, { online: true, firstSeen: (o && o.firstSeen) || res.at, lastSeen: res.at });
  });
  for (const o of Object.values(old)) {
    if (seen.has(o.key) || res.at - o.lastSeen > KEEP_DAYS * 86400000) continue;
    // an entry known only by address (no MAC: a Matter node, a Home Assistant device) whose address now belongs
    // to a device found this time is the same device, seen better: drop the old one
    if (o.ip && !o.mac && res.hosts.some((h) => h.ip === o.ip)) continue;
    hosts.push(Object.assign({}, o, { online: false }));
  }
  hosts.sort((a, b) => (b.online - a.online) || ip2n(a.ip) - ip2n(b.ip));
  return { at: res.at, took: res.took, subnet: res.subnet, sources: res.sources, hosts, dnsStats: res.dnsStats || null, piRecords: res.piRecords || null };
}

module.exports = { scan, merge, parseCidr, localNets, planNames, piholeSync, _test: { unescapeAvahi, mdnsFacts, HA_TEMPLATE } };
