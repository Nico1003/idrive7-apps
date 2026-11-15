'use strict';
/*
 * iconix-audiod – Audio-Dienst für Iconix Sounds (EXPERIMENTELL)
 *
 * Läuft als systemd-Dienst (Root-Tool des mgu-store) auf dem Head Unit mit dessen Node 8.
 * Empfängt von der App über einen Unix-Socket Drehzahl/Last/Tempo und Einstellungen,
 * erzeugt den Sound mit synth.js und gibt ihn über ein vorhandenes Abspielprogramm aus
 * (aplay / pacat / pw-cat / gst-launch-1.0). Welches davon auf dem Head Unit existiert und ob
 * der Ton über die Fahrzeuglautsprecher hörbar ist, ist NICHT dokumentiert und muss im Auto
 * getestet werden. Die App zeigt den Status unten links an.
 *
 * Kommandozeile (auch am PC nutzbar):
 *   node iconix-audiod.js                     Dienst starten
 *   node iconix-audiod.js --probe             verfügbare Abspielprogramme anzeigen
 *   node iconix-audiod.js --play-test         6 s Test-Sweep direkt abspielen
 *   node iconix-audiod.js --wav out.wav [--profile v8] [--seconds 10] [--pops] [--volume 0.8]
 *                                             Fahrt-Sweep als WAV-Datei rendern (zum Anhören am PC)
 *
 * Umgebungsvariablen:
 *   ICONIX_AUDIOD_SOCKET  Socket-Pfad (Standard /run/iconix-audiod/audiod.sock, systemd RuntimeDirectory)
 *   ICONIX_RATE           Abtastrate (Standard 44100)
 *   ICONIX_PLAYER         eigenes Abspielkommando, z. B. "aplay -D hw:0,0 -q -t raw -f S16_LE -r {rate} -c 2 -"
 *   ICONIX_DEVICE         ALSA-Gerät für aplay (-D)
 *
 * Nur Node-8-kompatible Syntax verwenden.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const cp = require('child_process');
const Synth = require('./synth');
const Profiles = require('./profiles');

const VERSION = '0.1.0';
const RATE = Number(process.env.ICONIX_RATE) || 44100;
const SOCKET = process.env.ICONIX_AUDIOD_SOCKET || '/run/iconix-audiod/audiod.sock';
const TICK_MS = 20;          // 50 Wakeups/s (Blöcke à 882 Samples) – schont die CPU
const LEAD_MS = 80;          // so viel Audio liegt höchstens vor (muss > TICK_MS + Jitter sein)
const STALE_MS = 1500;       // ohne Daten -> ausblenden
const IDLE_STOP_MS = 8000;   // so lange still -> Abspielprogramm beenden (gibt das Audiogerät frei)
const MAX_CHUNK = 4096;

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log(new Date().toISOString() + ' iconix-audiod: ' + args.join(' '));
}

// ---------------------------------------------------------------------------
// Abspielprogramme
// ---------------------------------------------------------------------------
const BACKENDS = [
  {
    name: 'aplay', bin: 'aplay',
    args: function (r) {
      const a = ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', String(r), '-c', '2', '--buffer-time=100000'];
      if (process.env.ICONIX_DEVICE) a.push('-D', process.env.ICONIX_DEVICE);
      a.push('-');
      return a;
    }
  },
  {
    name: 'pacat', bin: 'pacat',
    args: function (r) { return ['--playback', '--raw', '--format=s16le', '--rate=' + r, '--channels=2', '--latency-msec=60']; }
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
const SEARCH = (process.env.PATH || '').split(path.delimiter)
  .concat(['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin', '/opt/bin']);

function findBin(bin) {
  for (let i = 0; i < SEARCH.length; i++) {
    if (!SEARCH[i]) continue;
    const p = path.join(SEARCH[i], bin);
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
function Output(onState) {
  this.onState = onState;
  this.list = candidates();
  this.bad = {};
  this.child = null;
  this.backend = null;
  this.blocked = false;
  this.error = this.list.length ? null : 'kein Abspielprogramm gefunden (aplay/pacat/pw-cat/gst)';
  this.lastErr = '';
}

Output.prototype.start = function () {
  if (this.child) return true;
  const self = this;
  const b = this.list.filter(function (x) { return !self.bad[x.name]; })[0];
  if (!b) {
    this.error = this.list.length ? 'alle Abspielprogramme fehlgeschlagen' + (this.lastErr ? ': ' + this.lastErr : '') : this.error;
    this.onState();
    return false;
  }
  log('starte', b.name, b.path, b.argv.join(' '));
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
    if (line) { self.lastErr = line.slice(0, 120); log(b.name + ':', line); }
  });
  child.stdin.on('error', function () { /* EPIPE -> exit folgt */ });
  child.stdin.on('drain', function () { self.blocked = false; });
  child.on('error', function (e) { self.lastErr = e.message; });
  child.on('exit', function (code, sig) {
    log(b.name, 'beendet, code', code, 'signal', sig);
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
// Dienst
// ---------------------------------------------------------------------------
function runDaemon() {
  const synth = new Synth(RATE);
  let lastParams = 0;
  let testUntil = 0, testStart = 0;
  let silentSince = 0;
  let t0 = 0, written = 0;
  const f32 = new Float32Array(MAX_CHUNK * 2);
  const clients = new Set();

  const out = new Output(function () { broadcast(false); });

  function status() {
    return {
      op: 'status', version: VERSION, ok: !out.error, backend: out.backend || (out.list[0] && !out.error ? out.list[0].name : null),
      rate: RATE, playing: !!out.child, error: out.error, profile: synth.cfg.profile
    };
  }
  let lastLine = '', lastSent = 0;
  function broadcast(onlyIfChanged) {
    const line = JSON.stringify(status()) + '\n';
    const now = Date.now();
    if (onlyIfChanged && line === lastLine && now - lastSent < 5000) return;
    lastLine = line; lastSent = now;
    clients.forEach(function (c) { try { c.write(line); } catch (e) { /* egal */ } });
  }

  function onMessage(m) {
    if (!m || typeof m !== 'object') return;
    if (m.op === 'params') { synth.setParams(m); lastParams = Date.now(); }
    else if (m.op === 'config') { synth.configure(m.cfg); broadcast(false); }
    else if (m.op === 'test') { testStart = Date.now(); testUntil = testStart + 9000; out.bad = {}; out.error = out.list.length ? null : out.error; }
    else if (m.op === 'hello') log('App verbunden:', m.id, m.version);
  }

  // Socket (Ordner legt normalerweise systemd an: RuntimeDirectory=iconix-audiod)
  if (SOCKET.indexOf('\\\\.\\pipe\\') !== 0) {
    try { fs.mkdirSync(path.dirname(SOCKET), 493 /* 0755 */); } catch (e) { /* gibt es schon */ }
    try { fs.unlinkSync(SOCKET); } catch (e) { /* gab keinen */ }
  }
  const server = net.createServer(function (sock) {
    clients.add(sock);
    sock.setEncoding('utf8');
    let rx = '';
    sock.on('data', function (d) {
      rx += d;
      let i;
      while ((i = rx.indexOf('\n')) >= 0) {
        const line = rx.slice(0, i); rx = rx.slice(i + 1);
        if (!line) continue;
        try { onMessage(JSON.parse(line)); } catch (e) { /* kaputte Zeile ignorieren */ }
      }
      if (rx.length > 65536) rx = '';
    });
    sock.on('error', function () { /* close folgt */ });
    sock.on('close', function () { clients.delete(sock); });
    try { sock.write(JSON.stringify(status()) + '\n'); } catch (e) { /* egal */ }
  });
  server.listen(SOCKET, function () {
    try { fs.chmodSync(SOCKET, 438 /* 0666: die App läuft ohne Root */); } catch (e) { log('chmod:', e.message); }
    log('Version', VERSION, 'lauscht auf', SOCKET, '–', out.list.length ? 'Ausgabe: ' + out.list.map(function (b) { return b.name; }).join(', ') : out.error);
  });
  server.on('error', function (e) { log('Socket-Fehler:', e.message); process.exit(1); });

  // Taktgeber
  setInterval(function () {
    const now = Date.now();
    const testing = now < testUntil;
    if (testing) {
      synth.setParams(sweepAt((now - testStart) / 1000, synth.cfg));
      synth.stale = false;
    } else {
      synth.stale = now - lastParams > STALE_MS;
    }
    const wantSound = synth.cfg.enabled && (!synth.stale || testing);

    if (wantSound) silentSince = 0;
    else if (!silentSince) silentSince = now;

    if (wantSound && !out.child && !out.error) {
      if (out.start()) { t0 = now; written = 0; }
    }
    if (out.child && silentSince && now - silentSince > IDLE_STOP_MS && synth.gain < 0.001) {
      log('still – gebe Audiogerät frei');
      out.stop();
    }
    if (!out.child) return;

    let due = Math.floor((now - t0 + LEAD_MS) / 1000 * RATE) - written;
    if (due > RATE / 2) { t0 = now; written = 0; due = Math.floor(LEAD_MS / 1000 * RATE); } // Resync nach Hänger
    while (due > 0 && !out.blocked && out.child) {
      const n = Math.min(due, MAX_CHUNK);
      synth.render(f32, n);
      out.write(toPcm(f32, n));
      written += n; due -= n;
    }
  }, TICK_MS);

  setInterval(function () { broadcast(true); }, 1000);

  function shutdown() {
    log('beende');
    out.stop();
    try { server.close(); fs.unlinkSync(SOCKET); } catch (e) { /* egal */ }
    setTimeout(function () { process.exit(0); }, 400);
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', function (e) { log('Fehler:', e && e.stack || e); });
}

// ---------------------------------------------------------------------------
// Werkzeuge
// ---------------------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && process.argv[i + 1].indexOf('--') !== 0 ? process.argv[i + 1] : def;
}

function renderWav(file) {
  const profile = arg('--profile', Profiles.DEFAULT);
  const seconds = Number(arg('--seconds', '9'));
  const synth = new Synth(RATE);
  synth.configure({
    profile: profile, volume: Number(arg('--volume', '0.8')), pops: process.argv.indexOf('--pops') >= 0,
    intensity: Number(arg('--intensity', '0.7'))
  });
  synth._setProfile(Profiles.get(profile).id); synth.pending = null;
  const frames = Math.floor(seconds * RATE);
  const pcm = Buffer.alloc(frames * 4);
  const block = 512, f32 = new Float32Array(block * 2);
  let peak = 0;
  for (let pos = 0; pos < frames; pos += block) {
    const n = Math.min(block, frames - pos);
    synth.setParams(sweepAt(pos / RATE, synth.cfg));
    peak = Math.max(peak, synth.render(f32, n));
    toPcm(f32, n).copy(pcm, pos * 4);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
  console.log(file + ': ' + Profiles.get(profile).name + ', ' + seconds + ' s, Spitze ' + peak.toFixed(3));
}

function playTest() {
  const out = new Output(function () {});
  if (!out.start()) { console.error('Kein Abspielprogramm: ' + out.error); process.exit(1); }
  const synth = new Synth(RATE);
  synth.configure({ profile: arg('--profile', Profiles.DEFAULT), volume: 0.7 });
  const f32 = new Float32Array(MAX_CHUNK * 2);
  const start = Date.now();
  let written = 0;
  const timer = setInterval(function () {
    const el = Date.now() - start;
    if (el > 9500 || !out.child) { clearInterval(timer); out.stop(); setTimeout(function () { process.exit(0); }, 500); return; }
    synth.setParams(sweepAt(el / 1000, synth.cfg));
    let due = Math.floor((el + LEAD_MS) / 1000 * RATE) - written;
    while (due > 0 && !out.blocked) { const n = Math.min(due, MAX_CHUNK); synth.render(f32, n); out.write(toPcm(f32, n)); written += n; due -= n; }
  }, TICK_MS);
}

if (require.main === module) {
  if (process.argv.indexOf('--probe') >= 0) {
    const list = candidates();
    console.log(list.length ? list.map(function (b) { return b.name + '  ' + b.path + ' ' + b.argv.join(' '); }).join('\n') : 'Kein Abspielprogramm gefunden.');
  } else if (process.argv.indexOf('--wav') >= 0) {
    renderWav(arg('--wav', 'iconix.wav'));
  } else if (process.argv.indexOf('--play-test') >= 0) {
    playTest();
  } else {
    runDaemon();
  }
}

module.exports = { sweepAt: sweepAt, toPcm: toPcm, candidates: candidates };
