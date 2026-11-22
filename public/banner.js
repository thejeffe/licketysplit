// The banner across the top: speed streaks and data packets racing by and a lightning flash now and then. When
// Duck Hunting finds something to fix, caution stripes and the duck at work (fixduck.js); the flying duck is for emails. Locked at the top (CSS), no buttons in it.
(function () {
  var cv = document.getElementById('bannerCv'); if (!cv) return;
  var x = cv.getContext('2d'), still = matchMedia('(prefers-reduced-motion: reduce)').matches, W = 0, H = 0, streaks = [], last = 0, flash = 0, nextFlash = 3;
  var COL = ['#ffd43b', '#ff4a3d', '#4dd4ac', '#4dabf7', '#ffffff'];
  function size() {
    var r = cv.getBoundingClientRect(), d = Math.min(2, devicePixelRatio || 1); W = r.width; H = r.height; cv.width = W * d; cv.height = H * d; x.setTransform(d, 0, 0, d, 0, 0);
    streaks = []; for (var i = 0; i < W / 14; i++) streaks.push(mk(Math.random() * W));
  }
  function mk(px) { return { x: px, y: 4 + Math.random() * (H - 8), l: 10 + Math.random() * 50, v: 120 + Math.random() * 380, c: COL[Math.floor(Math.random() * COL.length)], dot: Math.random() < 0.25 }; }
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
    // something needs fixing (Duck Hunting found it): caution stripes along the bottom and the duck at work by the logo
    var trouble = +(document.body.dataset.trouble || 0);
    if (trouble && window.drawFixDuck) {
      var sh = (t * 30) % 20; x.save(); x.beginPath(); x.rect(0, H - 6, W, 6); x.clip();
      for (var sx2 = -20 + sh; sx2 < W + 20; sx2 += 20) { x.fillStyle = '#f2b33d'; x.beginPath(); x.moveTo(sx2, H); x.lineTo(sx2 + 10, H); x.lineTo(sx2 + 16, H - 6); x.lineTo(sx2 + 6, H - 6); x.fill(); }
      x.restore();
      var bn = document.querySelector('.banner .bn img'), r0 = bn ? bn.getBoundingClientRect() : null, b0 = cv.getBoundingClientRect();
      var fx = r0 ? r0.left - b0.left - 80 : W / 2 - 160, fy = H - 10;
      if (fx < 24) { var tt = document.querySelector('.banner .title'), r1 = tt ? tt.getBoundingClientRect() : null; fx = r1 ? r1.right - b0.left + 30 : W - 80; }
      window.drawFixDuck(x, fx, fy, t, 1);
    }
    if (!still) requestAnimationFrame(frame);
  }
  size(); addEventListener('resize', size); requestAnimationFrame(frame);
})();
