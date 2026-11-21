// The banner across the top: speed streaks and data packets racing by, a lightning flash now and then, and every
// half-minute or so the caped super-duck zooms across. Locked at the top (CSS), no buttons in it.
(function () {
  var cv = document.getElementById('bannerCv'); if (!cv) return;
  var x = cv.getContext('2d'), still = matchMedia('(prefers-reduced-motion: reduce)').matches, W = 0, H = 0, streaks = [], last = 0, flash = 0, nextFlash = 3;
  var COL = ['#ffd43b', '#ff4a3d', '#4dd4ac', '#4dabf7', '#ffffff'];
  function size() {
    var r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = W * d; cv.height = H * d; x.setTransform(d, 0, 0, d, 0, 0);
    streaks = []; for (var i = 0; i < W / 14; i++) streaks.push(mk(Math.random() * W));
  }
  function mk(px) { return { x: px, y: 4 + Math.random() * (H - 8), l: 10 + Math.random() * 50, v: 120 + Math.random() * 380, c: COL[Math.floor(Math.random() * COL.length)], dot: Math.random() < 0.25 }; }
  function duck(px, py, t) {
    x.save(); x.translate(px, py);
    x.fillStyle = '#e03131'; x.beginPath(); x.moveTo(2, -4); x.lineTo(-18, -3 + Math.sin(t * 20) * 3); x.lineTo(-16, 5 + Math.sin(t * 20 + 1) * 2); x.lineTo(2, 2); x.fill();
    x.fillStyle = '#ffd43b'; x.beginPath(); x.ellipse(8, 0, 10, 6, 0, 0, 7); x.fill(); x.beginPath(); x.arc(18, -4, 5.5, 0, 7); x.fill();
    x.fillStyle = '#f2b100'; x.beginPath(); x.ellipse(6, -2 - Math.sin(t * 30) * 3, 7, 3, -0.4, 0, 7); x.fill();
    x.fillStyle = '#ff922b'; x.beginPath(); x.moveTo(23, -5); x.lineTo(29, -3); x.lineTo(23, -1); x.fill();
    x.fillStyle = '#1971c2'; x.fillRect(14, -7, 9, 3); x.restore();
  }
  function frame(now) {
    var t = now / 1000, dt = last ? Math.min(0.1, t - last) : 0; last = t;
    x.clearRect(0, 0, W, H);
    if (!still) { nextFlash -= dt; if (nextFlash <= 0) { flash = 0.35; nextFlash = 5 + Math.random() * 8; } flash = Math.max(0, flash - dt); }
    if (flash > 0) { x.fillStyle = 'rgba(255,212,59,' + (flash * 0.35) + ')'; x.fillRect(0, 0, W, H); }
    streaks.forEach(function (s) {
      if (!still) { s.x -= s.v * dt; if (s.x < -s.l - 10) { var n = mk(W + Math.random() * 40); for (var k in n) s[k] = n[k]; } }
      if (s.dot) { x.globalAlpha = 0.8; x.fillStyle = s.c; x.fillRect(s.x, s.y - 1.5, 4, 3); }
      else { var g = x.createLinearGradient(s.x, 0, s.x + s.l, 0); g.addColorStop(0, s.c); g.addColorStop(1, 'rgba(0,0,0,0)'); x.globalAlpha = 0.45; x.strokeStyle = g; x.lineWidth = 1.5; x.beginPath(); x.moveTo(s.x, s.y); x.lineTo(s.x + s.l, s.y); x.stroke(); }
    });
    x.globalAlpha = 1;
    var cyc = (t % 32) / 4; if (!still && cyc < 1) { var px = -40 + cyc * (W + 80), py = H - 30 + Math.sin(cyc * 14) * 4; for (var i = 0; i < 6; i++) { x.globalAlpha = 0.5 - i * 0.07; x.strokeStyle = '#ffd43b'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(px - 22 - i * 9, py - 4 + i % 3 * 4); x.lineTo(px - 14 - i * 9, py - 4 + i % 3 * 4); x.stroke(); } x.globalAlpha = 1; duck(px, py, t); }
    if (!still) requestAnimationFrame(frame);
  }
  size(); addEventListener('resize', size); requestAnimationFrame(frame);
})();
