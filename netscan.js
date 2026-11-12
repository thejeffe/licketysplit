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
const JUNK_NAME = /^(?:[0-9a-f]{12,}(?:-[0-9a-f]+)*|[0-9a-f]{8}-[0-9a-f-]{20,}|none(?:-\d+)?|linux(?:-\d+)?|SpotifyConnect(?: #\d+| \(\d+\))?|Spotify Desktop Launcher|esp32-[0-9a-f]+)$/i;
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
{%- for s in states.device_tracker -%}{%- if s.attributes.ip or s.attributes.mac -%}
{%- set ns.trk = ns.trk + [{'name': s.name, 'ip': s.attributes.ip, 'mac': (s.attributes.mac or '') | lower, 'host': s.attributes.host_name}] -%}
{%- endif -%}{%- endfor -%}
{%- for s in states.update -%}
{%- set ns.upd = ns.upd + [{'dev': device_id(s.entity_id), 'eid': s.entity_id, 'title': s.attributes.title or s.name, 'inst': s.attributes.installed_version, 'latest': s.attributes.latest_version, 'on': s.state == 'on'}] -%}
{%- endfor -%}
{{ {'devices': ns.devs, 'trackers': ns.trk, 'updates': ns.upd} | to_json }}`;
async function haDevices(url, token) {
  if (!url || !token) return { error: null, skipped: true, devices: [], trackers: [], updates: [] };
  const r = await fetch(url.replace(/\/+$/, '') + '/api/template', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ template: HA_TEMPLATE }), signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401) throw new Error('Home Assistant refused the token');
  if (!r.ok) throw new Error(`Home Assistant answered ${r.status}`);
  const j = JSON.parse(await r.text());
  return { error: null, devices: j.devices || [], trackers: j.trackers || [], updates: j.updates || [] };
}
const urlHost = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch (e) { return ''; } };

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

  const [mdns, rdns, ha, makers] = await Promise.all([
    mdnsP,
    reverseNames(live, opts.dns),
    haDevices(opts.haUrl, opts.haToken).catch((e) => ({ error: e.name === 'TimeoutError' ? 'Home Assistant didn’t answer' : e.message, devices: [], trackers: [], updates: [] })),
    ouiP,
  ]);
  sources.mdns = mdns.error || 'ok';
  sources.dns = rdns.error || 'ok';
  sources.ha = ha.skipped ? 'not set up' : ha.error || 'ok';

  const web = {};
  await pool(live.filter((ip) => answer[ip] === 'open'), HTTP_PAR, async (ip) => { web[ip] = await lookAtWeb(ip).catch(() => ({})); });

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
    const dnsName = rdns.names[ip] || '';
    const md = mdnsFacts(mdns.byIp[ip]), w = web[ip] || {};
    const hd = (mac && haByMac[mac]) || haByHost[ip] || (dnsName && haByHost[dnsName.toLowerCase()])
      || (md.mdnsHost && haByHost[md.mdnsHost.toLowerCase()]) || null;
    if (hd) used.add(hd.id);
    const trk = trkByIp[ip] || (mac && trkByMac[mac]) || null;
    const isSelf = !!(self && ip === self.ip);
    const maker = makerOf(mac, makers);
    const isHa = (md.kinds || []).includes('Home Assistant');
    const name = (isSelf && os.hostname()) || [hd && hd.name, w.name].find(usable) || (isHa && 'Home Assistant')
      || [md.name, trk && trk.name].find(usable) || (dnsName && dnsName.split('.')[0]) || md.host || [trk && trk.host].find(usable) || '';
    const desc = [];
    if (isSelf) desc.push('This server (Lickety Split)');
    if (w.kind) desc.push(w.kind + (w.version ? ' ' + w.version : '') + (w.extra ? ', ' + w.extra : ''));
    if (hd && (hd.maker || hd.model)) {
      const mm = [hd.maker, hd.model].filter(Boolean).join(' ');
      if (!desc.some((d) => d.includes(mm))) desc.push(mm);
    } else if (md.model) desc.push(md.model);
    const kinds = md.kinds ? md.kinds.filter((k) => !(w.kind && (k === 'WLED' || k === 'Web page')) && k !== 'SSH') : [];
    if (kinds.length) desc.push(kinds.join(', '));
    if (maker && maker !== 'private address' && !desc.some((d) => d.toLowerCase().includes(maker.toLowerCase().split(/[ ,]/)[0]))) desc.push('Made by ' + maker);
    if (w.title && w.title !== name && desc.length < 2) desc.push('Web page: ' + w.title);
    else if (!w.title && w.server && desc.length < 2) desc.push('Web server: ' + w.server);
    if (maker === 'private address' && !desc.length) desc.push('Phone, tablet or computer (private Wi-Fi address)');
    const upd = updateWay({ w, md, hd, maker, isHa, ups: (hd && updByDev[hd.id]) || (isHa ? haSelfUpd : []) });
    const matter = !!(md.matter || md.thread || (hd && (hd.doms || []).some((x) => x === 'matter' || x === 'thread')));
    return {
      key: mac || ip, ip, mac, name, dns: dnsName, mdns: md.mdnsHost || '', area: (hd && hd.area) || '', maker,
      desc: desc.join(' · '), inHa: !!hd, fw: w.fw || '', version: w.version || '', web: answer[ip] === 'open',
      matter, thread: !!md.thread, update: upd, group: groupOf(w.fw, matter, upd, isHa),
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
      area: (hd && hd.area) || '', maker: '', inHa: !!hd, fw: '', version: (hd && hd.sw) || '', web: false, matter: true, thread: !n.ipv4,
      desc: [hd && [hd.maker, hd.model].filter(Boolean).join(' '), n.op ? '' : 'not set up yet' + (vp[0] ? ` (vendor ${vp[0]}, product ${vp[1] || '?'})` : ''),
        n.ipv4 ? 'Matter over Wi-Fi' : 'Matter over Thread'].filter(Boolean).join(' · '),
      update: hd ? updateWay({ w: {}, md: {}, hd, maker: '', ups: updByDev[hd.id] || [] }) : null, group: 'matter',
    });
  }
  // Home Assistant devices with no address here: Matter/Thread ones, and any with a firmware update entity
  for (const d of ha.devices) {
    if (used.has(d.id) || /service/i.test(d.type || '') || (d.doms || []).includes('hassio')) continue;
    const isMatter = (d.doms || []).some((x) => x === 'matter' || x === 'thread');
    const ups = (updByDev[d.id] || []).filter((u) => !/^update\.home_assistant_/.test(u.eid));
    if (!isMatter && !ups.length) continue;
    used.add(d.id);
    const via = isMatter ? 'Matter' : ({ zha: 'Zigbee', zwave_js: 'Z-Wave', hue: 'Hue bridge', deconz: 'Zigbee', mqtt: 'MQTT' })[(d.doms || [])[0]] || (d.doms || [])[0] || '';
    hosts.push({
      key: 'ha:' + d.id, ip: '', mac: '', dns: '', mdns: '', name: d.name || 'Home Assistant device', area: d.area || '', maker: '',
      inHa: true, fw: '', version: d.sw || '', web: false, matter: isMatter, thread: false,
      desc: [[d.maker, d.model].filter(Boolean).join(' '), via && 'via ' + via + ' (no address of its own)'].filter(Boolean).join(' · '),
      update: updateWay({ w: {}, md: {}, hd: d, maker: '', ups }), group: groupOf('', isMatter, ups.length ? { by: 'ha' } : null),
    });
  }
  return { at: Date.now(), took: Date.now() - t0, subnet: range.cidr, sources, hosts };
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
  for (const [re, how] of APP_WAY) if (re.test(mk)) return { by: 'app', how, installed: (hd && hd.sw) || '' };
  return null;
}
function groupOf(fw, matter, upd, isHa) {
  if (fw) return 'licketysplit';
  if (isHa) return 'updatable';
  if (matter) return 'matter';
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
    if (o.ip && !o.mac && res.hosts.some((h) => h.ip === o.ip && !h.mac)) continue;
    hosts.push(Object.assign({}, o, { online: false }));
  }
  hosts.sort((a, b) => (b.online - a.online) || ip2n(a.ip) - ip2n(b.ip));
  return { at: res.at, took: res.took, subnet: res.subnet, sources: res.sources, hosts };
}

module.exports = { scan, merge, parseCidr, localNets, _test: { unescapeAvahi, mdnsFacts, HA_TEMPLATE } };
