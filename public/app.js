'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S = null;            // last /api/state
const probes = {};       // device id -> probe result
const fwName = (id) => ((S && S.firmware.find((f) => f.id === id)) || {}).name || id;
function say(el, text, kind) { el.textContent = text || ''; el.className = 'msg' + (kind ? ' ' + kind : ''); }
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
const when = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

// ---------- USB: one row per firmware ----------
function renderCards() {
  const usbOk = 'serial' in navigator;
  $('usbNote').textContent = usbOk
    ? 'Plug the device into this computer with a USB cable, then press Install. A first install erases the device; for Matrixinator and WLED you can set Wi-Fi right after flashing.'
    : 'This browser can\u2019t flash over USB (that needs Chrome or Edge on a computer). Updating your devices over Wi-Fi above works anywhere.';
  $('cards').innerHTML = S.firmware.map((f) => {
    const c = f.current, st = f.status;
    const ver = c ? `${esc(c.version)} · built ${when(c.published)}` : 'No build downloaded yet';
    const err = st && !st.ok ? `<div class="err">${esc(st.error)}</div>` : '';
    const btn = c && c.files.factory && usbOk
      ? `<esp-web-install-button manifest="fw/${esc(f.id)}/manifest.json"><button slot="activate" class="pri">Install ${esc(c.version)}</button><span slot="unsupported"></span><span slot="not-allowed">Open this page over HTTPS to flash.</span></esp-web-install-button>`
      : '';
    return `<div class="row fw"><div><b>${esc(f.name)}</b><span class="sub">${esc(f.what)}</span>
      <div class="meta">${esc(f.board)} · ${esc(f.chip)} · ${ver}</div>${err}</div>${btn}</div>`;
  }).join('');
}

// ---------- your devices: one row each ----------
function renderDevs() {
  $('aFw').innerHTML = S.firmware.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('devs').innerHTML = S.devices.map((d) => {
    const f = S.firmware.find((x) => x.id === d.fw) || {}, cur = f.current, p = probes[d.id], run = S.ota[d.id];
    const running = !p ? '<span class="ver">checking…</span>' : p.online ? `<span class="ver">${esc(p.version || '?')}</span>` : '<span class="off">offline</span>';
    const isNew = p && p.online && cur && p.version && p.version !== cur.version && !String(p.version).startsWith(cur.version);
    const newest = cur ? `<span class="ver ${isNew ? 'new' : ''}">${esc(cur.version)}${isNew ? ' ↑' : ''}</span>` : '<span class="ver">—</span>';
    const busy = run && run.state === 'sending';
    const runLine = run ? `<div class="run ${esc(run.state)}"><b>${{ sending: 'Updating', done: 'Last update', error: 'Update failed' }[run.state] || 'Update'}</b> · ${esc(new Date(run.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))} · ${esc(run.msg)}</div>` : '';
    return `<div class="row dev" data-id="${esc(d.id)}">
      <div><b>${esc(d.name)}</b><small>${esc(d.host)}${p && p.detail ? ' · ' + esc(p.detail) : ''}</small></div>
      <div><small>${esc(f.name || d.fw)}</small>${running} → ${newest}</div>
      <div class="acts-r"><button type="button" class="small ${isNew ? 'pri' : ''}" data-act="ota" ${!cur || !p || !p.online || busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Update'}</button><button type="button" class="small" data-act="restart" title="Restart the device" ${!p || !p.online || busy ? 'disabled' : ''}>Restart</button><button type="button" class="small" data-act="del" title="Remove from this list" aria-label="Remove ${esc(d.name)}">✕</button></div>
      ${runLine}</div>`;
  }).join('') || '<div class="empty">No devices yet. Add one below.</div>';
}
async function probeAll() {
  await Promise.all(S.devices.map(async (d) => {
    try { probes[d.id] = await api('GET', `api/devices/${d.id}/probe`); } catch (e) { probes[d.id] = { online: false, detail: e.message }; }
    renderDevs();
  }));
}

async function load() {
  S = await api('GET', 'api/state');
  renderCards(); renderDevs();
  if (!S.owner) say($('msg'), 'Set the GitHub owner in ⚙ Settings so Lickety Split can find the builds.', 'err');
}

$('devs').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const id = b.closest('[data-id]').dataset.id, d = S.devices.find((x) => x.id === id);
  if (b.dataset.act === 'del') {
    if (!confirm(`Remove ${d.name} from the list? (Nothing on the device changes.)`)) return;
    await api('DELETE', `api/devices/${id}`).catch((e) => say($('msg'), e.message, 'err'));
    return load();
  }
  if (b.dataset.act === 'restart') {
    if (!confirm(`Restart ${d.name} (${d.host})? It's back in a few seconds.`)) return;
    b.disabled = true;
    try { await api('POST', `api/devices/${id}/restart`); say($('msg'), `${d.name} is restarting.`, 'ok'); }
    catch (e) { say($('msg'), `Couldn't restart ${d.name}: ${e.message}`, 'err'); }
    setTimeout(probeAll, 12000);
    return;
  }
  if (b.dataset.act === 'ota') {
    const f = S.firmware.find((x) => x.id === d.fw);
    if (!confirm(`Send ${f.name} ${f.current.version} to ${d.name} (${d.host})? It restarts when done; its settings are kept.`)) return;
    try { await api('POST', `api/devices/${id}/ota`); } catch (e) { say($('msg'), e.message, 'err'); }
    await load(); watchOta();
  }
});
let otaTimer = null;
function watchOta() {
  clearTimeout(otaTimer);
  otaTimer = setTimeout(async () => {
    const busy = Object.values(S.ota).some((r) => r.state === 'sending');
    const was = JSON.stringify(S.ota);
    await load();
    if (JSON.stringify(S.ota) !== was) setTimeout(probeAll, 15000);   // check the new version once it has restarted
    if (busy) watchOta();
  }, 2000);
}

$('addForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('POST', 'api/devices', { name: $('aName').value, host: $('aHost').value, fw: $('aFw').value });
    $('aName').value = ''; $('aHost').value = ''; say($('msg'), 'Device added.', 'ok');
    await load(); probeAll();
  } catch (e) { say($('msg'), e.message, 'err'); }
});

$('refresh').addEventListener('click', async () => {
  const b = $('refresh'); b.disabled = true; say($('msg'), 'Checking GitHub for new builds…');
  try {
    const j = await api('POST', 'api/refresh');
    const changed = Object.entries(j.results).filter(([, r]) => r.changed).map(([id, r]) => `${fwName(id)} ${r.tag}`);
    const failed = Object.values(j.results).filter((r) => !r.ok).length;
    say($('msg'), changed.length ? 'Downloaded: ' + changed.join(', ') + '.' : failed ? 'Some builds aren’t available yet (see the cards).' : 'Everything is up to date.', failed && !changed.length ? 'err' : 'ok');
    await load(); renderDevs();
  } catch (e) { say($('msg'), e.message, 'err'); }
  b.disabled = false;
});

// ---------- on the network: every device the hourly check found, in groups ----------
let NET = null;
const GROUPS = [
  { id: 'licketysplit', title: 'Updated by Lickety Split', note: 'Firmware this page builds and sends.' },
  { id: 'matter', title: 'Matter and Thread', note: 'Matter and Thread devices. Matter firmware usually updates through the app that set it up (Home Assistant, Alexa, Google Home, Apple Home).' },
  { id: 'home', title: 'Home automation', note: 'Plugs, switches, thermostats, cameras and other smart-home devices, by maker.' },
  { id: 'updatable', title: 'Updatable another way', note: 'ESPHome, Home Assistant update entities, and devices with their own web updater.' },
  { id: 'media', title: 'TVs, speakers and games', note: 'Echos, Fire TVs, the TV, consoles and other players. They update themselves. (Echos also run your Matter and Thread network.)' },
  { id: 'infra', title: 'Network, servers and printers', note: 'The eeros, the Proxmox hosts, Pi-hole, this server, the printer.' },
  { id: 'computers', title: 'Phones and computers', note: 'Laptops, phones and tablets (many hide their real address, so they look new each time).' },
  { id: 'other', title: 'Everything else', note: 'Phones, computers, plugs, speakers… with how they get updates, where that\u2019s known.' },
];
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago'; };
const nameOf = (h) => h.name || (h.brand ? h.brand.replace(/ \(.*\)$/, '') + ' device' : h.maker === 'private address' ? 'Phone or computer' : 'Unknown device');
function mineFor(h) {
  const hs = [h.ip, h.dns, h.mdns].filter(Boolean).map((x) => x.toLowerCase());
  return S.devices.find((d) => hs.includes(d.host.toLowerCase().replace(/:\d+$/, '')));
}
function netRow(h) {
  const badges = [];
  if (h.matter) badges.push(`<span class="badge matter">${h.thread ? 'Thread' : 'Matter'}</span>`);
  if (h.inHa) badges.push('<span class="badge">in HA</span>');
  if (h.away) badges.push('<span class="badge">not on the network now</span>');
  else if (!h.online) badges.push(`<span class="badge">offline · seen ${esc(ago(h.lastSeen))}</span>`);
  let upd = '', act = '';
  const u = h.update;
  if (h.group === 'licketysplit') {
    const f = S.firmware.find((x) => x.id === h.fw), cur = f && f.current, mine = mineFor(h);
    const isNew = cur && h.version && h.version !== cur.version && !String(h.version).startsWith(cur.version);
    upd = `<div class="upd"><b>Update:</b> ${esc(u ? u.how : 'Lickety Split')} · ${esc(f ? f.name : h.fw)} ${esc(h.version || '?')}${cur ? ` → ${esc(cur.version)}` : ''}</div>`;
    if (isNew) badges.push('<span class="badge new">update ready</span>');
    act = mine ? `<span class="badge ok">in your devices</span>` : h.ip ? `<button type="button" class="small" data-add="${esc(h.key)}">Add to your devices</button>` : '';
  } else if (u) {
    const v = u.installed || u.latest ? ` · ${esc(u.installed || '?')}${u.latest && u.latest !== u.installed ? ' → ' + esc(u.latest) : ''}` : '';
    if (u.available) badges.push('<span class="badge new">update available</span>');
    upd = `<div class="upd"><b>Update:</b> ${esc(u.how)}${v}</div>`;
  }
  const nm = (h.mac && NET.names && NET.names[h.mac]) || {};
  const names = [...new Set([...(h.dnsAll || [h.dns]), h.mdns])].filter((x) => x && x !== nm.dns);
  const skipped = h.mac && (NET.settings.piholeSkipped || []).includes(h.mac);
  const nb = (act, label, title) => `<button type="button" class="small link" data-name="${act}" data-mac="${esc(h.mac)}" data-host="${esc(nm.dns || nm.suggest || nameOf(h))}"${title ? ` title="${esc(title)}"` : ''}>${label}</button>`;
  const dnsLine = nm.dns ? `<div class="upd"><b>DNS name:</b> <span class="mono">${esc(nm.dns)}</span>${nm.ours ? ' ' + nb('rename', 'Rename') + nb('remove', 'Remove', 'Remove the name from Pi-hole and don\u2019t name this device again') : ''}</div>`
    : skipped ? `<div class="upd"><b>DNS name:</b> <span class="muted">none (you removed it)</span> ${nb('allow', 'Name it again')}</div>`
    : nm.suggest ? `<div class="upd"><b>Suggested name:</b> <span class="mono">${esc(nm.suggest)}</span> <span class="muted">(not in Pi-hole${NET.settings.piholeNames ? ' yet: added at the next check' : ''})</span></div>` : '';
  const q = h.queries ? `${h.queries.toLocaleString()} DNS queries${h.lastQuery ? ', last ' + ago(h.lastQuery) : ''}` : '';
  const addr = [h.ip || h.ipv6, ...names, h.mac, q].filter(Boolean).map(esc).join('<br>');
  return `<div class="row nd${h.online ? '' : ' gone'}"><div><b>${esc(nameOf(h))}</b>${badges.join('')}
    <small>${esc([h.area, h.desc].filter(Boolean).join(' · ') || 'Nothing announced')}</small>${upd}${dnsLine}</div>
    <div class="addr">${addr}${act ? '<div style="margin-top:6px">' + act + '</div>' : ''}</div></div>`;
}
// Pi-hole: how much each device asks, what gets blocked, and the names Lickety Split keeps in Pi-hole
function renderDns() {
  const r = NET.result, st = NET.settings, d = r && r.dnsStats;
  if (!d && !(st.piholeManaged || []).length) { $('dnsBox').innerHTML = ''; return; }
  const byIp = {};
  for (const h of (r && r.hosts) || []) if (h.ip) byIp[h.ip] = h;
  const who = (c) => { const h = byIp[c.ip]; return h ? nameOf(h) : c.name ? c.name.split('.')[0] : c.ip; };
  const n = (x) => Number(x || 0).toLocaleString();
  let html = '';
  if (d) {
    const k = (x) => { x = Number(x || 0); return x >= 1e6 ? (x / 1e6).toFixed(1) + 'M' : x >= 1e4 ? Math.round(x / 1e3) + 'k' : x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x); };
    const total = {};
    for (const c of d.topClients) total[c.ip] = c.count;
    const row = (c, blk) => {
      const pct = blk && total[c.ip] ? ` · ${Math.round(100 * c.count / total[c.ip])}%` : '';
      const doms = blk && c.domains && c.domains.length ? `<small>${c.domains.slice(0, 2).map((x) => esc(x.domain)).join(', ')}</small>` : '';
      return `<li><span title="${esc(c.ip)}">${esc(who(c))}</span><span class="c">${k(c.count)}${pct}</span>${doms}</li>`;
    };
    html += `<div class="dns"><h3>DNS · last 24 h</h3>
      <p class="note" style="margin:0 0 6px">${k(d.total)} queries · ${k(d.blocked)} blocked (${(+d.percent || 0).toFixed(1)}%) · ${n(d.clients)} devices</p>
      <div class="cols"><div><h4>Busiest</h4><ul class="tl">${d.topClients.slice(0, 5).map((c) => row(c, false)).join('')}</ul></div>
      <div><h4>Most blocked</h4><ul class="tl">${d.topBlocked.slice(0, 5).map((c) => row(c, true)).join('') || '<li>Nothing blocked.</li>'}</ul></div></div>
      ${d.topBlockedDomains.length ? `<p class="note" style="margin:6px 0 0"><b>Top blocked:</b> ${d.topBlockedDomains.slice(0, 5).map((x) => `${esc(x.domain)} (${k(x.count)})`).join(', ')}</p>` : ''}</div>`;
  }
  const m = st.piholeManaged || [], sync = r && r.piSync;
  if (st.piholeNames || m.length) {
    const line = (st.piholeNames ? `<b>Pi-hole names:</b> ${m.length} kept up to date (shown on each device)` : `<b>Pi-hole names:</b> naming is off, so the ${m.length} names are removed at the next check`)
      + (sync && (sync.added.length || sync.removed.length) ? ` · last change ${ago(sync.at)}: ${sync.added.length} added, ${sync.removed.length} removed` : '')
      + (sync && sync.error ? ` · <span class="off">${esc(sync.error)}</span>` : '');
    html = html ? html.replace(/<\/div>$/, `<p class="note" style="margin:6px 0 0">${line}</p></div>`) : `<p class="note">${line}</p>`;
  }
  $('dnsBox').innerHTML = html;
}
async function nameAction(ev) {
  const b = ev.target.closest('button[data-name]'); if (!b) return;
  const body = { action: b.dataset.name, mac: b.dataset.mac };
  if (body.action === 'rename') {
    const v = prompt('New name for this device in Pi-hole (the ending is added if you leave it off):', b.dataset.host); if (!v) return; body.host = v;
  } else if (body.action === 'remove' && !confirm(`Remove ${b.dataset.host} from Pi-hole? Lickety Split won't name this device again (until you press "Name it again").`)) return;
  b.disabled = true;
  try {
    const j = await api('POST', 'api/network/names', body);
    NET.settings = j.settings; NET.names = j.names; S.net = j.settings;
    if (j.sync && NET.result) NET.result.piSync = j.sync;
    renderNet(); if (j.sync && j.sync.error) say($('msg'), j.sync.error, 'err');
  } catch (e) { say($('msg'), e.message, 'err'); b.disabled = false; }
}
$('dnsBox').addEventListener('click', nameAction);

function renderPing() {
  const p = NET.ping;
  $('pingBox').hidden = !p;
  if (!p) return;
  const tm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const cells = p.hours.map((h, i) => {
    const cls = h.fail ? 'bad' : h.ok ? 'ok' : '';
    return `<i class="${cls}" title="${24 - i} h ago: ${h.ok} OK${h.fail ? ', ' + h.fail + ' failed' : ''}"></i>`;
  }).join('');
  const last = p.last ? ` · last ${ago(p.last.at)}${p.last.ok ? '' : ' <span class="off">failed (' + esc(p.last.status) + ')</span>'}` : '';
  $('pingSum').innerHTML = `<span>Health ping (${esc(p.host)}): ${p.ok.toLocaleString()} of ${(p.ok + p.fail).toLocaleString()} OK in the last 24 h${last}</span><span class="strip">${cells}</span><span>log ▾</span>`;
  // the log, short: failures on their own line; OKs grouped by 10 minutes for the last hour, then by the hour
  const hm = (t) => new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const lines = [];
  let grp = null;
  const flush = () => { if (grp) lines.push(`<div>${hm(grp.from)}\u2013${hm(grp.to)} · ${grp.n} OK</div>`); grp = null; };
  for (const x of p.log || []) {
    if (!x.ok) { flush(); lines.push(`<div class="bad">${tm(x.t)} failed: ${esc(x.s || '')}</div>`); continue; }
    const size = Date.now() - x.t < 3600000 ? 600000 : 3600000, slot = Math.floor(x.t / size) * size;
    if (!grp || grp.slot !== slot) { flush(); grp = { slot, from: slot, to: slot + size, n: 0 }; }
    grp.n++;
  }
  flush();
  $('pingLog').innerHTML = `<div class="log">${lines.reverse().join('') || 'No pings yet.'}</div>`;
}

function renderNet() {
  if (!NET) return;
  renderDns(); renderPing();
  const st = NET.settings, r = NET.result, q = $('netFilter').value.trim().toLowerCase();
  $('netCount').textContent = r ? String(r.hosts.filter((h) => h.online).length) : '';
  const src = r && r.sources ? Object.entries({ 'Home Assistant': r.sources.ha, 'Pi-hole': r.sources.pihole || 'not set up', mDNS: r.sources.mdns, DNS: r.sources.dns })
    .filter(([, v]) => v !== 'ok').map(([k, v]) => `${k}: ${v}`) : [];
  $('netNote').textContent = (NET.scanning ? 'Checking the network now… ' : '')
    + (r ? `${r.hosts.filter((h) => h.online).length} devices on ${r.subnet}, checked ${ago(r.at)}${st.enabled ? ' (every hour)' : ' (hourly check is off: turn it on in ⚙ Settings)'}.` : st.enabled ? 'The first check runs in a moment.' : 'Not checked yet. Press Check now, or turn on the hourly check in ⚙ Settings.')
    + (src.length ? ' ' + src.join(' · ') + '.' : '') + (NET.error ? ' Last check failed: ' + NET.error : '');
  $('netScan').disabled = !!NET.scanning;
  if (!r) { $('netList').innerHTML = ''; return; }
  const open = {};
  for (const d of $('netList').querySelectorAll('details[data-g]')) open[d.dataset.g] = d.open;
  $('netList').innerHTML = GROUPS.map((g) => {
    const all = r.hosts.filter((h) => h.group === g.id);
    const list = q ? all.filter((h) => [nameOf(h), h.desc, h.area, h.ip, h.ipv6, h.dns, h.mdns, h.mac, h.update && h.update.how, ((NET.names || {})[h.mac] || {}).suggest, ((NET.names || {})[h.mac] || {}).dns].join(' ').toLowerCase().includes(q)) : all;
    if (!all.length) return '';
    const isOpen = g.id in open ? open[g.id] : true;
    let rows;
    if (g.id === 'home') {             // by maker: all the TP-Link ones together, and so on
      const by = {};
      for (const h of list) (by[h.brand || 'Other makers'] = by[h.brand || 'Other makers'] || []).push(h);
      rows = Object.keys(by).sort((a, b) => (a === 'Other makers') - (b === 'Other makers') || by[b].length - by[a].length || a.localeCompare(b))
        .map((k) => `<div class="sub-h">${esc(k)} · ${by[k].length}</div>` + by[k].map(netRow).join('')).join('');
    } else rows = list.map(netRow).join('');
    return `<details class="grp" data-g="${g.id}" ${isOpen || q ? 'open' : ''}><summary>${esc(g.title)} <span class="n">${q ? list.length + ' of ' : ''}${all.length}</span></summary>
      <p class="note">${esc(g.note)}</p><div class="list">${rows || '<div class="empty">Nothing matches.</div>'}</div></details>`;
  }).join('');
}
async function loadNet() {
  try { NET = await api('GET', 'api/network'); renderNet(); } catch (e) { $('netNote').textContent = 'Couldn\u2019t load the network list: ' + e.message; }
  if (NET && NET.scanning) setTimeout(loadNet, 3000);
}
$('netFilter').addEventListener('input', renderNet);
$('netScan').addEventListener('click', async () => {
  $('netScan').disabled = true; NET = Object.assign({}, NET, { scanning: true }); renderNet();
  try { NET = await api('POST', 'api/network/scan'); } catch (e) { NET.scanning = false; NET.error = e.message; }
  renderNet();
});
$('netList').addEventListener('click', nameAction);
$('netList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-add]'); if (!b) return;
  const h = NET.result.hosts.find((x) => x.key === b.dataset.add); if (!h) return;
  b.disabled = true;
  try { await api('POST', 'api/devices', { name: nameOf(h), host: h.dns || h.ip, fw: h.fw }); say($('msg'), `${nameOf(h)} added to your devices.`, 'ok'); await load(); probeAll(); renderNet(); }
  catch (e) { say($('msg'), e.message, 'err'); b.disabled = false; }
});

// ---------- status: the Duck Hunting report ----------
// the sidekick: Lickety Split's duck superhero (Duck Hunting), flying while everything is working
const HERO = `<svg class="hero" viewBox="0 0 220 110" role="img" aria-label="Lickety Split's duck sidekick flying: everything is working">
  <defs><linearGradient id="dk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffe17a"/><stop offset="1" stop-color="#f2a900"/></linearGradient>
  <linearGradient id="dc" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4a3d"/><stop offset="1" stop-color="#b3121f"/></linearGradient></defs>
  <g class="streaks" stroke="#f2b33d" stroke-width="3" stroke-linecap="round">
    <line x1="14" y1="44" x2="42" y2="44"/><line x1="4" y1="60" x2="36" y2="60"/><line x1="18" y1="74" x2="46" y2="74"/><line x1="30" y1="32" x2="50" y2="32"/></g>
  <g class="flyer">
    <path class="cape" d="M146 44 C124 30 98 26 62 34 C74 42 70 50 58 56 C74 60 74 68 64 78 C94 72 122 64 146 54 Z" fill="url(#dc)" stroke="#7a0d16" stroke-width="1.3" stroke-linejoin="round"/>
    <path d="M92 74 l-10 6 l4 -9 M100 76 l-9 8 l3 -10" fill="#ff8a1f" stroke="#b85a00" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M86 52 L72 44 L78 58 Z" fill="url(#dk)" stroke="#a86f00" stroke-width="1.2" stroke-linejoin="round"/>
    <ellipse cx="116" cy="58" rx="34" ry="20" fill="url(#dk)" stroke="#a86f00" stroke-width="1.3"/>
    <path d="M122 50 L112 62 H119 L115 72 L128 58 H121 Z" fill="#ff4a3d" stroke="#7a0d16" stroke-width=".9" stroke-linejoin="round"/>
    <path class="wing" d="M104 50 C96 30 110 20 128 26 C122 34 120 42 116 52 Z" fill="#ffd34d" stroke="#a86f00" stroke-width="1.3" stroke-linejoin="round"/>
    <circle cx="156" cy="40" r="16" fill="url(#dk)" stroke="#a86f00" stroke-width="1.3"/>
    <path d="M152 24 C154 18 160 18 160 24 C163 20 167 22 165 27" fill="none" stroke="#a86f00" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M168 40 C176 36 188 37 194 41 C188 46 176 47 168 45 Z" fill="#ff8a1f" stroke="#b85a00" stroke-width="1.2" stroke-linejoin="round"/>
    <path d="M168 42.5 C176 42 186 42 192 41.5" stroke="#b85a00" stroke-width="1" fill="none"/>
    <path d="M142 33 C150 30 164 30 172 33 L171 40 C163 37 151 37 143 40 Z" fill="#d42a2a" stroke="#7a0d16" stroke-width="1"/>
    <ellipse cx="162" cy="35.5" rx="3.6" ry="3" fill="#fff"/><circle cx="163" cy="35.6" r="1.6" fill="#1b2836"/>
  </g>
  <g class="spark"><path d="M204 30 L207 37 L214 40 L207 43 L204 50 L201 43 L194 40 L201 37 Z" fill="#ffe17a" stroke="#f2a900" stroke-width="1"/></g>
</svg>`;
let ST = null;
function renderStatus() {
  if (!ST) return;
  const al = ST.alerts || [], nt = ST.notices || [], since = (t) => t ? new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  $('statusCount').textContent = al.length ? String(al.length) : '';
  $('statusCount').className = 'n' + (al.length ? ' off' : '');
  $('stNote').textContent = (ST.at ? `Checked ${ago(ST.at)} (every ${ST.every > 1 ? ST.every + ' minutes' : 'minute'}).` : 'The first check runs a minute after Lickety Split starts.')
    + (ST.settings.enabled ? ` Emails go to ${ST.settings.to || '(no address set)'}.` : ' Email is off: turn it on in ⚙ Settings.');
  const row = (a, cls) => `<div class="row ${cls}"><div><b>${esc(a.title)}</b><small>${esc([a.cat, a.detail, a.first && cls === 'al' ? 'since ' + since(a.first) : ''].filter(Boolean).join(' · '))}</small>${a.fix ? `<div class="upd"><b>How to fix:</b> ${esc(a.fix)}</div>` : ''}</div>${cls === 'al' ? `<div class="acts-r"><button type="button" class="small" data-ignore="${esc(a.id)}" title="Don\u2019t report this again (undo below)">Ignore</button></div>` : ''}</div>`;
  const byCat = {};
  for (const n of nt) (byCat[n.cat] = byCat[n.cat] || []).push(n);
  const checks = Object.entries(ST.checks || {}).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, c]) => `<div title="${esc(c.detail)}"><span class="dot${c.ok ? '' : ' bad'}"></span>${esc(k)} <small>${esc(c.detail)}</small></div>`).join('');
  $('stBody').innerHTML = `${al.length ? `<div class="big bad">${al.length} thing${al.length > 1 ? 's' : ''} need${al.length > 1 ? '' : 's'} attention</div>` : `<div class="allgood">${HERO}<div><div class="big good">All good</div><div class="note" style="margin:0">Everything is working. The duck is on patrol.</div></div></div>`}
    ${al.length ? `<div class="list st-sec">${al.map((a) => row(a, 'al')).join('')}</div>` : ''}
    ${(ST.pending || []).length ? `<p class="note">Watching: ${ST.pending.map((a) => esc(a.title)).join(', ')} (counts if it\u2019s still wrong at the next check)</p>` : ''}
    ${nt.length ? `<div class="st-sec"><h3>Updates to install</h3><div class="list">${Object.entries(byCat).map(([c, l]) => l.map((a) => row(a, 'nt')).join('')).join('')}</div></div>` : ''}
    <div class="st-sec"><h3>Checks</h3><div class="checks">${checks || '<span class="muted">No checks yet.</span>'}</div></div>
    ${(ST.history || []).length ? `<div class="st-sec"><h3>Fixed recently</h3><ul class="mails">${ST.history.slice(0, 8).map((h) => `<li>${esc(h.title)} <span class="muted">· ${since(h.from)} \u2013 ${since(h.to)}</span></li>`).join('')}</ul></div>` : ''}
    ${(ST.ignored || []).length ? `<div class="st-sec"><h3>Ignored</h3><ul class="mails">${ST.ignored.map((x) => `<li>${esc(x.title)} <button type="button" class="small link" data-unignore="${esc(x.id)}">Watch again</button></li>`).join('')}</ul></div>` : ''}
    <div class="st-sec"><h3>Emails</h3><ul class="mails">${(ST.emails || []).slice(0, 8).map((m) => `<li>${since(m.at)} · ${esc(m.subject)}${m.ok ? '' : ` <span class="off">failed: ${esc(m.error)}</span>`}</li>`).join('') || '<li class="muted">None sent yet.</li>'}</ul>
    <div class="acts-r" style="justify-content:flex-start;margin-top:8px"><button type="button" class="small" id="stTest">Send a test email</button><button type="button" class="small" id="stSend">Email this report now</button></div></div>`;
}
async function loadStatus() { loadSpeed(); return loadStatus2(); }
async function loadStatus2() { try { ST = await api('GET', 'api/status'); renderStatus(); } catch (e) { $('stNote').textContent = 'Couldn\u2019t load the status: ' + e.message; } }
$('stCheck').addEventListener('click', async () => { $('stCheck').disabled = true; try { ST = await api('POST', 'api/status/check'); renderStatus(); } catch (e) { say($('msg'), e.message, 'err'); } $('stCheck').disabled = false; });
$('stBody').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.ignore || b.dataset.unignore) {
    const id = b.dataset.ignore || b.dataset.unignore;
    if (b.dataset.ignore && !confirm('Ignore this from now on? It won\u2019t show here or in emails (you can undo it under Ignored).')) return;
    b.disabled = true;
    try { ST = await api('POST', 'api/status/ignore', { id, ignore: !!b.dataset.ignore }); renderStatus(); } catch (e) { say($('msg'), e.message, 'err'); b.disabled = false; }
    return;
  }
  if (!['stTest', 'stSend'].includes(b.id)) return;
  b.disabled = true;
  try { ST = await api('POST', b.id === 'stTest' ? 'api/status/test-email' : 'api/status/send-report'); renderStatus(); say($('msg'), 'Email sent.', 'ok'); }
  catch (e) { say($('msg'), 'Email failed: ' + e.message, 'err'); b.disabled = false; }
});
setInterval(() => { if (!document.hidden) loadStatus(); }, 60000);

// ---------- internet speed: history chart ----------
let SPEED = null, speedDays = 7;
const mbps = (v) => v >= 100 ? Math.round(v) : v.toFixed(1);
function renderSpeed() {
  const sp = SPEED; if (!sp) return;
  const on = sp.every > 0 || (sp.history && sp.history.length);
  $('speedBox').hidden = !on; if (!on) return;
  const h = sp.history || [], l = sp.last;
  $('speedNote').innerHTML = (l ? `<b>↓ ${mbps(l.down)} Mbps</b> · <b>↑ ${mbps(l.up)} Mbps</b> · ${l.ping} ms (±${l.jitter}) · ${ago(l.t)}` : 'No test yet.')
    + (sp.every ? ` · every ${sp.every >= 60 ? (sp.every / 60) + ' h' : sp.every + ' min'}` : ' · automatic tests are off (⚙ Settings → General)')
    + (sp.running ? ' · <b>testing now…</b>' : '') + (sp.error ? ` · <span class="off">last try failed: ${esc(sp.error.msg)}</span>` : '');
  $('speedRun').disabled = !!sp.running;
  for (const b of $('speedRange').querySelectorAll('button')) b.setAttribute('aria-pressed', String(+b.dataset.days === speedDays));
  if (h.length < 2) { $('speedChart').innerHTML = h.length ? '<p class="note">One test so far: the chart starts with the second.</p>' : ''; return; }
  const W = 640, H = 196, L = 44, R = 36, T = 24, B = 24, t0 = Date.now() - speedDays * 86400000, t1 = Date.now();
  const maxV = Math.max(10, ...h.map((r) => Math.max(r.down, r.up)));
  const step = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find((s2) => maxV / s2 <= 5) || 5000, top = Math.ceil(maxV / step) * step;
  const maxP = Math.max(20, ...h.map((r) => r.ping || 0)), topP = Math.ceil(maxP / 10) * 10;
  const x = (t) => L + (W - L - R) * (t - t0) / (t1 - t0), y = (v) => T + (H - T - B) * (1 - v / top), yp = (v) => T + (H - T - B) * (1 - v / topP);
  // Smoothed: a rolling average (wider for longer ranges; with 5+ tests the highest and lowest are left out, so one
  // odd test doesn't make a spike), drawn as a curve that never overshoots. Each test is still a faint dot.
  const win = Math.max(3, Math.round(h.length / 30) * 2 + 1);
  const smooth = (k) => h.map((r, i) => {
    const a = h.slice(Math.max(0, i - (win >> 1)), i + (win >> 1) + 1).map((q) => q[k] || 0).sort((p, q) => p - q);
    const v = a.length >= 5 ? a.slice(1, -1) : a;
    return { t: r.t, v: v.reduce((p, q) => p + q, 0) / v.length };
  });
  const line = (k, fy) => curve(smooth(k).map((p) => [x(p.t), fy(p.v)]), h.map((r) => r.t));
  let grid = '';
  for (let v = 0; v <= top; v += step) grid += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  for (let v = 0; v <= topP; v += topP / 2) grid += `<text x="${W - R + 6}" y="${yp(v) + 4}">${v}</text>`;
  const days = speedDays <= 1 ? 6 : speedDays, tickEvery = speedDays <= 1 ? 4 * 3600000 : Math.ceil(speedDays / 7) * 86400000;
  for (let t = Math.ceil(t0 / tickEvery) * tickEvery; t <= t1; t += tickEvery) {
    const d = new Date(t), lab = speedDays <= 1 ? d.toLocaleTimeString(undefined, { hour: 'numeric' }) : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
    grid += `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/><text x="${x(t)}" y="${H - 6}" text-anchor="middle">${esc(lab)}</text>`;
  }
  const tip = (r) => `<title>${new Date(r.t).toLocaleString()}: ↓ ${mbps(r.down)} ↑ ${mbps(r.up)} Mbps, ${r.ping} ms</title>`;
  const dots = h.map((r) => `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.up).toFixed(1)}" r="2" fill="var(--ok)" opacity=".35">${tip(r)}</circle>`
    + `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.down).toFixed(1)}" r="2.2" fill="var(--accent)" opacity=".45">${tip(r)}</circle>`).join('');
  $('speedChart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Internet speed over time">${grid}
    <text x="${L - 6}" y="10" text-anchor="end">Mbps</text><text x="${W - R + 6}" y="10">ms</text>
    <path class="ping" d="${line('ping', yp)}"/><path class="up" d="${line('up', y)}"/><path class="down" d="${line('down', y)}"/>${dots}</svg>
    <div class="legend"><span><i style="background:var(--accent)"></i>download</span><span><i style="background:var(--ok)"></i>upload</span><span><i style="background:var(--muted);height:2px"></i>ping (right scale)</span><span>${h.length} tests (lines are averaged, dots are single tests) · typical ↓ ${mbps(median(h.map((r) => r.down)))} ↑ ${mbps(median(h.map((r) => r.up)))}</span></div>`;
}
// A smooth path through points (monotone cubic: no bumps past the data); a break where tests stopped for over 6 hours.
function curve(pts, ts) {
  let d = '';
  for (let s0 = 0; s0 < pts.length;) {
    let e = s0 + 1; while (e < pts.length && ts[e] - ts[e - 1] <= 6 * 3600000) e++;
    const P = pts.slice(s0, e), n = P.length;
    d += `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
    if (n > 1) {
      const dx = [], m = [], tg = [];
      for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0] || 1e-6; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
      tg[0] = m[0]; tg[n - 1] = m[n - 2];
      for (let i = 1; i < n - 1; i++) tg[i] = m[i - 1] * m[i] <= 0 ? 0 : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
      for (let i = 0; i < n - 1; i++) {
        const h3 = dx[i] / 3;
        d += `C${(P[i][0] + h3).toFixed(1)},${(P[i][1] + tg[i] * h3).toFixed(1)} ${(P[i + 1][0] - h3).toFixed(1)},${(P[i + 1][1] - tg[i + 1] * h3).toFixed(1)} ${P[i + 1][0].toFixed(1)},${P[i + 1][1].toFixed(1)}`;
      }
    }
    s0 = e;
  }
  return d;
}
function median(a) { const s2 = [...a].sort((p, q) => p - q); return s2.length ? s2[Math.floor(s2.length / 2)] : 0; }
async function loadSpeed() { try { SPEED = await api('GET', 'api/speed?days=' + speedDays); renderSpeed(); } catch (e) { /* shown next time */ } if (SPEED && SPEED.running) setTimeout(loadSpeed, 5000); }
$('speedRange').addEventListener('click', (ev) => { const b = ev.target.closest('button[data-days]'); if (!b) return; speedDays = +b.dataset.days; loadSpeed(); });
$('speedRun').addEventListener('click', async () => {
  $('speedRun').disabled = true; SPEED = Object.assign({}, SPEED, { running: true }); renderSpeed();
  try { await api('POST', 'api/speed/run'); } catch (e) { say($('msg'), 'Speed test failed: ' + e.message, 'err'); }
  loadSpeed();
});

// ---------- tabs (remembered per browser) ----------
function showTab(t) {
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t;
  try { localStorage.setItem('ls-tab', t); } catch (e) { /* private mode */ }
}
document.querySelector('.tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
try { const t = location.hash === '#network' ? 'net' : location.hash === '#firmware' ? 'fw' : location.hash === '#status' ? 'status' : localStorage.getItem('ls-tab'); if (t === 'net' || t === 'fw') showTab(t); else showTab('status'); } catch (e) { showTab('status'); }

// ---------- reload (the home-screen app has no browser reload button) ----------
$('reloadBtn').addEventListener('click', () => { $('reloadBtn').disabled = true; location.reload(); });

// ---------- settings ----------
$('setBtn').addEventListener('click', () => {
  $('sOwner').value = S.owner || '';
  $('sRepos').textContent = 'Builds come from the GitHub Releases of: ' + [...new Set(S.firmware.map((f) => (f.repo || '<owner>/' + (f.id.startsWith('wled') ? 'licketysplit' : f.id === 'airplay' ? 'airplay-esp32' : f.id))))].join(', ') + '.';
  $('sToken').textContent = S.tokenSet ? 'A GitHub token is set (private repos work).' : 'No GitHub token set: the repos must be public (or set GITHUB_TOKEN in /etc/licketysplit.env).';
  const n = S.net || {};
  $('nOn').checked = !!n.enabled; $('nSubnet').value = n.subnet || ''; $('nSubnet').placeholder = n.autoSubnet || '192.168.1.0/24';
  $('nDns').value = n.dns || ''; $('nHaUrl').value = n.haUrl || ''; $('nHaToken').value = '';
  $('nHaToken').placeholder = n.haTokenSet ? 'Set (leave blank to keep it)' : 'Paste a token';
  $('nPiUrl').value = n.piholeUrl || ''; $('nPiPw').value = ''; $('nPiNames').checked = !!n.piholeNames; $('nPiSuffix').value = n.piholeSuffix || 'lan';
  $('nPiPw').placeholder = n.piholePasswordSet ? 'Set (leave blank to keep it)' : 'Pi-hole\u2019s password';
  $('nHaNote').textContent = n.haTokenSet ? 'A Home Assistant token is set. It stays on this server and is never shown again.' : 'Without a token the list still works, but has no Home Assistant names, rooms or update versions.';
  const mo = S.monitor || {};
  if (!$('mHour').options.length) $('mHour').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' })}</option>`).join('');
  $('mOn').checked = !!mo.enabled; $('mEvery').value = String(mo.every || 5); $('mTo').value = mo.to || ''; $('mFrom').value = mo.from || ''; $('mPw').value = '';
  $('mPw').placeholder = mo.passwordSet ? 'Set (leave blank to keep it)' : '16 letters from Google';
  $('mNew').checked = mo.notifyNew !== false; $('mClear').checked = mo.notifyClear !== false;
  $('mDay').value = String(mo.weeklyDay ?? 1); $('mHour').value = String(mo.weeklyHour ?? 8);
  $('mDoor').value = mo.doorMin ?? 15; $('mGarage').value = mo.garageMin ?? 30; $('mDisk').value = mo.diskGb ?? 1;
  const dk = mo.ducks || {}, per = (ST && ST.perDuck) || {};
  for (const c of document.querySelectorAll('[data-duck]')) c.checked = dk[c.dataset.duck] !== false;
  for (const e of document.querySelectorAll('[data-dstat]')) {
    const k = e.dataset.dstat, on = dk[k] !== false, n = per[k] || 0;
    e.textContent = !on ? 'off' : n ? (k === 'updates' ? `${n} to install` : `${n} now`) : 'OK';
    e.className = !on ? 'off' : n ? 'bad' : '';
  }
  $('duckDevs').textContent = S.devices.length ? 'Answering: ' + S.devices.map((d) => d.name).join(', ') : 'The Firmware tab\u2019s devices answer (none added yet)';
  showSTab('gen');
  $('mWatch').value = (mo.watch || []).map((w) => `${w.name} = ${w.url}`).join('\n');
  $('vUrl').value = mo.pveUrl || ''; $('vToken').value = mo.pveToken || ''; $('vSecret').value = '';
  $('vSecret').placeholder = mo.pveSecretSet ? 'Set (leave blank to keep it)' : 'the secret Proxmox showed once';
  const spc = S.speed || {}; $('spEvery').value = String(spc.every ?? 60); $('spDown').value = spc.minDown || 0; $('spUp').value = spc.minUp || 0;
  $('mServices').value = (mo.services || []).join('\n'); $('mRingBatt').value = mo.ringBattery ?? 20; $('mToner').value = mo.tonerPct ?? 10; $('mPrinter').value = mo.printerUrl || '';
  const pg = S.ping || {};
  $('pUrl').value = ''; $('pUrl').placeholder = pg.set ? `Set: ${pg.host} (leave blank to keep it)` : 'https://hc-ping.com/your-check-id';
  $('pEvery').value = String(pg.every || 60); $('pClear').checked = false; $('pClear').closest('label').hidden = !pg.set;
  $('pNote').textContent = !pg.set ? 'Lickety Split calls this address on a schedule, so a monitor can tell you if this server stops.'
    : pg.last ? `Last ping ${ago(pg.last.at)}: ${pg.last.ok ? 'OK' : 'failed'} (${pg.last.status}).` : 'No ping sent yet.';
  say($('sMsg'), ''); $('setDlg').showModal();
});
// settings tabs
function showSTab(t) {
  for (const b of document.querySelectorAll('[data-stab]')) b.setAttribute('aria-selected', String(b.dataset.stab === t));
  for (const p of document.querySelectorAll('[data-spane]')) p.hidden = p.dataset.spane !== t;
}
document.querySelector('.stabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-stab]'); if (b) showSTab(b.dataset.stab); });
$('sCancel').addEventListener('click', () => $('setDlg').close());
// Restart: the server exits, systemd starts it again; wait until it answers, then reload the page
$('sRestart').addEventListener('click', async () => {
  if (!confirm('Restart Lickety Split? It is back in a few seconds. Don\'t do this while an update is being sent to a device.')) return;
  const b = $('sRestart'); b.disabled = true; say($('sMsg'), 'Restarting Lickety Split…');
  try { await api('POST', 'api/restart', {}); } catch (e) { b.disabled = false; say($('sMsg'), e.message, 'err'); return; }
  await new Promise((r) => setTimeout(r, 2500));
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch('health', { cache: 'no-store' }); if (r.ok) { location.reload(); return; } } catch (e) { /* still starting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  b.disabled = false; say($('sMsg'), 'Lickety Split hasn\'t come back. Check: journalctl -u licketysplit', 'err');
});
$('setForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('PUT', 'api/settings', { owner: $('sOwner').value, net: { enabled: $('nOn').checked, subnet: $('nSubnet').value, dns: $('nDns').value, haUrl: $('nHaUrl').value, haToken: $('nHaToken').value, piholeUrl: $('nPiUrl').value, piholePassword: $('nPiPw').value, piholeNames: $('nPiNames').checked, piholeSuffix: $('nPiSuffix').value || 'lan' },
      ping: { url: $('pUrl').value, every: +$('pEvery').value, clear: $('pClear').checked },
      speed: { every: +$('spEvery').value, minDown: +$('spDown').value, minUp: +$('spUp').value },
      monitor: { enabled: $('mOn').checked, every: +$('mEvery').value, to: $('mTo').value, from: $('mFrom').value, password: $('mPw').value, notifyNew: $('mNew').checked, notifyClear: $('mClear').checked,
        weeklyDay: +$('mDay').value, weeklyHour: +$('mHour').value, doorMin: +$('mDoor').value, garageMin: +$('mGarage').value,  diskGb: +$('mDisk').value, watch: $('mWatch').value,
        pveUrl: $('vUrl').value, pveToken: $('vToken').value, pveSecret: $('vSecret').value, services: $('mServices').value,
        ringBattery: +$('mRingBatt').value, tonerPct: +$('mToner').value, printerUrl: $('mPrinter').value,
        ducks: Object.fromEntries([...document.querySelectorAll('[data-duck]')].map((c) => [c.dataset.duck, c.checked])) } });
    $('setDlg').close(); say($('msg'), 'Saved.', 'ok'); await load(); loadNet(); loadStatus();
  }
  catch (e) { say($('sMsg'), e.message, 'err'); }
});

load().then(() => { probeAll(); loadNet(); loadStatus(); if (Object.values(S.ota).some((r) => r.state === 'sending')) watchOta(); })
  .catch((e) => say($('msg'), 'Couldn’t load: ' + e.message, 'err'));
// keep the ping line and the list fresh while the page is open
setInterval(() => { if (!document.hidden && NET && !NET.scanning) loadNet(); }, 60000);
