'use strict';
/*
 * Iconix Sounds – Verbindung von der App zum Audio-Daemon (Tool iconix-audiod)
 *
 * Protokoll: Unix-Socket, eine JSON-Nachricht pro Zeile.
 *   App -> Daemon: {"op":"hello","id":"iconix_sounds","version":"0.1.0"}
 *                  {"op":"config","cfg":{profile, volume, intensity, pops, sport, enabled, carIdle, carRedline}}
 *                  {"op":"params","rpm":2500,"load":0.4,"speed":80,"overrun":false}
 *                  {"op":"test"}            (Drehzahl-Sweep zum Testen)
 *   Daemon -> App: {"op":"status","ok":true,"backend":"aplay","rate":44100,"playing":true,"error":null}
 */
const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.ICONIX_AUDIOD_SOCKET || '/run/iconix-audiod/audiod.sock';
const RECONNECT_MS = 2000;
const SEND_MS = 50;      // 20 Hz Parameter-Updates
const STALE_MS = 1500;   // ältere Fahrzeugdaten nicht senden -> Daemon blendet aus

class AudioLink extends EventEmitter {
  constructor(log, appVersion) {
    super();
    this.log = log;
    this.version = appVersion || '0';
    this.sock = null;
    this.connected = false;
    this.rx = '';
    this.cfg = null;
    this.latest = null;
    this.status = { ok: false, text: 'Audio-Dienst nicht verbunden' };
    this.timer = null;
    this.reconnectTimer = null;
    this.closed = false;
  }

  connect() {
    if (this.closed || this.sock) return;
    const s = net.createConnection(SOCKET);
    this.sock = s;
    s.setEncoding('utf8');
    s.on('connect', () => {
      this.connected = true;
      this._setStatus({ ok: true, text: 'Audio-Dienst verbunden' });
      this.send({ op: 'hello', id: 'iconix_sounds', version: this.version });
      if (this.cfg) this.send({ op: 'config', cfg: this.cfg });
      if (!this.timer) this.timer = setInterval(() => this._tick(), SEND_MS);
    });
    s.on('data', chunk => {
      this.rx += chunk;
      let i;
      while ((i = this.rx.indexOf('\n')) >= 0) {
        const line = this.rx.slice(0, i);
        this.rx = this.rx.slice(i + 1);
        if (line) this._onMessage(line);
      }
      if (this.rx.length > 65536) this.rx = '';
    });
    s.on('error', () => { /* close folgt */ });
    s.on('close', () => {
      const was = this.connected;
      this.sock = null;
      this.connected = false;
      if (was || this.status.ok) this._setStatus({ ok: false, text: 'Audio-Dienst nicht verbunden (Tool iconix-audiod installiert?)' });
      if (!this.closed && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, RECONNECT_MS);
      }
    });
  }

  close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) this.sock.destroy();
  }

  send(obj) {
    if (!this.sock || !this.connected) return false;
    try { this.sock.write(JSON.stringify(obj) + '\n'); return true; } catch (e) { return false; }
  }

  configure(cfg) {
    this.cfg = cfg;
    this.send({ op: 'config', cfg: cfg });
  }

  params(sample) { this.latest = sample; }

  test() { return this.send({ op: 'test' }); }

  _tick() {
    const p = this.latest;
    const now = Date.now();
    if (!p || now - p.at > STALE_MS) return;
    // gerundet senden und Unverändertes nur als Keepalive alle 500 ms
    const rpm = Math.round(p.rpm), load = Math.round(p.load * 1000) / 1000, speed = Math.round(p.speed * 10) / 10;
    const key = rpm + '|' + load + '|' + speed + '|' + (p.overrun ? 1 : 0);
    if (key === this.lastKey && now - this.lastSend < 500) return;
    this.lastKey = key; this.lastSend = now;
    this.send({ op: 'params', rpm: rpm, load: load, speed: speed, overrun: p.overrun });
  }

  _onMessage(line) {
    let m;
    try { m = JSON.parse(line); } catch (e) { return; }
    if (m.op !== 'status') return;
    let text;
    if (m.error) text = 'Audio: ' + m.error;
    else if (m.backend) text = 'Audio: ' + m.backend + ' · ' + String((m.rate || 44100) / 1000).replace('.', ',') + ' kHz' + (m.playing ? ' · spielt' : ' · bereit');
    else text = 'Audio-Dienst verbunden';
    this._setStatus({ ok: !m.error && !!m.backend, text: text, raw: m });
  }

  _setStatus(st) {
    this.status = st;
    this.emit('status', st);
  }
}

module.exports = AudioLink;
module.exports.SOCKET = SOCKET;
