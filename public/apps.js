// The Apps tab: links to the house's web apps (kept in DATA_DIR/config.json), each with a share button; Edit changes the list.
(function () {
  var apps = [], list = document.getElementById('apList'), rows = document.getElementById('apRows'), ed = document.getElementById('apEditor');
  var SHARE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function host(u) { try { return new URL(u).host; } catch (e) { return u; } }
  function toast(t) { var el = document.getElementById('apToast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('on'); }, 1800); }
  function share(a) {
    var data = { title: a.name, text: a.about ? a.name + ': ' + a.about : a.name, url: a.url };
    if (navigator.share) { navigator.share(data).catch(function () {}); return; }
    (navigator.clipboard ? navigator.clipboard.writeText(a.url) : Promise.reject()).then(function () { toast('Link copied: ' + host(a.url)); }, function () { prompt('Copy this link', a.url); });
  }
  function show() {
    if (!apps.length) { list.innerHTML = '<p class="note">No apps yet. Tap Edit to add them.</p>'; return; }
    list.innerHTML = apps.map(function (a, i) {
      var ic = a.icon ? '<img src="' + esc(a.icon) + '" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode(\'' + esc(a.name.charAt(0).toUpperCase()) + '\'))">' : esc(a.name.charAt(0).toUpperCase());
      return '<div class="app"><a class="open" href="' + esc(a.url) + '" target="_blank" rel="noopener"><span class="ic">' + ic + '</span><span style="min-width:0"><b>' + esc(a.name) + '</b>' + (a.about ? '<small>' + esc(a.about) + '</small>' : '') + '<small class="host">' + esc(host(a.url)) + '</small></span></a>'
        + '<button type="button" class="share" data-i="' + i + '" title="Share ' + esc(a.name) + '" aria-label="Share ' + esc(a.name) + '">' + SHARE + '</button></div>';
    }).join('');
  }
  list.addEventListener('click', function (e) { var b = e.target.closest('.share'); if (b) share(apps[+b.dataset.i]); });
  function row(a) {
    var d = document.createElement('div'); d.className = 'row';
    d.innerHTML = '<input data-k="name" placeholder="Name" maxlength="40"><input data-k="url" placeholder="https://…" inputmode="url" autocapitalize="off" spellcheck="false"><input data-k="about" placeholder="What it does (optional)" maxlength="120"><input data-k="icon" placeholder="Icon address or apps/name.svg (optional)" inputmode="url" autocapitalize="off" spellcheck="false">'
      + '<div class="acts"><button type="button" data-a="up" title="Move up">↑</button><button type="button" data-a="down" title="Move down">↓</button><button type="button" data-a="del">Remove</button></div>';
    ['name', 'url', 'about', 'icon'].forEach(function (k) { d.querySelector('[data-k=' + k + ']').value = a[k] || ''; });
    return d;
  }
  rows.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return; var r = b.closest('.row');
    if (b.dataset.a === 'del') r.remove(); else if (b.dataset.a === 'up' && r.previousElementSibling) rows.insertBefore(r, r.previousElementSibling); else if (b.dataset.a === 'down' && r.nextElementSibling) rows.insertBefore(r.nextElementSibling, r);
  });
  function openEd() { rows.innerHTML = ''; apps.forEach(function (a) { rows.appendChild(row(a)); }); ed.hidden = false; document.getElementById('apMsg').textContent = ''; ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  document.getElementById('apEdit').onclick = function () { if (ed.hidden) openEd(); else ed.hidden = true; };
  document.getElementById('apCancel').onclick = function () { ed.hidden = true; };
  document.getElementById('apAdd').onclick = function () { var r = row({}); rows.appendChild(r); r.querySelector('input').focus(); };
  document.getElementById('apSave').onclick = function () {
    var out = [].map.call(rows.children, function (r) { var a = {}; r.querySelectorAll('input').forEach(function (i) { a[i.dataset.k] = i.value.trim(); }); return a; })
      .filter(function (a) { return a.name || a.url; });
    var m = document.getElementById('apMsg'); m.className = 'msg'; m.textContent = 'Saving…';
    fetch('api/apps', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apps: out }) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Couldn’t save.'); return j; }); })
      .then(function (j) { apps = j.apps; show(); ed.hidden = true; toast('Saved'); }, function (e) { m.className = 'msg err'; m.textContent = e.message; });
  };
  fetch('api/apps', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) { apps = j.apps || []; show(); }, function () { list.innerHTML = '<p class="note">Couldn’t load the apps.</p>'; });
})();
