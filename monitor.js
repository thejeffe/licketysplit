'use strict';
// Duck Hunting: home checks every minute, a report on the page, and email when something goes wrong.
//  - Home Assistant (one template call): reachable, doors and garage open too long (windows are fine open), broken automations (switched off is fine),
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

const FAST = process.env.LS_MONITOR_FAST === '1';   // tests only: no waiting
const GRACE = FAST ? 0 : 3 * 60000;           // an alert must last this long before it counts
const EMAIL_GAP = FAST ? 0 : 10 * 60000;      // at most one "something's wrong" email per this long (new problems wait and batch)
const CLEAR_AFTER = FAST ? 0 : 5 * 60000;     // all clear once everything has been fine this long
const PIHOLE_EVERY = 5 * 60000;

const DEFAULTS = {
  enabled: false,
  to: '',                // where the email goes (comma-separated)
  from: '',              // the Gmail address that sends it
  password: '',          // its app password (never sent back to the page)
  smtpHost: 'smtp.gmail.com', smtpPort: 465,
  doorMin: 15, garageMin: 30, battery: 15, diskGb: 1,
  weeklyDay: 1, weeklyHour: 8,  // Monday 8:00 (local time); weeklyDay -1 = no weekly summary
  notifyNew: true, notifyClear: true,
  watch: [],             // [{ name, url }] extra web addresses that should answer
};

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
function buildMessage({ from, to, subject, text, html }) {
  const b = 'ls-' + crypto.randomBytes(8).toString('hex');
  return [
    `From: Lickety Split <${from}>`, `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@licketysplit>`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${b}"`, '',
    `--${b}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text),
    `--${b}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(html),
    `--${b}--`, '',
  ].join('\r\n');
}

// ---------- the checks ----------
const HA_TEMPLATE = `{%- set ns = namespace(doors=[], garage=[], autos=[], batt=[], upd=[], dead=[], seen=[]) -%}
{%- for s in states.binary_sensor -%}{%- set dc = s.attributes.get('device_class') -%}
{%- if dc in ['door', 'garage_door'] and s.state == 'on' -%}
{%- set ns.doors = ns.doors + [{'id': s.entity_id, 'name': s.name, 'cls': dc, 'since': as_timestamp(s.last_changed, 0)}] -%}{%- endif -%}
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
{{ {'doors': ns.doors, 'garage': ns.garage, 'autos': ns.autos, 'batt': ns.batt, 'upd': ns.upd, 'dead': ns.dead} | to_json }}`;

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

  async function gather() {
    const c = cfg(), net = deps.net(), now = Date.now(), found = [];
    const add = (id, sev, cat, title, detail, since, grace) => found.push({ id, sev, cat, title, detail: detail || '', since: since || 0, grace: grace == null ? GRACE : grace });

    // Home Assistant
    if (net.haUrl && net.haToken) {
      try {
        const h = await haCheck(net.haUrl, net.haToken);
        check('Home Assistant', true, `${h.doors.length} open · ${h.autos.length} automations broken · ${h.upd.length} updates`);
        for (const d of h.doors) {
          const since = d.since * 1000, lim = (d.cls === 'garage_door' ? c.garageMin : c.doorMin) * 60000;
          if (now - since >= lim) add('door:' + d.id, 'alert', 'Doors', `${d.name} open for ${mins(now - since)}`, d.cls.replace('_', ' '), since, 0);
        }
        for (const g of h.garage) {
          const since = g.since * 1000;
          if (now - since >= c.garageMin * 60000) add('garage:' + g.id, 'alert', 'Doors', `${g.name} open for ${mins(now - since)}`, 'garage', since, 0);
        }
        for (const a of h.autos) {
          add('auto:' + a.id, 'alert', 'Automations', `Automation broken: ${a.name}`, 'unavailable (check its configuration or Settings → Repairs)', a.since * 1000);
        }
        for (const d of h.dead) add('dead:' + d.id, 'notice', 'Devices', `${d.name} unavailable`, [d.area, 'all its entities unavailable'].filter(Boolean).join(' · '), d.since * 1000, 0);
        for (const b of h.batt) if (b.v < 0 || b.v <= c.battery) add('batt:' + b.id, 'notice', 'Batteries', `${b.name}: ${b.v < 0 ? 'low' : Math.round(b.v) + '%'}`, '', 0, 0);
        for (const u of h.upd) add('upd:' + u.id, 'notice', 'Updates', `Update: ${u.name}`, [u.inst, u.latest].filter(Boolean).join(' → '), 0, 0);
      } catch (e) {
        check('Home Assistant', false, e.message);
        add('ha', 'alert', 'Home Assistant', 'Home Assistant isn’t answering', e.name === 'TimeoutError' ? 'no answer' : e.message);
      }
    }

    // Pi-hole (every 5 minutes)
    if (net.piholeUrl && net.piholePassword && now - pihole.at >= PIHOLE_EVERY - 5000) {
      try { pihole = { at: now, res: await piholeCheck(net.piholeUrl, net.piholePassword), err: null }; }
      catch (e) { pihole = { at: now, res: pihole.res && Object.assign({}, pihole.res, { dnsOk: pihole.res.dnsOk }), err: e.message }; }
    }
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

    // your devices + watched web addresses (down = 3 misses in a row)
    const targets = deps.devices().map((d) => ({ key: 'dev:' + d.id, name: d.name, run: () => deps.probe(d).then((p) => { if (!p.online) throw new Error(p.detail || 'no answer'); }) }))
      .concat((c.watch || []).map((w) => ({ key: 'web:' + w.url, name: w.name, run: () => webCheck(w.url) })));
    await Promise.all(targets.map(async (t) => {
      try { await t.run(); fails[t.key] = 0; check(t.name, true, ''); }
      catch (e) {
        fails[t.key] = (fails[t.key] || 0) + 1;
        check(t.name, false, e.message);
        if (fails[t.key] >= 3) add(t.key, 'alert', 'Devices', `${t.name} isn’t answering`, e.name === 'TimeoutError' ? 'no answer' : e.message);
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
    const now = Date.now(), seen = new Set();
    for (const f of found) {
      seen.add(f.id);
      const a = st.active[f.id];
      st.active[f.id] = Object.assign({}, f, { first: a ? a.first : now, mailed: a ? a.mailed : false });
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
    return { at: st.at || 0, enabled: cfg().enabled, alerts: al.sort((a, b) => a.first - b.first), pending, notices: notices().sort((a, b) => a.cat.localeCompare(b.cat) || a.title.localeCompare(b.title)),
      checks: st.checks, history: st.history.slice(0, 20), emails: st.emails.slice(0, 15) };
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  function emailBody(kind, extra) {
    const r = report(), when = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const sec = (title, items, fmt) => items.length ? { title, items: items.map(fmt) } : null;
    const parts = [
      kind === 'clear' ? { title: 'All clear', items: ['Everything is working again.'] } : null,
      sec('What’s wrong', r.alerts, (a) => `${a.title}${a.detail ? ' — ' + a.detail : ''} (since ${when(a.first)})`),
      sec('Also worth knowing', r.notices, (a) => `${a.title}${a.detail ? ' — ' + a.detail : ''}`),
      kind !== 'alert' ? sec('Fixed recently', r.history.filter((h) => now() - h.to < 7 * 86400000).slice(0, 15), (h) => `${h.title} (${when(h.from)} – ${when(h.to)})`) : null,
      ...(extra || []),
    ].filter(Boolean);
    function now() { return Date.now(); }
    const text = parts.map((p) => `${p.title.toUpperCase()}\n${p.items.map((i) => '  - ' + i).join('\n')}`).join('\n\n') + '\n\n— Lickety Split (Duck Hunting)\n';
    const html = `<div style="font:15px/1.45 -apple-system,Segoe UI,Arial,sans-serif;color:#1B2836;max-width:640px">`
      + parts.map((p) => `<h3 style="margin:18px 0 6px;font-size:16px;color:${p.title === 'What’s wrong' ? '#C23B3B' : p.title === 'All clear' ? '#2E8B57' : '#1B2836'}">${esc(p.title)}</h3><ul style="margin:0;padding-left:20px">${p.items.map((i) => `<li style="margin:3px 0">${esc(i)}</li>`).join('')}</ul>`).join('')
      + `<p style="color:#5B6B7B;font-size:12px;margin-top:22px">— Lickety Split (Duck Hunting)</p></div>`;
    return { text, html };
  }
  async function sendEmail(kind, subject, extra) {
    const c = cfg();
    if (!c.to || !c.from || !c.password) throw new Error('Set the email address, the Gmail address and its app password first.');
    const { text, html } = emailBody(kind, extra);
    await smtpSend({ host: process.env.LS_SMTP_HOST || c.smtpHost, port: +process.env.LS_SMTP_PORT || c.smtpPort, insecure: process.env.LS_SMTP_INSECURE === '1', user: c.from, pass: c.password, from: c.from, to: c.to,
      message: buildMessage({ from: c.from, to: c.to, subject, text, html }) });
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

  async function tick() {
    if (running) return;
    running = true;
    try {
      const found = await gather();
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

  return {
    tick, report,
    sendTest: () => sendEmail('test', `${duck} Duck Hunting: test email`, [{ title: 'Test', items: ['If you can read this, Lickety Split can email you.'] }]),
    sendReport: () => { const al = confirmed(); return sendEmail('report', al.length ? alertSubject(al) : `${duck} Duck Hunting report: all good`, weeklyExtra()); },
    DEFAULTS,
  };
}

module.exports = { createMonitor, DEFAULTS, _test: { buildMessage, smtpSend, HA_TEMPLATE } };
