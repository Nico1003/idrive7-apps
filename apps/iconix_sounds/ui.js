/*
 * Iconix Sounds – Hauptbildschirm (1600 x 520) im Stil von BMW iDrive 7
 *
 * Gestaltung angelehnt an iDrive 7 und das digitale Kombiinstrument: dunkler, leicht blauer Grund,
 * dünne Linien, Light-Schrift für Zahlen und Titel, BMW-Blau als einzige Akzentfarbe, flache Kacheln
 * mit feinem Rand, Drehzahlmesser mit Skalenstrichen und rotem Bereich.
 *
 * Zeichnet über ein kleines Grafik-Interface `g`, damit derselbe Code im Auto (Kit-Canvas) und im
 * PC-Simulator (HTML-Canvas) läuft:
 *   g.rect(x, y, w, h, color)
 *   g.rrect(x, y, w, h, radius, color)
 *   g.line(x1, y1, x2, y2, width, color)
 *   g.text(str, x, baselineY, size, color, align /* 'left'|'center'|'right' *\/, weight /* true = fett, 'light' = dünn *\/)
 *   g.arc(cx, cy, radius, thickness, a0, a1, color)   // Winkel in Radiant, 0 = 3 Uhr, im Uhrzeigersinn
 *
 * Leistung: nur Rechtecke, Linien, Bögen und Text; keine Allokation pro Bild außer kurzen Strings.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IconixUI = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var W = 1600, H = 520;
  var C = {
    bg: '#06090e', bg2: '#0a0f17', panel: '#0f151e', edge: '#233041', track: '#1b2430', tick: '#4d5a6b',
    text: '#f2f5f8', dim: '#8d99aa', faint: '#5b6676',
    accent: '#1c69d4', accent2: '#5fa3ff', hi: '#2f7fe6',
    warn: '#ffb020', crit: '#e8332f', ok: '#3fbf7f'
  };
  var A0 = Math.PI * 0.75, A1 = Math.PI * 2.25; // 135° .. 405° (270°-Skala wie im Kombiinstrument)

  function pct(x) { return Math.round(x * 100) + ' %'; }

  // Geometrie der bedienbaren Flächen – EINE Quelle für Zeichnen, Touch-Ziele im Auto (cv.target)
  // und Klicks im Simulator.
  var X0 = 620, X1 = 1556, CW = 225, CH = 50, GAP = 12, CHIP_Y = 186;
  var VY = 352, VB = 56;           // Lautstärke-Zeile, Breite der −/+-Knöpfe
  function chipRect(i) {
    return { x: X0 + (i % 4) * (CW + GAP), y: CHIP_Y + Math.floor(i / 4) * (CH + GAP), w: CW, h: CH, r: 6 };
  }
  /** Bedienbare Flächen: [{ key, act, arg, x, y, w, h, r }] – act: 'profile' | 'vol' | 'mute' */
  function hits(profiles) {
    var out = [], i, c;
    for (i = 0; i < profiles.length; i++) {
      c = chipRect(i);
      out.push({ key: 'profile:' + profiles[i].id, act: 'profile', arg: profiles[i].id, x: c.x, y: c.y, w: c.w, h: c.h, r: c.r });
    }
    out.push({ key: 'vol-', act: 'vol', arg: -1, x: X0, y: VY, w: VB, h: VB, r: 6 });
    out.push({ key: 'vol+', act: 'vol', arg: 1, x: X1 - VB, y: VY, w: VB, h: VB, r: 6 });
    out.push({ key: 'mute', act: 'mute', arg: null, x: X1 - 200, y: VY - 46, w: 200, h: 40, r: 6 });
    return out;
  }
  // Diagnose-Ansicht: Geräte testen / Weiter / Schließen
  var DIAG_LINES = 11;
  function hitsDiag() {
    return [
      { key: 'diag-devtest', act: 'diagDevTest', arg: null, x: X1 - 744, y: 452, w: 260, h: 50, r: 6 },
      { key: 'diag-next', act: 'diagNext', arg: null, x: X1 - 472, y: 452, w: 220, h: 50, r: 6 },
      { key: 'diag-close', act: 'diagClose', arg: null, x: X1 - 240, y: 452, w: 240, h: 50, r: 6 }
    ];
  }
  function hitAt(profiles, x, y, diag) {
    var h = diag ? hitsDiag() : hits(profiles);
    for (var i = 0; i < h.length; i++) if (x >= h[i].x && x <= h[i].x + h[i].w && y >= h[i].y && y <= h[i].y + h[i].h) return h[i];
    return null;
  }

  // Kachel mit feinem Rand (iDrive: flach, kleiner Radius)
  function tile(g, x, y, w, h, r, fill, edge) {
    g.rrect(x, y, w, h, r, edge);
    g.rrect(x + 1.5, y + 1.5, w - 3, h - 3, Math.max(0, r - 1.5), fill);
  }

  // Untertitel eines Profils (Bauart)
  function kindOf(p) {
    if (!p) return '';
    if (p.kind === 'electric') return 'Elektro';
    var n = p.layout ? p.layout.length : 0;
    var v = { v8: 'V8', v10: 'V10' }[p.id];
    return 'Verbrenner · ' + (v || (n ? n + ' Zylinder' : ''));
  }

  /**
   * state = {
   *   profiles: [{id, name, kind, layout}], profile: 'v8',
   *   rpm, redline, speed, load (0..1), volume (0..1),
   *   enabled, sport, demo,
   *   audio: { ok: bool, text: '…' }, hint: '...'
   * }
   */
  function draw(g, s) {
    // Grund: einfarbig dunkel mit leichtem Blaustich (wie die iDrive-7-Oberfläche)
    g.rect(0, 0, W, H, C.bg);

    drawTacho(g, s);
    if (s.diag) { drawDiag(g, s); if (s.hint) g.text(s.hint, 300, 508, 20, C.faint, 'center', 'light'); return; }

    var x0 = X0, x1 = X1, i;
    // ---- Kopf: Titel, feine Linie mit blauem Akzent ---------------------
    g.text('Iconix Sounds', x0, 58, 30, C.dim, 'left', 'light');
    g.line(x0, 80, x1, 80, 1.5, C.edge);
    g.line(x0, 80, x0 + 96, 80, 3, C.accent);

    var cur = null;
    for (i = 0; i < s.profiles.length; i++) if (s.profiles[i].id === s.profile) cur = s.profiles[i];
    g.text(cur ? cur.name : '–', x0, 148, 54, s.enabled ? C.text : C.dim, 'left', 'light');
    g.text(kindOf(cur), x1, 148, 22, C.faint, 'right', 'light');

    // ---- Profil-Kacheln (2 Reihen à 4) ---------------------------------
    for (i = 0; i < s.profiles.length; i++) {
      var c = chipRect(i), active = s.profiles[i].id === s.profile;
      if (active) {
        g.rrect(c.x, c.y, c.w, c.h, c.r, C.accent);
        g.rect(c.x + 3, c.y + 2, c.w - 6, 2, C.hi); // Lichtkante oben
      } else tile(g, c.x, c.y, c.w, c.h, c.r, C.panel, C.edge);
      g.text(s.profiles[i].name, c.x + c.w / 2, c.y + 33, 22, active ? '#ffffff' : '#b9c3cf', 'center', active ? false : 'light');
    }

    // ---- Lautstärke: [−] ——●—— [+] --------------------------------------
    var vy = VY;
    g.text('Lautstärke', x0, vy - 16, 24, C.dim, 'left', 'light');
    g.text(s.enabled ? pct(s.volume) : 'Stumm', x1, vy - 16, 26, s.enabled ? C.text : C.warn, 'right', 'light');
    tile(g, x0, vy, VB, VB, 6, C.panel, C.edge);
    g.line(x0 + 18, vy + VB / 2, x0 + VB - 18, vy + VB / 2, 3, C.text);
    tile(g, x1 - VB, vy, VB, VB, 6, C.panel, C.edge);
    g.line(x1 - VB + 18, vy + VB / 2, x1 - 18, vy + VB / 2, 3, C.text);
    g.line(x1 - VB / 2, vy + 18, x1 - VB / 2, vy + VB - 18, 3, C.text);
    var bx = x0 + VB + 28, bw = x1 - x0 - 2 * (VB + 28), by = vy + VB / 2;
    g.rrect(bx, by - 3, bw, 6, 3, C.track);
    var v = Math.max(0, Math.min(1, s.volume / 1.5)), vx = bx + bw * v; // Regler bis 150 %
    if (v > 0.01) g.rrect(bx, by - 3, vx - bx, 6, 3, s.enabled ? C.accent : C.faint);
    g.rrect(vx - 11, by - 11, 22, 22, 11, s.enabled ? '#ffffff' : C.dim);

    // ---- Last: dünne Leiste -------------------------------------------
    var ly = 452;
    g.text('Last', x0, ly + 6, 20, C.faint, 'left', 'light');
    g.rrect(x0 + 64, ly - 2, x1 - x0 - 64, 4, 2, C.track);
    var lw = (x1 - x0 - 64) * Math.max(0, Math.min(1, s.load || 0));
    if (lw > 4) g.rrect(x0 + 64, ly - 2, lw, 4, 2, C.accent2);

    // ---- Status und Markierungen --------------------------------------
    var sy = 500;
    var a = s.audio || { ok: false, text: 'Audio-Dienst nicht verbunden' };
    g.rrect(x0, sy - 13, 12, 12, 6, a.ok ? C.ok : C.crit);
    g.text(a.text.length > 66 ? a.text.slice(0, 65) + '…' : a.text, x0 + 24, sy - 2, 20, C.dim, 'left', 'light');
    var tags = [];
    if (s.demo) tags.push(['DEMO', C.warn]);
    if (s.sport) tags.push(['SPORT', C.accent2]);
    var tx = x1;
    for (i = tags.length - 1; i >= 0; i--) {
      var tw = tags[i][0].length * 13 + 26;
      tx -= tw;
      tile(g, tx, sy - 27, tw, 32, 16, C.bg, tags[i][1]);
      g.text(tags[i][0], tx + tw / 2, sy - 4, 18, tags[i][1], 'center', true);
      tx -= 10;
    }
    if (s.hint) g.text(s.hint, 300, 508, 20, C.faint, 'center', 'light');
  }

  // Drehzahlmesser wie im Kombiinstrument: Skala mit Strichen und Ziffern, roter Bereich, blauer Bogen
  function drawTacho(g, s) {
    var cx = 300, cy = 268, r = 206;
    var redline = s.redline || 4800, top = Math.ceil(redline * 1.1 / 1000) * 1000;
    var rpm = Math.max(0, s.rpm || 0), frac = Math.min(1, rpm / top), redFrom = redline / top;
    var span = A1 - A0, k, ang, cs, sn, major, red;
    g.arc(cx, cy, r, 3, A0, A1, C.track);
    g.arc(cx, cy, r, 3, A0 + span * redFrom, A1, '#5a1c1f');
    // Striche alle 500 U/min, Ziffern (x1000) an den vollen Tausendern
    for (k = 0; k <= top; k += 500) {
      ang = A0 + span * (k / top); cs = Math.cos(ang); sn = Math.sin(ang);
      major = k % 1000 === 0; red = k >= redline;
      var r0 = r - (major ? 26 : 16), r1 = r - 6;
      g.line(cx + cs * r0, cy + sn * r0, cx + cs * r1, cy + sn * r1, major ? 3 : 2, red ? C.crit : (major ? '#c9d1db' : C.tick));
      if (major) g.text(String(k / 1000), cx + cs * (r - 52), cy + sn * (r - 52) + 9, 26, red ? C.crit : C.dim, 'center', 'light');
    }
    // Bogen bis zur aktuellen Drehzahl (blau, im roten Bereich rot) und schmale Nadel
    if (frac > 0.003) {
      var redA = A0 + span * Math.min(frac, redFrom);
      g.arc(cx, cy, r + 9, 8, A0, redA, s.sport ? C.accent2 : C.accent);
      if (frac > redFrom) g.arc(cx, cy, r + 9, 8, A0 + span * redFrom, A0 + span * frac, C.crit);
    }
    ang = A0 + span * frac; cs = Math.cos(ang); sn = Math.sin(ang);
    g.line(cx + cs * (r - 70), cy + sn * (r - 70), cx + cs * (r + 10), cy + sn * (r + 10), 4, frac > redFrom ? C.crit : '#ffffff');
    // Ziffern in der Mitte
    g.text(String(Math.round(rpm)), cx, cy + 22, 92, C.text, 'center', 'light');
    g.text('1/min', cx, cy + 62, 22, C.faint, 'center', 'light');
    g.text(Math.round(s.speed || 0) + ' km/h', cx, cy + 178, 36, C.text, 'center', 'light');
  }

  // s.diag = { lines: [...], page: 0 }
  function drawDiag(g, s) {
    var d = s.diag, pages = Math.max(1, Math.ceil(d.lines.length / DIAG_LINES));
    var page = ((d.page || 0) % pages + pages) % pages;
    tile(g, X0 - 20, 24, X1 - X0 + 40, 488, 8, C.panel, C.edge);
    g.text('Audio-Diagnose', X0, 66, 28, C.text, 'left', 'light');
    g.line(X0, 82, X1, 82, 1.5, C.edge);
    g.line(X0, 82, X0 + 96, 82, 3, C.accent);
    g.text('Seite ' + (page + 1) + '/' + pages, X1, 66, 20, C.dim, 'right', 'light');
    var ls = d.lines.slice(page * DIAG_LINES, page * DIAG_LINES + DIAG_LINES);
    ls = ls.map(function (l) { return l.length > 76 ? l.slice(0, 75) + '…' : l; });
    for (var i = 0; i < ls.length; i++) g.text(ls[i], X0, 114 + i * 28, 21, i === 0 && page === 0 ? C.text : C.dim, 'left', 'light');
    var b = hitsDiag();
    tile(g, b[0].x, b[0].y, b[0].w, b[0].h, b[0].r, C.bg2, C.edge);
    g.text('Geräte testen', b[0].x + b[0].w / 2, b[0].y + 33, 22, C.warn, 'center', 'light');
    tile(g, b[1].x, b[1].y, b[1].w, b[1].h, b[1].r, C.bg2, C.edge);
    g.text('Weiter', b[1].x + b[1].w / 2, b[1].y + 33, 22, C.text, 'center', 'light');
    g.rrect(b[2].x, b[2].y, b[2].w, b[2].h, b[2].r, C.accent);
    g.text('Schließen', b[2].x + b[2].w / 2, b[2].y + 33, 22, '#ffffff', 'center', false);
    if (s.audio && s.audio.text) g.text(s.audio.text.length > 60 ? s.audio.text.slice(0, 59) + '…' : s.audio.text, X0, 432, 20, s.audio.ok ? C.ok : C.warn, 'left', 'light');
  }

  return { W: W, H: H, colors: C, draw: draw, hits: hits, hitsDiag: hitsDiag, hitAt: hitAt, DIAG_LINES: DIAG_LINES };
});
