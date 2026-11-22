// The "fixing" duck: hard hat on, wrench going, sparks flying off a broken box. Drawn on the page's banner when
// something needs fixing, and recorded once into duck-fix.gif for the alert emails.
window.drawFixDuck = function (x, px, py, t, s) {
  s = s || 1;
  x.save(); x.translate(px, py); x.scale(s, s);
  // the broken box (a router) with its warning light and sparks
  x.fillStyle = '#2b3b4c'; x.fillRect(26, -14, 34, 16); x.fillStyle = '#3d5368'; x.fillRect(26, -14, 34, 3);
  x.fillStyle = Math.floor(t * 4) % 2 ? '#ff4a3d' : '#5a1d18'; x.fillRect(30, -9, 4, 4);
  x.strokeStyle = '#8aa0b4'; x.lineWidth = 1.5; x.beginPath(); x.moveTo(52, -14); x.lineTo(56, -24); x.stroke();
  var hit = (t * 3) % 1, k;
  for (k = 0; k < 6; k++) {
    var a = -Math.PI / 2 + (k - 2.5) * 0.45, d = hit * (10 + k * 2);
    x.globalAlpha = Math.max(0, 1 - hit * 1.3); x.fillStyle = k % 2 ? '#ffd43b' : '#ffffff';
    x.fillRect(30 + Math.cos(a) * d, -16 + Math.sin(a) * d, 2, 2);
  }
  x.globalAlpha = 1;
  // the duck, standing, a little bob as it works
  var bob = Math.abs(Math.sin(t * 6)) * 1.5;
  x.translate(0, -bob);
  x.fillStyle = '#e03131'; x.beginPath(); x.moveTo(-8, -10); x.lineTo(-20, -4 + Math.sin(t * 8) * 2); x.lineTo(-16, 4); x.lineTo(-6, -2); x.fill();          // cape
  x.fillStyle = '#ff922b'; x.fillRect(-4, 0, 3, 4); x.fillRect(3, 0, 3, 4);                                                                         // feet
  x.fillStyle = '#ffd43b'; x.beginPath(); x.ellipse(0, -8, 10, 8, 0, 0, 7); x.fill(); x.beginPath(); x.arc(5, -20, 6.5, 0, 7); x.fill();           // body, head
  x.fillStyle = '#ff922b'; x.beginPath(); x.moveTo(11, -21); x.lineTo(17, -19); x.lineTo(11, -17); x.fill();                                         // beak
  x.fillStyle = '#1971c2'; x.fillRect(1, -23, 10, 3); x.fillStyle = '#111'; x.fillRect(8, -22, 2, 2);                                               // mask, eye
  x.fillStyle = '#ffd43b'; x.strokeStyle = '#c98a00'; x.lineWidth = 1; x.beginPath(); x.arc(5, -24, 7.5, Math.PI, 0); x.fill(); x.stroke(); x.fillRect(-4, -25, 18, 2);   // hard hat
  // the wing with the wrench, swinging at the box
  var sw = -0.9 + Math.pow(Math.sin(t * Math.PI * 3), 2) * 1.3;
  x.save(); x.translate(6, -10); x.rotate(sw);
  x.fillStyle = '#f2b100'; x.beginPath(); x.ellipse(5, 0, 7, 3.5, 0, 0, 7); x.fill();
  x.fillStyle = '#adb5bd'; x.fillRect(9, -1.5, 14, 3); x.beginPath(); x.arc(24, 0, 4, 0, 7); x.fill(); x.fillStyle = '#2b3b4c'; x.fillRect(24, -1.5, 5, 3);
  x.restore();
  x.restore();
};
