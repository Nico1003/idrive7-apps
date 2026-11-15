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
    name: 'paplay', bin: 'paplay',
    args: function (r) { return ['--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=' + Math.round(BUFFER_US / 1000)]; }
  },
  {
    name: 'sox', bin: 'play',
    args: function (r) { return ['-q', '-t', 'raw', '-r', String(r), '-e', 'signed', '-b', '16', '-c', '2', '-']; }
  },
  {
    name: 'ffplay', bin: 'ffplay',
    args: function (r) { return ['-nodisp', '-loglevel', 'error', '-f', 's16le', '-ar', String(r), '-ac', '2', '-i', '-']; }
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

// Python finden: PATH, dann die Store-Tools unter /var/opt (mgu-python bringt Python 3.12 mit)
let pythonCache;
function findPython() {
  if (pythonCache !== undefined) return pythonCache;
  pythonCache = null;
  if (process.env.ICONIX_PYTHON) { pythonCache = process.env.ICONIX_PYTHON; return pythonCache; }
  const names = ['python3', 'python3.12', 'python'];
  for (let i = 0; i < names.length; i++) { const p = findBin(names[i]); if (p) { pythonCache = p; return p; } }
  const rels = ['current/bin/python3', 'current/bin/python3.12', 'current/python3', 'current/python/bin/python3',
    'current/usr/bin/python3', 'bin/python3'];
  let dirs = [];
  try { dirs = fs.readdirSync('/var/opt'); } catch (e) { dirs = []; }
  dirs.sort(function (a, b) { return (/python/.test(b) ? 1 : 0) - (/python/.test(a) ? 1 : 0); });
  for (let i = 0; i < dirs.length; i++) {
    for (let j = 0; j < rels.length; j++) {
      const p = path.join('/var/opt', dirs[i], rels[j]);
      try { fs.accessSync(p, fs.constants.X_OK); pythonCache = p; return p; } catch (e) { /* weiter */ }
    }
  }
  return null;
}

function hasLibasound() {
  const dirs = ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'];
  for (let i = 0; i < dirs.length; i++) { if (fs.existsSync(path.join(dirs[i], 'libasound.so.2'))) return true; }
  return false;
}

const ALSA_SCRIPT = path.join(__dirname, 'alsa_play.py');
// Geräte, die "auto" der Reihe nach probiert (das erste, das sich öffnen lässt, gewinnt)
const AUTO_DEVICES = ['default', 'plughw:0,0', 'plughw:0,1'];

/**
 * Abspielwege in Reihenfolge. opts.device: ALSA-Gerät für den Python-Player ('auto' = AUTO_DEVICES).
 */
function candidates(opts) {
  opts = opts || {};
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
  // ALSA über Python + ctypes (das Head Unit hat libasound und mgu-python, aber kein aplay)
  const py = findPython();
  if (py && fs.existsSync(ALSA_SCRIPT) && (hasLibasound() || process.env.ICONIX_ALSA_FORCE)) {
    const dev = opts.device && opts.device !== 'auto' ? [opts.device] : AUTO_DEVICES;
    dev.forEach(function (d) {
      out.push({ name: 'alsa:' + d, path: py, argv: [ALSA_SCRIPT, 'play', d, String(RATE), String(BUFFER_US)], device: d });
    });
  }
  BACKENDS.forEach(function (b) {
    const p = findBin(b.bin);
    if (p) out.push({ name: b.name, path: p, argv: b.args(RATE) });
  });
  return out;
}

/** ALSA-Geräte auflisten und testweise öffnen (Python-Skript "list"). cb(err, { devices: [...] }) */
function scanAlsa(cb) {
  const py = findPython();
  if (!py) return cb(new Error('kein Python gefunden'));
  if (!fs.existsSync(ALSA_SCRIPT)) return cb(new Error('alsa_play.py fehlt'));
  cp.execFile(py, [ALSA_SCRIPT, 'list'], { timeout: 20000, maxBuffer: 1 << 20 }, function (e, stdout, stderr) {
    let res = null;
    try { res = JSON.parse(String(stdout).trim().split('\n').pop()); } catch (x) { res = null; }
    if (!res) return cb(new Error((e && e.message) || String(stderr).trim().slice(0, 160) || 'keine Antwort'));
    cb(null, res);
  });
}

// ---------------------------------------------------------------------------
// PCM-Ausgabe über ein Kindprozess-Abspielprogramm
// ---------------------------------------------------------------------------
function Output(onState, log, opts) {
  this.onState = onState || function () {};
  this.log = log || function () {};
  this.opts = opts || {};
  this.list = candidates(this.opts);
  this.bad = {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.underruns = 0;
  this.error = this.list.length ? null : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose';
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
  this.device = opts.device || process.env.ICONIX_ALSA_DEVICE || 'auto';  // ALSA-Gerät oder 'auto' / 'scanN'
  this.scan = null;      // Ergebnis von scanAlsa
  this.devTest = null;   // laufender Gerätetest { list, i, until, prev }
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.lastParams = 0;
  this.testUntil = 0; this.testStart = 0;
  this.silentSince = 0;
  this.t0 = 0; this.written = 0;
  this.lastTick = Date.now(); this.late = 0;
  this.f32 = new Float32Array(MAX_CHUNK * 2);
  this.timer = null;
}

Engine.prototype.configure = function (cfg) {
  this.synth.configure(cfg);
  if (cfg && cfg.device && cfg.device !== this.device && !this.devTest) this.setDevice(cfg.device);
  this._changed();
};

// 'scanN' = das N-te Gerät, das sich beim Scan öffnen ließ (so in der Diagnose nummeriert)
Engine.prototype._resolve = function (d) {
  const m = /^scan(\d+)$/.exec(d || '');
  if (!m) return d || 'auto';
  const ok = ((this.scan && this.scan.devices) || []).filter(function (x) { return x.ok; });
  const hit = ok[Number(m[1]) - 1];
  return hit ? hit.name : 'auto';
};

Engine.prototype.setDevice = function (d) {
  const self = this;
  this.device = d || 'auto';
  const old = this.out;
  this.out = new Output(function () { self._changed(); }, this.log, { device: this._resolve(this.device) });
  this.out.underruns = old.underruns || 0;
  old.stop();
  this.log('Ausgabegerät: ' + this.device + ' -> ' + this._resolve(this.device));
  this._changed();
};

Engine.prototype.scanDevices = function (cb) {
  const self = this;
  scanAlsa(function (e, res) {
    self.scan = e ? { devices: [], error: e.message } : res;
    self.log('ALSA-Scan: ' + JSON.stringify(self.scan));
    // ein Gerät "scanN" erst jetzt auflösbar
    if (/^scan/.test(self.device)) self.setDevice(self.device);
    self._changed();
    if (cb) cb(self.scan);
  });
};

/** Spielt den Testsound nacheinander auf jedem Gerät, das sich öffnen ließ (je 4 s). */
Engine.prototype.testDevices = function () {
  const self = this;
  const run = function () {
    const list = ((self.scan && self.scan.devices) || []).filter(function (x) { return x.ok; }).map(function (x) { return x.name; });
    if (!list.length) { self.log('Gerätetest: kein Gerät ließ sich öffnen'); self._changed(); return; }
    self.devTest = { list: list, i: -1, prev: self.device };
    self._nextTestDevice();
  };
  if (this.scan) run(); else this.scanDevices(run);
};

Engine.prototype._nextTestDevice = function () {
  const t = this.devTest;
  if (!t) return;
  t.i++;
  if (t.i >= t.list.length) {
    const prev = t.prev;
    this.devTest = null;
    this.testUntil = 0;
    this.setDevice(prev);
    return;
  }
  this.setDevice(t.list[t.i]);
  this.testStart = Date.now(); this.testUntil = this.testStart + 4000;
  t.until = this.testUntil;
  this._changed();
};
Engine.prototype.params = function (p) { this.synth.setParams(p); this.lastParams = Date.now(); };
Engine.prototype.test = function () {
  this.testStart = Date.now(); this.testUntil = this.testStart + 9000;
  // nach einem Fehler beim Testsound alle Abspielprogramme erneut probieren
  this.out.bad = {};
  this.out.list = candidates({ device: this._resolve(this.device) });
  this.out.error = this.out.list.length ? null : 'kein Abspielprogramm gefunden – siehe Audio-Diagnose';
  this._changed();
};

Engine.prototype.status = function () {
  const out = this.out;
  return {
    ok: !out.error,
    backend: out.backend || (out.list[0] && !out.error ? out.list[0].name : null),
    rate: RATE, playing: !!out.child, error: out.error, profile: this.synth.cfg.profile,
    underruns: out.underruns || 0, late: this.late, leadMs: LEAD_MS,
    players: out.list.map(function (b) { return b.name; }),
    device: this.device, python: findPython(),
    scan: this.scan ? (this.scan.devices || []).map(function (d) { return { name: d.name, ok: d.ok, error: d.error }; }) : null,
    scanError: this.scan && this.scan.error,
    devTest: this.devTest ? { device: this.devTest.list[this.devTest.i], i: this.devTest.i + 1, n: this.devTest.list.length } : null
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
  if (this.devTest && now >= this.devTest.until) this._nextTestDevice();
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

// ---------------------------------------------------------------------------
// Audio-Diagnose: was gibt es auf diesem Gerät, um Ton auszugeben?
// (aus Sicht des aufrufenden Prozesses – App ohne Root bzw. Dienst als root)
// ---------------------------------------------------------------------------
const AUDIO_RE = /(^a?play|^paplay|^ffplay|audio|snd|alsa|pcm|pulse|pipewire|^gst|tinyalsa|tinyplay|tinymix|avb|sound|mixer|gong|chime|speaker|mediaengine|mediaapp)/i;

function probeAudio(opts) {
  opts = opts || {};
  const ls = function (d) { try { return fs.readdirSync(d); } catch (e) { return null; } };
  const read = function (f, n) { try { return fs.readFileSync(f, 'utf8').slice(0, n || 4000); } catch (e) { return null; } };
  const can = function (p, mode) { try { fs.accessSync(p, mode); return true; } catch (e) { return false; } };
  const uniq = function (a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); };
  const r = { at: Date.now() };
  r.uid = process.getuid ? process.getuid() : null;
  r.players = candidates().map(function (b) { return b.name + ' ' + b.path; });
  r.python = findPython();
  r.alsaScript = fs.existsSync(ALSA_SCRIPT);
  // ALSA-Geräte im Kernel
  r.devSnd = ls('/dev/snd');
  r.devSndWritable = (r.devSnd || []).filter(function (n) { return /^pcm.*p$/.test(n) && can('/dev/snd/' + n, fs.constants.W_OK); });
  r.cards = read('/proc/asound/cards', 1500);
  r.pcm = read('/proc/asound/pcm', 1500);
  // OSS-Emulation: dorthin könnte Node ohne Abspielprogramm direkt schreiben
  r.oss = ['/dev/dsp', '/dev/dsp0', '/dev/audio'].filter(function (p) { return fs.existsSync(p); })
    .map(function (p) { return p + (can(p, fs.constants.W_OK) ? ' (schreibbar)' : ' (kein Zugriff)'); });
  // Bibliotheken
  const libs = [];
  ['/usr/lib', '/lib', '/usr/lib64', '/lib64', '/usr/lib/x86_64-linux-gnu'].forEach(function (d) {
    (ls(d) || []).forEach(function (n) { if (/^lib(asound|pulse|pipewire|tinyalsa|gstreamer|avb|ias)/i.test(n)) libs.push(n); });
  });
  r.libs = uniq(libs).slice(0, 30);
  // Programme mit Audio-Bezug
  const bins = [];
  (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin'])
    .forEach(function (d) { if (d) (ls(d) || []).forEach(function (n) { if (AUDIO_RE.test(n)) bins.push(n); }); });
  r.bins = uniq(bins).sort().slice(0, 60);
  // laufende Prozesse mit Audio-Bezug
  const procs = [];
  (ls('/proc') || []).forEach(function (p) {
    if (!/^\d+$/.test(p)) return;
    const c = read('/proc/' + p + '/comm', 64);
    if (c && AUDIO_RE.test(c)) procs.push(c.trim());
  });
  r.procs = uniq(procs).sort().slice(0, 40);
  // BMW-SOME/IP-Schnittstellen mit Audio-Bezug (Katalog des Geräts)
  if (opts.someip !== false) {
    const cat = process.env.MGU_SOMEIP_CATALOG || '/etc/oap/someip/someip-interfaces.json';
    let txt = null;
    try { txt = fs.readFileSync(cat, 'utf8'); } catch (e) { r.someipError = e.code || String(e); }
    if (txt) {
      const re = /"(de\.bmw\.[A-Za-z0-9_.]*?(?:[Aa]udio|[Ss]ound|[Gg]ong|[Cc]hime|[Tt]one|ASD|[Aa]coustic|[Vv]olume|[Ss]peaker)[A-Za-z0-9_.]*)"/g;
      const names = [];
      let m;
      while ((m = re.exec(txt)) && names.length < 400) names.push(m[1]);
      r.someip = uniq(names).sort().slice(0, 60);
    }
  }
  return r;
}

/** Kurze Textzeilen für die Anzeige (ASCII, max. ~68 Zeichen). */
function diagLines(r, extra) {
  const out = [];
  const add = function (label, val) {
    let s = label + ': ' + val;
    while (s.length > 68) { const cut = s.lastIndexOf(', ', 68); const i = cut > 20 ? cut + 1 : 68; out.push(s.slice(0, i)); s = '   ' + s.slice(i).replace(/^\s+/, ''); }
    out.push(s);
  };
  const list = function (a, none) { return a && a.length ? a.join(', ') : (none || 'keine'); };
  (extra || []).forEach(function (l) { out.push(l); });
  add('Nutzer', r.uid === 0 ? 'root' : 'uid ' + r.uid);
  add('Abspielprogramme', list(r.players));
  add('Python', (r.python || 'nicht gefunden') + (r.alsaScript ? ' · alsa_play.py da' : ' · alsa_play.py fehlt'));
  add('/dev/snd', r.devSnd ? list(r.devSnd) : 'fehlt');
  if (r.devSnd) add('beschreibbar', list(r.devSndWritable));
  if (r.cards) add('Soundkarten', r.cards.split('\n').filter(function (l) { return /^\s*\d+ \[/.test(l); }).map(function (l) { return l.trim(); }).join(' | ') || r.cards.trim().slice(0, 60));
  add('OSS', list(r.oss));
  add('Bibliotheken', list(r.libs));
  add('Programme', list(r.bins));
  add('Prozesse', list(r.procs));
  add('SOME/IP', r.someip ? list(r.someip.map(function (n) { return n.replace(/^de\.bmw\.(infotainment\.|infrastructure\.)?/, ''); })) : 'nicht lesbar (' + (r.someipError || '?') + ')');
  return out;
}

module.exports = {
  probeAudio: probeAudio, diagLines: diagLines, scanAlsa: scanAlsa, findPython: findPython,
  Engine: Engine, Output: Output, candidates: candidates, toPcm: toPcm, sweepAt: sweepAt,
  RATE: RATE, TICK_MS: TICK_MS, LEAD_MS: LEAD_MS, MAX_CHUNK: MAX_CHUNK
};
