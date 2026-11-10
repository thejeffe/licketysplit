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

// ---------- USB cards ----------
function renderCards() {
  const usbOk = 'serial' in navigator;
  $('usbNote').textContent = usbOk
    ? 'Plug the device into this computer with a USB cable, then press Install. A first install erases the device; for Matrixinator and WLED you can set Wi-Fi right after flashing.'
    : 'This browser can’t flash over USB. Open this page in Chrome or Edge on a computer. (Update over Wi-Fi below works anywhere.)';
  $('cards').innerHTML = S.firmware.map((f) => {
    const c = f.current, st = f.status;
    const ver = c ? `${esc(c.version)} · built ${when(c.published)}` : 'No build downloaded yet';
    const err = st && !st.ok ? `<div class="err">${esc(st.error)}</div>` : '';
    const btn = c && c.files.factory
      ? `<esp-web-install-button manifest="fw/${esc(f.id)}/manifest.json"><button slot="activate" class="pri">Install ${esc(c.version)}</button><span slot="unsupported"></span><span slot="not-allowed">Open this page over HTTPS to flash.</span></esp-web-install-button>`
      : '';
    return `<div class="card"><h3>${esc(f.name)}</h3><div class="what">${esc(f.what)}</div>
      <div class="meta">${esc(f.board)} · ${esc(f.chip)}<br>${ver}${f.repo ? `<br>${esc(f.repo)}` : ''}</div>${err}${btn}</div>`;
  }).join('');
}

// ---------- Wi-Fi devices ----------
function renderDevs() {
  $('aFw').innerHTML = S.firmware.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');
  $('devs').innerHTML = S.devices.map((d) => {
    const f = S.firmware.find((x) => x.id === d.fw) || {}, cur = f.current, p = probes[d.id], run = S.ota[d.id];
    const running = !p ? '…' : p.online ? `<span class="ver">${esc(p.version || '?')}</span><small>${esc(p.detail)}</small>` : `<span class="off">offline</span><small>${esc(p.detail)}</small>`;
    const newest = cur ? cur.version : '—';
    const isNew = p && p.online && cur && p.version && p.version !== cur.version && !String(p.version).startsWith(cur.version);
    const busy = run && run.state === 'sending';
    return `<tr data-id="${esc(d.id)}"><td><b>${esc(d.name)}</b><small>${esc(d.host)}</small></td><td>${esc(f.name || d.fw)}</td>
      <td>${running}</td><td class="ver ${isNew ? 'new' : ''}">${esc(newest)}${isNew ? ' ↑' : ''}</td>
      <td class="acts"><button type="button" class="small ${isNew ? 'pri' : ''}" data-act="ota" ${!cur || !p || !p.online || busy ? 'disabled' : ''}>${busy ? 'Updating…' : 'Update'}</button><button type="button" class="small" data-act="del" title="Remove from this list">✕</button>
      ${run ? `<div class="run ${esc(run.state)}">${esc(run.msg)}</div>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="note">No devices yet. Add one below.</td></tr>';
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
  const id = b.closest('tr').dataset.id, d = S.devices.find((x) => x.id === id);
  if (b.dataset.act === 'del') {
    if (!confirm(`Remove ${d.name} from the list? (Nothing on the device changes.)`)) return;
    await api('DELETE', `api/devices/${id}`).catch((e) => say($('msg'), e.message, 'err'));
    return load();
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

// ---------- settings ----------
$('setBtn').addEventListener('click', () => {
  $('sOwner').value = S.owner || '';
  $('sRepos').textContent = 'Builds come from the GitHub Releases of: ' + [...new Set(S.firmware.map((f) => (f.repo || '<owner>/' + (f.id.startsWith('wled') ? 'licketysplit' : f.id === 'airplay' ? 'airplay-esp32' : f.id))))].join(', ') + '.';
  $('sToken').textContent = S.tokenSet ? 'A GitHub token is set (private repos work).' : 'No GitHub token set: the repos must be public (or set GITHUB_TOKEN in /etc/licketysplit.env).';
  say($('sMsg'), ''); $('setDlg').showModal();
});
$('sCancel').addEventListener('click', () => $('setDlg').close());
$('setForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  try { await api('PUT', 'api/settings', { owner: $('sOwner').value }); $('setDlg').close(); say($('msg'), 'Saved. Press Check for new builds.', 'ok'); load(); }
  catch (e) { say($('sMsg'), e.message, 'err'); }
});

load().then(() => { probeAll(); if (Object.values(S.ota).some((r) => r.state === 'sending')) watchOta(); })
  .catch((e) => say($('msg'), 'Couldn’t load: ' + e.message, 'err'));
