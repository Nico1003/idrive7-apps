'use strict';
/*
 * Iconix Sounds – Audio-Kern (nur Node, Node-8-kompatibel)
 *
 * Synthese (synth.js) + Abspielprogramm (aplay/pacat/pw-cat/gst) + Taktgeber. Wird genutzt von:
 *   - tools/iconix-audiod/iconix-audiod.js  (Root-Dienst, Socket-Server)
 *   - apps/iconix_sounds/audio_link.js      (Rückfall: Ton direkt aus der App, wenn der Dienst fehlt)
 * Kanonische Quelle: shared/engine.js – Kopien erzeugt `npm run sync`.
 *
 *   const eng = new Engine({ log: fn, onStatus: st => ... });
 *   eng.configure(cfg); eng.params({ rpm, load, speed, overrun }); eng.test(); eng.start(); eng.stop();
 *
 * Umgebungsvariablen: ICONIX_RATE, ICONIX_LEAD_MS, ICONIX_BUFFER_US, ICONIX_PLAYER, ICONIX_DEVICE
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const Synth = require('./synth');

const RATE = Number(process.env.ICONIX_RATE) || 44100;
const TICK_MS = 20;          // 50 Wakeups/s (Blöcke à 882 Samples) – schont die CPU
// so viel Audio liegt höchstens vor (muss > TICK_MS + Jitter des Head Units sein). 160 ms gibt Reserve,
// wenn Node auf dem Head Unit kurz hängt (GC, andere Apps) – sonst knackt/stottert es (Underrun).
const LEAD_MS = Number(process.env.ICONIX_LEAD_MS) || 160;
const BUFFER_US = Number(process.env.ICONIX_BUFFER_US) || 200000; // Puffer des Abspielprogramms
const STALE_MS = 1500;       // ohne Daten -> ausblenden
const IDLE_STOP_MS = 8000;   // so lange still -> Abspielprogramm beenden (gibt das Audiogerät frei)
const MAX_CHUNK = 4096;

// ---------------------------------------------------------------------------
// Abspielprogramme
// ---------------------------------------------------------------------------
const BACKENDS = [
  {
    name: 'aplay', bin: 'aplay',
    args: function (r) {
      const a = ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', '2', '--buffer-time=' + BUFFER_US, '--period-time=' + Math.round(BUFFER_US / 4)];
      if (process.env.ICONIX_DEVICE) a.push('-D', process.env.ICONIX_DEVICE);
      a.push('-');
      return a;
    }
  },
  {
    name: 'pacat', bin: 'pacat',
    args: function (r) { return ['--playback', '--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'pw-cat', bin: 'pw-cat',
    args: function (r) { return ['--playback', '--format', 's16', '--rate', String(r), '--channels', '2', '-']; }
  },
  {
    name: 'gstreamer', bin: 'gst-launch-1.0',
    args: function (r) {
      return ['-q', 'fdsrc', 'fd=0', '!', 'rawaudioparse', 'format=pcm', 'pcm-format=s16le',
        'sample-rate=' + r, 'num-channels=2', '!', 'audioconvert', '!', 'audioresample', '!', 'autoaudiosink'];
    }
  }
];

function findBin(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter)
    .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin']);
  for (let i = 0; i < dirs.length; i++) {
    if (!dirs[i]) continue;
    const p = path.join(dirs[i], bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* weiter */ }
  }
  return null;
}

function candidates() {
  const out = [];
  if (process.env.ICONIX_PLAYER) {
    // "cmd arg arg" oder JSON-Array '["/pfad mit leerzeichen/cmd","arg"]'
    const raw = process.env.ICONIX_PLAYER.trim();
    let parts;
    try { parts = raw.charAt(0) === '[' ? JSON.parse(raw) : null; } catch (e) { parts = null; }
    if (!parts) parts = raw.split(/\s+/).filter(Boolean);
    parts = parts.map(function (s) { return String(s).replace('{rate}', String(RATE)); });
    out.push({ name: 'custom', path: parts[0], argv: parts.slice(1) });
  }
  BACKENDS.forEach(function (b) {
    const p = findBin(b.bin);
    if (p) out.push({ name: b.name, path: p, argv: b.args(RATE) });
  });
  return out;
}

// ---------------------------------------------------------------------------
// PCM-Ausgabe über ein Kindprozess-Abspielprogramm
// ---------------------------------------------------------------------------
function Output(onState, log) {
  this.onState = onState || function () {};
  this.log = log || function () {};
  this.list = candidates();
  this.bad = {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.underruns = 0;
  this.error = this.list.length ? null : 'kein Abspielprogramm gefunden (aplay/pacat/pw-cat/gst)';
  this.lastErr = '';
}

Output.prototype.start = function () {
  if (this.child) return true;
  const self = this, log = this.log;
  const b = this.list.filter(function (x) { return !self.bad[x.name]; })[0];
  if (!b) {
    this.error = this.list.length ? 'alle Abspielprogramme fehlgeschlagen' + (this.lastErr ? ': ' + this.lastErr : '') : this.error;
    this.onState();
    return false;
  }
  log('starte ' + b.name + ' ' + b.path + ' ' + b.argv.join(' '));
  let child;
  try {
    child = cp.spawn(b.path, b.argv, { stdio: ['pipe', 'ignore', 'pipe'] });
  } catch (e) {
    this.bad[b.name] = true; this.lastErr = e.message; this.onState();
    return false;
  }
  const startedAt = Date.now();
  this.child = child;
  this.backend = b.name;
  this.blocked = false;
  this.error = null;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', function (d) {
    const line = String(d).trim().split('\n').pop();
    if (!line) return;
    // aplay meldet Aussetzer als "underrun!!! (at least X ms long)" – zählen statt als Fehler werten
    if (/underrun|xrun/i.test(line)) {
      self.underruns++;
      if (self.underruns <= 5 || self.underruns % 50 === 0) log(b.name + ': ' + line + ' (#' + self.underruns + ')');
      return;
    }
    self.lastErr = line.slice(0, 120); log(b.name + ': ' + line);
  });
  child.stdin.on('error', function () { /* EPIPE -> exit folgt */ });
  child.stdin.on('drain', function () { self.blocked = false; });
  child.on('error', function (e) { self.lastErr = e.message; });
  child.on('exit', function (code, sig) {
    log(b.name + ' beendet, code ' + code + ' signal ' + sig);
    if (self.child === child) {
      self.child = null;
      self.backend = null;
      if (!self.stopping && Date.now() - startedAt < 3000) {
        self.bad[b.name] = true; // startet nicht -> nächstes Programm probieren
        self.error = b.name + ' fehlgeschlagen' + (self.lastErr ? ': ' + self.lastErr : '');
      }
      self.stopping = false;
      self.onState();
    }
  });
  this.onState();
  return true;
};

Output.prototype.stop = function () {
  if (!this.child) return;
  this.stopping = true;
  try { this.child.stdin.end(); } catch (e) { /* egal */ }
  const c = this.child;
  setTimeout(function () { try { c.kill('SIGTERM'); } catch (e) { /* egal */ } }, 300);
};

Output.prototype.write = function (buf) {
  if (!this.child || this.blocked) return false;
  const ok = this.child.stdin.write(buf);
  if (!ok) this.blocked = true;
  return true;
};

// Float32 interleaved -> S16LE Buffer (Int16Array-Sicht statt writeInt16LE pro Sample;
// x86 und ARM des Head Units sind little-endian). Buffer.alloc liefert immer byteOffset 0.
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
function toPcm(f32, frames) {
  const n = frames * 2;
  const buf = Buffer.alloc(n * 2);
  if (LITTLE) {
    const i16 = new Int16Array(buf.buffer, buf.byteOffset, n);
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      i16[i] = v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const v = f32[i];
      buf.writeInt16LE(v >= 1 ? 32767 : (v <= -1 ? -32767 : (v * 32767) | 0), i * 2);
    }
  }
  return buf;
}

// Test-Sweep: Leerlauf -> Vollgas bis Abregeldrehzahl -> Schub -> Teillast
function sweepAt(t, cfg) {
  const idle = cfg.carIdle || 800, red = cfg.carRedline || 4800;
  if (t < 0.8) return { rpm: idle, load: 0.05, speed: 0, overrun: false };
  if (t < 4.0) { const x = (t - 0.8) / 3.2; return { rpm: idle + (red - idle) * x, load: 1, speed: 120 * x, overrun: false }; }
  if (t < 5.5) { const x = (t - 4.0) / 1.5; return { rpm: red - (red - 1500) * x, load: 0, speed: 120 - 20 * x, overrun: true }; }
  if (t < 7.5) { const x = (t - 5.5) / 2; return { rpm: 1500 + 2000 * x, load: 0.5, speed: 100 + 20 * x, overrun: false }; }
  const x = Math.min(1, (t - 7.5) / 1.5);
  return { rpm: 3500 - (3500 - idle) * x, load: 0, speed: 120 * (1 - x), overrun: x < 0.9 };
}

// ---------------------------------------------------------------------------
// Engine: Synth + Ausgabe + Taktgeber
// ---------------------------------------------------------------------------
function Engine(opts) {
  opts = opts || {};
  const self = this;
  this.log = opts.log || function () {};
  this.onStatus = opts.onStatus || function () {};
  this.synth = new Synth(RATE);
  this.out = new Output(function () { self._changed(); }, this.log);
  this.lastParams = 0;
  this.testUntil = 0; this.testStart = 0;
  this.silentSince = 0;
  this.t0 = 0; this.written = 0;
  this.lastTick = Date.now(); this.late = 0;
  this.f32 = new Float32Array(MAX_CHUNK * 2);
  this.timer = null;
}

Engine.prototype.configure = function (cfg) { this.synth.configure(cfg); this._changed(); };
Engine.prototype.params = function (p) { this.synth.setParams(p); this.lastParams = Date.now(); };
Engine.prototype.test = function () {
  this.testStart = Date.now(); this.testUntil = this.testStart + 9000;
  // nach einem Fehler beim Testsound alle Abspielprogramme erneut probieren
  this.out.bad = {};
  this.out.list = candidates();
  this.out.error = this.out.list.length ? null : 'kein Abspielprogramm gefunden (aplay/pacat/pw-cat/gst)';
  this._changed();
};

Engine.prototype.status = function () {
  const out = this.out;
  return {
    ok: !out.error,
    backend: out.backend || (out.list[0] && !out.error ? out.list[0].name : null),
    rate: RATE, playing: !!out.child, error: out.error, profile: this.synth.cfg.profile,
    underruns: out.underruns || 0, late: this.late, leadMs: LEAD_MS,
    players: out.list.map(function (b) { return b.name; })
  };
};

Engine.prototype._changed = function () { try { this.onStatus(this.status()); } catch (e) { /* egal */ } };

Engine.prototype.start = function () {
  if (this.timer) return;
  const self = this;
  this.lastTick = Date.now();
  this.timer = setInterval(function () { self._tick(); }, TICK_MS);
};

Engine.prototype.stop = function () {
  if (this.timer) { clearInterval(this.timer); this.timer = null; }
  this.out.stop();
};

Engine.prototype._tick = function () {
  const now = Date.now(), synth = this.synth, out = this.out;
  // zählt Wakeups, die so spät kamen, dass der Vorlauf aufgebraucht war
  if (out.child && now - this.lastTick > LEAD_MS) this.late++;
  this.lastTick = now;
  const testing = now < this.testUntil;
  if (testing) {
    synth.setParams(sweepAt((now - this.testStart) / 1000, synth.cfg));
    synth.stale = false;
  } else {
    synth.stale = now - this.lastParams > STALE_MS;
  }
  // Testsound auch bei "Stumm" hörbar machen
  const wantSound = (synth.cfg.enabled || testing) && (!synth.stale || testing);
  if (testing && !synth.cfg.enabled) { synth.cfg.enabled = true; this._testUnmuted = true; }
  if (!testing && this._testUnmuted) { synth.cfg.enabled = false; this._testUnmuted = false; }

  if (wantSound) this.silentSince = 0;
  else if (!this.silentSince) this.silentSince = now;

  if (wantSound && !out.child && !out.error) {
    if (out.start()) { this.t0 = now; this.written = 0; }
  }
  if (out.child && this.silentSince && now - this.silentSince > IDLE_STOP_MS && synth.gain < 0.001) {
    this.log('still – gebe Audiogerät frei');
    out.stop();
  }
  if (!out.child) return;

  let due = Math.floor((now - this.t0 + LEAD_MS) / 1000 * RATE) - this.written;
  if (due > RATE / 2) { this.t0 = now; this.written = 0; due = Math.floor(LEAD_MS / 1000 * RATE); } // Resync nach Hänger
  while (due > 0 && !out.blocked && out.child) {
    const n = Math.min(due, MAX_CHUNK);
    synth.render(this.f32, n);
    out.write(toPcm(this.f32, n));
    this.written += n; due -= n;
  }
};

module.exports = {
  Engine: Engine, Output: Output, candidates: candidates, toPcm: toPcm, sweepAt: sweepAt,
  RATE: RATE, TICK_MS: TICK_MS, LEAD_MS: LEAD_MS, MAX_CHUNK: MAX_CHUNK
};
