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
  { id: 'matter', title: 'Matter and Thread', note: 'Matter devices, Thread border routers and Matter controllers. Matter firmware usually updates through the app that set it up (Home Assistant, Alexa, Google Home, Apple Home).' },
  { id: 'home', title: 'Home automation', note: 'Plugs, switches, thermostats, cameras and other smart-home devices, by maker.' },
  { id: 'updatable', title: 'Updatable another way', note: 'ESPHome, Home Assistant update entities, and devices with their own web updater.' },
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
  const names = [...new Set([...(h.dnsAll || [h.dns]), h.mdns])].filter(Boolean);
  const piName = h.mac && ((NET.settings.piholeManaged || []).find((e) => e.mac === h.mac) || {}).host;
  if (piName && !names.includes(piName)) names.unshift(piName);
  const q = h.queries ? `${h.queries.toLocaleString()} DNS queries${h.lastQuery ? ', last ' + ago(h.lastQuery) : ''}` : '';
  const addr = [h.ip || h.ipv6, ...names, h.mac, q].filter(Boolean).map(esc).join('<br>');
  return `<div class="row nd${h.online ? '' : ' gone'}"><div><b>${esc(nameOf(h))}</b>${badges.join('')}
    <small>${esc([h.area, h.desc].filter(Boolean).join(' · ') || 'Nothing announced')}</small>${upd}</div>
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
    const maxC = Math.max(1, ...d.topClients.map((c) => c.count)), maxB = Math.max(1, ...d.topBlocked.map((c) => c.count));
    const li = (c, max, blk) => {
      const h = byIp[c.ip], tot = blk ? (d.topClients.find((x) => x.ip === c.ip) || {}).count : 0;
      const doms = blk && c.domains && c.domains.length ? `<small>${c.domains.map((x) => esc(x.domain) + ' ×' + n(x.count)).join(' · ')}</small>` : '';
      return `<li><span title="${esc(c.ip)}">${esc(who(c))}</span><span class="c">${n(c.count)}${tot ? ' · ' + Math.round(100 * c.count / tot) + '%' : ''}</span>
        <div class="bar${blk ? ' blk' : ''}" style="width:${Math.max(2, Math.round(100 * c.count / max))}%"></div>${doms}</li>`;
    };
    html += `<div class="dns"><h3>DNS (Pi-hole, last 24 hours)</h3>
      <div class="kpis"><div class="kpi"><b>${n(d.total)}</b><span>queries</span></div><div class="kpi"><b>${n(d.blocked)}</b><span>blocked (${(+d.percent || 0).toFixed(1)}%)</span></div>
      <div class="kpi"><b>${n(d.clients)}</b><span>devices asking</span></div><div class="kpi"><b>${n(d.uniqueDomains)}</b><span>different names</span></div>
      <div class="kpi"><b>${n(d.listed)}</b><span>on the block lists</span></div></div>
      <div class="cols"><div><h4>Most queries</h4><ul class="top">${d.topClients.map((c) => li(c, maxC, false)).join('')}</ul></div>
      <div><h4>Most blocked (and what they ask for)</h4><ul class="top">${d.topBlocked.map((c) => li(c, maxB, true)).join('') || '<li>Nothing blocked.</li>'}</ul></div>
      <div><h4>Most blocked names</h4><ul class="top">${d.topBlockedDomains.map((x) => `<li><span>${esc(x.domain)}</span><span class="c">${n(x.count)}</span></li>`).join('')}</ul>
      <h4 style="margin-top:10px">Most asked-for names</h4><ul class="top">${d.topDomains.map((x) => `<li><span>${esc(x.domain)}</span><span class="c">${n(x.count)}</span></li>`).join('')}</ul></div></div></div>`;
  }
  const m = st.piholeManaged || [], sk = st.piholeSkipped || [];
  if (st.piholeNames || m.length || sk.length) {
    const sync = r && r.piSync;
    const dev = (mac) => ((r && r.hosts) || []).find((h) => h.mac === mac);
    html += `<details class="dns" ${m.length < 12 ? 'open' : ''}><summary><h3 style="display:inline">Names in Pi-hole</h3> <span class="c">${m.length}</span></summary>
      <p class="note">${st.piholeNames ? 'Kept up to date after every check.' : 'Naming is off in ⚙ Settings: these names are removed at the next check.'}${sync ? ` Last change ${ago(sync.at)}: ${sync.added.length} added, ${sync.removed.length} removed.` : ''}${sync && sync.error ? ' ' + esc(sync.error) : ''}</p>
      <ul class="top names">${m.map((e) => { const h = dev(e.mac); return `<li><span><b>${esc(e.host)}</b> → ${esc(e.ip)}<small>${esc(h ? nameOf(h) : e.device || '')} · ${esc(e.mac)}${h && !h.online ? ' · away' : ''}</small></span>
        <button type="button" class="small" data-name="rename" data-mac="${esc(e.mac)}" data-host="${esc(e.host)}">Rename</button><button type="button" class="small" data-name="remove" data-mac="${esc(e.mac)}" title="Remove this name and don't name the device again">Remove</button></li>`; }).join('') || '<li>No names yet: they\u2019re made at the next check.</li>'}</ul>
      ${sk.length ? `<h4 style="margin-top:8px">Not named (removed by you)</h4><ul class="top names">${sk.map((mac) => { const h = dev(mac); return `<li><span>${esc(h ? nameOf(h) : mac)}<small>${esc(mac)}</small></span><span></span><button type="button" class="small" data-name="allow" data-mac="${esc(mac)}">Name it again</button></li>`; }).join('')}</ul>` : ''}</details>`;
  }
  $('dnsBox').innerHTML = html;
}
$('dnsBox').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-name]'); if (!b) return;
  const body = { action: b.dataset.name, mac: b.dataset.mac };
  if (body.action === 'rename') {
    const v = prompt('New name for this device in Pi-hole:', b.dataset.host); if (!v) return; body.host = v;
  } else if (body.action === 'remove' && !confirm(`Remove ${b.closest('li').querySelector('b').textContent} from Pi-hole? Lickety Split won't name this device again (unless you choose "Name it again").`)) return;
  b.disabled = true;
  try { const j = await api('POST', 'api/network/names', body); NET.settings = j.settings; if (j.sync && NET.result) NET.result.piSync = j.sync; S.net = j.settings; renderDns(); if (j.sync && j.sync.error) say($('msg'), j.sync.error, 'err'); }
  catch (e) { say($('msg'), e.message, 'err'); b.disabled = false; }
});

function renderNet() {
  if (!NET) return;
  renderDns();
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
    const list = q ? all.filter((h) => [nameOf(h), h.desc, h.area, h.ip, h.ipv6, h.dns, h.mdns, h.mac, h.update && h.update.how].join(' ').toLowerCase().includes(q)) : all;
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
$('netList').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-add]'); if (!b) return;
  const h = NET.result.hosts.find((x) => x.key === b.dataset.add); if (!h) return;
  b.disabled = true;
  try { await api('POST', 'api/devices', { name: nameOf(h), host: h.dns || h.ip, fw: h.fw }); say($('msg'), `${nameOf(h)} added to your devices.`, 'ok'); await load(); probeAll(); renderNet(); }
  catch (e) { say($('msg'), e.message, 'err'); b.disabled = false; }
});

// ---------- tabs (remembered per browser) ----------
function showTab(t) {
  for (const b of document.querySelectorAll('.tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
  for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== t;
  try { localStorage.setItem('ls-tab', t); } catch (e) { /* private mode */ }
}
document.querySelector('.tabs').addEventListener('click', (ev) => { const b = ev.target.closest('[data-tab]'); if (b) showTab(b.dataset.tab); });
try { const t = location.hash === '#network' ? 'net' : location.hash === '#firmware' ? 'fw' : localStorage.getItem('ls-tab'); if (t === 'net') showTab('net'); } catch (e) { /* private mode */ }

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
  say($('sMsg'), ''); $('setDlg').showModal();
});
$('sCancel').addEventListener('click', () => $('setDlg').close());
$('setForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try {
    await api('PUT', 'api/settings', { owner: $('sOwner').value, net: { enabled: $('nOn').checked, subnet: $('nSubnet').value, dns: $('nDns').value, haUrl: $('nHaUrl').value, haToken: $('nHaToken').value, piholeUrl: $('nPiUrl').value, piholePassword: $('nPiPw').value, piholeNames: $('nPiNames').checked, piholeSuffix: $('nPiSuffix').value || 'lan' } });
    $('setDlg').close(); say($('msg'), 'Saved.', 'ok'); await load(); loadNet();
  }
  catch (e) { say($('sMsg'), e.message, 'err'); }
});

load().then(() => { probeAll(); loadNet(); if (Object.values(S.ota).some((r) => r.state === 'sending')) watchOta(); })
  .catch((e) => say($('msg'), 'Couldn’t load: ' + e.message, 'err'));
