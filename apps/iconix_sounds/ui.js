/*
 * Iconix Sounds – Hauptbildschirm (1600 x 520, Canvas-Empfehlung des idrive7-apps-Kits)
 *
 * Zeichnet über ein kleines Grafik-Interface `g`, damit derselbe Code im Auto (Kit-Canvas)
 * und im PC-Simulator (HTML-Canvas) läuft:
 *   g.rect(x, y, w, h, color)
 *   g.rrect(x, y, w, h, radius, color)
 *   g.text(str, x, baselineY, size, color, align /* 'left'|'center'|'right' *\/, bold)
 *   g.arc(cx, cy, radius, thickness, a0, a1, color)   // Winkel in Radiant, 0 = 3 Uhr, im Uhrzeigersinn
 *
 * Kanonische Quelle: shared/ui.js – Kopie in apps/iconix_sounds/ erzeugt `npm run sync`.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1600, H = 520;
  var C = {
    bg: '#0b0f14', panel: '#151b23', track: '#232b36', text: '#f2f5f8', dim: '#8a96a6',
    accent: '#3d8bfd', accent2: '#7cc4ff', warn: '#ffb020', crit: '#ff4d4d', ok: '#38d27a'
  };
  var A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 135° .. 405°

  function pct(x) { return Math.round(x * 100) + ' %'; }

  /**
   * state = {
   *   profiles: [{id, name}], profile: 'v8',
   *   rpm, redline, speed, load (0..1), volume (0..1),
   *   enabled, sport, pops, demo,
   *   audio: { ok: bool, text: 'aplay · 44,1 kHz' }, hint: '...'
   * }
   */
  function draw(g, s) {
    g.rect(0, 0, W, H, C.bg);

    // ---- Drehzahlring --------------------------------------------------
    var cx = 290, cy = 275, r = 205, th = 24;
    var redline = s.redline || 4800;
    var frac = Math.max(0, Math.min(1, (s.rpm || 0) / (redline * 1.1)));
    var redFrom = redline / (redline * 1.1);
    g.arc(cx, cy, r, th, A0, A1, C.track);
    g.arc(cx, cy, r, th, A0 + (A1 - A0) * redFrom, A1, '#4a2026');
    if (frac > 0.002) {
      var col = frac >= redFrom ? C.crit : (s.sport ? C.warn : C.accent);
      g.arc(cx, cy, r, th, A0, A0 + (A1 - A0) * frac, col);
    }
    g.text(String(Math.round(s.rpm || 0)), cx, cy + 10, 96, C.text, 'center', true);
    g.text('U/min', cx, cy + 58, 30, C.dim, 'center', false);
    g.text(Math.round(s.speed || 0) + ' km/h', cx, cy + 150, 40, C.text, 'center', true);

    // ---- Profil -------------------------------------------------------
    var x0 = 600, x1 = 1540;
    g.text('ICONIX SOUNDS', x0, 70, 26, C.dim, 'left', true);
    var cur = null, i;
    for (i = 0; i < s.profiles.length; i++) if (s.profiles[i].id === s.profile) cur = s.profiles[i];
    g.text(cur ? cur.name : '–', x0, 140, 62, s.enabled ? C.text : C.dim, 'left', true);

    // Profil-Chips (2 Reihen à 4)
    var cw = 222, ch = 48, gap = 12;
    for (i = 0; i < s.profiles.length; i++) {
      var px = x0 + (i % 4) * (cw + gap), py = 172 + Math.floor(i / 4) * (ch + gap);
      var active = s.profiles[i].id === s.profile;
      g.rrect(px, py, cw, ch, 12, active ? C.accent : C.panel);
      g.text(s.profiles[i].name, px + cw / 2, py + 32, 22, active ? '#ffffff' : C.dim, 'center', active);
    }

    // ---- Lautstärke ----------------------------------------------------
    var vy = 330;
    g.text('Lautstärke', x0, vy, 28, C.dim, 'left', false);
    g.text(s.enabled ? pct(s.volume) : 'STUMM', x1, vy, 28, s.enabled ? C.text : C.warn, 'right', true);
    g.rrect(x0, vy + 14, x1 - x0, 26, 13, C.track);
    var vw = (x1 - x0) * Math.max(0, Math.min(1, s.volume));
    if (vw > 26) g.rrect(x0, vy + 14, vw, 26, 13, s.enabled ? C.accent2 : C.dim);

    // ---- Last ---------------------------------------------------------
    var ly = 410;
    g.text('Last', x0, ly, 24, C.dim, 'left', false);
    g.rrect(x0 + 80, ly - 18, x1 - x0 - 80, 14, 7, C.track);
    var lw = (x1 - x0 - 80) * Math.max(0, Math.min(1, s.load || 0));
    if (lw > 14) g.rrect(x0 + 80, ly - 18, lw, 14, 7, C.ok);

    // ---- Status -------------------------------------------------------
    var sy = 480;
    var a = s.audio || { ok: false, text: 'Audio-Dienst nicht verbunden' };
    g.rrect(x0, sy - 20, 20, 20, 10, a.ok ? C.ok : C.crit);
    g.text(a.text, x0 + 32, sy - 2, 24, C.dim, 'left', false);
    var tags = [];
    if (s.demo) tags.push(['DEMO', C.warn]);
    if (s.sport) tags.push(['SPORT', C.warn]);
    if (s.pops) tags.push(['POPS', C.accent2]);
    var tx = x1;
    for (i = tags.length - 1; i >= 0; i--) {
      var tw = tags[i][0].length * 15 + 28;
      tx -= tw;
      g.rrect(tx, sy - 30, tw, 36, 10, C.panel);
      g.text(tags[i][0], tx + tw / 2, sy - 3, 22, tags[i][1], 'center', true);
      tx -= 10;
    }
    if (s.hint) g.text(s.hint, cx, 505, 22, C.dim, 'center', false);
  }

  return { W: W, H: H, colors: C, draw: draw };
});
