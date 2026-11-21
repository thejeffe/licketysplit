// the ☰ menu: open and close it; picking an item closes it (the item's own click handler does the work)
(function () {
  var btn = document.getElementById('menuBtn'), pop = document.getElementById('menuPop'); if (!btn) return;
  function set(open) { pop.hidden = !open; btn.setAttribute('aria-expanded', open); if (open) { var f = pop.querySelector('button:not(:disabled)'); if (f) f.focus(); } }
  btn.addEventListener('click', function (e) { e.stopPropagation(); set(pop.hidden); });
  pop.addEventListener('click', function (e) { if (e.target.closest('button')) setTimeout(function () { set(false); }, 0); });
  document.addEventListener('click', function (e) { if (!pop.hidden && !e.target.closest('.menu')) set(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !pop.hidden) { set(false); btn.focus(); } });
})();
