'use strict';
/*
 * Iconix Sounds – Tonweg zu den Fahrzeuglautsprechern über den BMW-Audiomanager (GENIVI AM)
 *
 * Ton, der in einen SmartX-Kanal geschrieben wird (ALSA "plug:smartx:<Kanal>"), ist erst hörbar, wenn der
 * Audiomanager die passende Quelle mit einer Lautsprecher-Senke verbindet. Diese Verbindung fordert die App
 * hier an (SOME/IP, app.json "signals": org.genivi.am.*), den Ton selbst schreibt der Dienst iconix-audiod.
 *
 * Wege (ROUTES) zum Ausprobieren im Auto – Quellen-/Senken-Nummern so, wie sie andere Projekte für das
 * iDrive 7 dokumentiert haben (M850i-amn/idrive7-apps, loenne007/idrive-enginesound, Moonride):
 *   287  CarLifeMedia (SmartXbar-Eingang für CarLife, außerhalb Chinas frei)   -> exklusiv, Musik pausiert
 *   1048 OAPGenericOverlay (Kanal Media_Overlay_Converter_Source, 24 kHz mono) -> Mix über der Musik
 *   288  CarLifeNavigation                                                      -> Mix wie eine Navi-Ansage
 *   1024 MediaSink_Front, 1 MainSink
 *
 * Eigene Verbindungen werden mit der Boot-ID in dataDir/iconix_route.json gemerkt; nach einem App-Neustart
 * im selben Boot wird eine liegengebliebene eigene Verbindung zuerst getrennt.
 *
 * Nur Node-8-kompatible Syntax.
 */
const fs = require('fs');
const path = require('path');

const AM = 'org.genivi.am.commandinterface.CommandControl';
const AMR = 'org.genivi.am.routinginterface.RoutingControlObserver';
const INSTANCE = '1';
const SINK_FRONT = 1024, SINK_MAIN = 1;
const CHECK_MS = 1500;      // Takt der Steuerung
const VERIFY_MS = 5000;     // so oft prüfen, ob die eigene Verbindung noch besteht
const RETRY_MS = 5000;      // nach einem Fehler so lange warten
const CALL_MS = 5000;

// device: Kanal für den Dienst. "smartx:<Name>" löst der Dienst gegen die Kanäle in /dev/shm auf
// (exakter Name oder erster Kanal, der mit <Name>_ beginnt) und öffnet "plug:smartx:<Kanal>".
const ROUTES = {
  overlay:     { label: 'Overlay-Mix', source: 1048, sink: SINK_FRONT, mark: false, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' },
  carlife:     { label: 'CarLife exklusiv', source: 287, sink: SINK_FRONT, mark: true, device: 'smartx:CarLifeMedia_CF_48_STEREO' },
  carlifeNav:  { label: 'CarLife-Navi-Mix', source: 288, sink: SINK_FRONT, mark: true, device: 'smartx:CarLifeNavigation' },
  overlayMain: { label: 'Overlay MainSink', source: 1048, sink: SINK_MAIN, mark: false, device: 'smartx:Media_Overlay_Converter_Source_CF_24_MONO' },
  carlifeMain: { label: 'CarLife MainSink', source: 287, sink: SINK_MAIN, mark: true, device: 'smartx:CarLifeMedia_CF_48_STEREO' },
  carplay:     { label: 'CarPlay-Kanal', source: null, sink: null, mark: false, device: 'smartx:CarPlayMain_CF_48_STEREO' },
  alsa:        { label: 'ALSA direkt', source: null, sink: null, mark: false, device: null }
};
const DEFAULT_ROUTE = 'overlay';
const CS = ['CS_UNKNOWN', 'CS_CONNECTING', 'CS_CONNECTED', 'CS_DISCONNECTING', 'CS_DISCONNECTED', 'CS_SUSPENDED'];

function bootId() {
  try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; }
}
function okReply(r) {
  const e = r && typeof r === 'object' ? r.amError : r;
  return e === undefined || e === 'E_OK' || e === 0 || e === 'E_ALREADY_EXISTS';
}
function errOf(r) {
  const e = r && typeof r === 'object' ? r.amError : r;
  return e === undefined ? null : String(e);
}
/** Erstes Array im Ergebnis (listMainConnections, listConnections, listMainSources ...). */
function listOf(r, prefer) {
  if (Array.isArray(r)) return r;
  if (!r || typeof r !== 'object') return [];
  for (let i = 0; i < prefer.length; i++) if (Array.isArray(r[prefer[i]])) return r[prefer[i]];
  const k = Object.keys(r).filter(function (x) { return Array.isArray(r[x]); })[0];
  return k ? r[k] : [];
}
function csName(v) { return typeof v === 'number' ? (CS[v] || String(v)) : String(v); }

class CarRoute {
  /**
   * @param signals  kit/runtime/signals (proxy, call); ohne native SOME/IP bleibt alles aus
   * @param log      ctx.log
   * @param dataDir  Ordner für iconix_route.json
   */
  constructor(signals, log, dataDir) {
    this.signals = signals;
    this.log = log || console;
    this.file = dataDir ? path.join(dataDir, 'iconix_route.json') : null;
    this.am = null; this.amr = null; this.proxyErr = null;
    this.routeId = DEFAULT_ROUTE;
    this.wanted = false;
    this.conn = null;           // { id, routeId, source, sink }
    this.state = 'aus';
    this.connState = null;
    this.lastError = null;
    this.busy = false;
    this.nextTry = 0; this.lastVerify = 0;
    this.timer = null;
    this.cleanupDone = false;
  }

  static routes() { return ROUTES; }
  static route(id) { return ROUTES[id] || ROUTES[DEFAULT_ROUTE]; }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._step(), CHECK_MS);
    this._step();
  }

  /** Gewünschten Weg und ob gerade Ton gebraucht wird setzen; die Steuerung folgt im nächsten Takt. */
  want(routeId, on) {
    const id = ROUTES[routeId] ? routeId : DEFAULT_ROUTE;
    if (id !== this.routeId) { this.routeId = id; this.nextTry = 0; this.lastError = null; }
    if (!!on !== this.wanted) { this.wanted = !!on; this.nextTry = 0; }
  }

  needsAm() { const r = ROUTES[this.routeId]; return !!(r && r.source != null); }

  /** Kurzer Text für die Statuszeile. */
  short() {
    const r = CarRoute.route(this.routeId);
    if (!this.needsAm()) return r.label + ' (ohne Audiomanager)';
    let s = r.label + ': ' + this.state;
    if (this.state === 'verbunden' && this.connState && this.connState !== 'CS_CONNECTED') s += ' (' + this.connState + ')';
    if (this.lastError && this.state !== 'verbunden') s += ' – ' + this.lastError;
    return s;
  }

  async _proxies() {
    if (this.am && this.amr) return true;
    if (!this.signals || !this.signals.proxy) { this.proxyErr = 'kein SOME/IP'; return false; }
    try {
      if (!this.am) this.am = await this.signals.proxy(AM, INSTANCE);
      if (!this.amr) this.amr = await this.signals.proxy(AMR, INSTANCE);
      this.proxyErr = null;
      return true;
    } catch (e) {
      this.proxyErr = 'Audiomanager nicht erreichbar: ' + (e && e.message || e);
      return false;
    }
  }

  _call(p, method, params, ms) { return this.signals.call(p, method, params || {}, ms || CALL_MS); }

  async _connections() {
    const r = await this._call(this.am, 'getListMainConnections', {});
    return listOf(r, ['listMainConnections', 'listConnections']).map(function (c) {
      return { id: c.mainConnectionID, source: c.sourceID, sink: c.sinkID, state: c.connectionState !== undefined ? csName(c.connectionState) : null };
    });
  }

  async _mark(source, on) {
    await this._call(this.amr, 'hookSourceAvailablityStatusChange', {
      sourceID: source, availability: { availability: on ? 'A_AVAILABLE' : 'A_UNAVAILABLE', availabilityReason: 0 }
    });
  }

  _save() {
    if (!this.file) return;
    try {
      if (this.conn) fs.writeFileSync(this.file, JSON.stringify({ mainConnectionID: this.conn.id, source: this.conn.source, sink: this.conn.sink, bootId: bootId() }));
      else fs.unlinkSync(this.file);
    } catch (e) { /* egal */ }
  }

  /** Eine im selben Boot liegengebliebene eigene Verbindung trennen (App wurde neu gestartet). */
  async _cleanup() {
    this.cleanupDone = true;
    if (!this.file) return;
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { saved = null; }
    if (!saved || saved.mainConnectionID == null) return;
    if (saved.bootId && saved.bootId === bootId()) {
      try {
        await this._call(this.am, 'disconnect', { mainConnectionID: saved.mainConnectionID });
        this.log.info('iconix: alte eigene AM-Verbindung ' + saved.mainConnectionID + ' getrennt');
      } catch (e) { /* schon weg */ }
    }
    try { fs.unlinkSync(this.file); } catch (e) { /* egal */ }
  }

  async _step() {
    if (this.busy) return;
    const now = Date.now();
    const target = this.wanted && this.needsAm() ? this.routeId : null;
    const r = target ? ROUTES[target] : null;
    // nichts zu tun?
    if (!target && !this.conn) { this.state = this.lastError ? 'Fehler' : 'aus'; return; }
    if (target && this.conn && this.conn.routeId === target && now - this.lastVerify < VERIFY_MS) return;
    if (target && !this.conn && now < this.nextTry) return;
    this.busy = true;
    try {
      if (!(await this._proxies())) { this.state = 'Fehler'; this.lastError = this.proxyErr; this.nextTry = now + RETRY_MS; return; }
      if (!this.cleanupDone) await this._cleanup();
      // falscher Weg oder nicht mehr gewünscht -> trennen
      if (this.conn && (!target || this.conn.routeId !== target)) await this._disconnect();
      if (!target) { this.state = 'aus'; return; }
      if (this.conn) await this._verify();
      else await this._connect(target, r);
    } catch (e) {
      this.lastError = String(e && e.message || e).slice(0, 80);
      this.state = 'Fehler';
      this.nextTry = Date.now() + RETRY_MS;
      this.log.warn('iconix: Audiomanager: ' + this.lastError);
    } finally {
      this.busy = false;
    }
  }

  async _connect(id, r) {
    this.state = 'verbinde';
    // belegte Verbindungen derselben Quelle übernehmen (Quelle 287/288 nutzt außerhalb Chinas niemand sonst)
    let list = [];
    try { list = await this._connections(); } catch (e) { list = []; }
    const same = list.filter(function (c) { return c.source === r.source; });
    for (let i = 0; i < same.length; i++) {
      if (same[i].sink === r.sink) {
        // besteht schon (z. B. von einem früheren Lauf): übernehmen
        this.conn = { id: same[i].id, routeId: id, source: r.source, sink: r.sink };
        this.connState = same[i].state;
        this.state = 'verbunden'; this.lastError = null; this.lastVerify = Date.now();
        this._save();
        this.log.info('iconix: AM-Verbindung ' + same[i].id + ' (' + r.source + ' -> ' + r.sink + ') übernommen');
        return;
      }
      try { await this._call(this.am, 'disconnect', { mainConnectionID: same[i].id }); } catch (e) { /* egal */ }
      this.log.info('iconix: fremde AM-Verbindung ' + same[i].id + ' der Quelle ' + r.source + ' getrennt');
    }
    if (r.mark) await this._mark(r.source, true);
    const res = await this._call(this.am, 'connect', { sourceID: r.source, sinkID: r.sink });
    if (!okReply(res)) {
      if (r.mark) { try { await this._mark(r.source, false); } catch (e) { /* egal */ } }
      throw new Error('connect ' + r.source + '->' + r.sink + ' abgelehnt: ' + errOf(res));
    }
    let cid = res && res.mainConnectionID;
    if (cid == null) {
      // E_ALREADY_EXISTS oder ohne ID: in der Liste suchen
      try {
        const hit = (await this._connections()).filter(function (c) { return c.source === r.source && c.sink === r.sink; })[0];
        if (hit) { cid = hit.id; this.connState = hit.state; }
      } catch (e) { /* egal */ }
    }
    this.conn = { id: cid, routeId: id, source: r.source, sink: r.sink };
    this.state = 'verbunden'; this.lastError = null; this.lastVerify = Date.now();
    this._save();
    this.log.info('iconix: AM verbunden ' + r.source + ' -> ' + r.sink + ' (' + r.label + '), mainConnectionID ' + cid + ', amError ' + errOf(res));
  }

  async _verify() {
    this.lastVerify = Date.now();
    let list;
    try { list = await this._connections(); } catch (e) { return; } // Liste nicht lesbar: so lassen
    const c = this.conn;
    const hit = list.filter(function (x) { return (c.id != null && x.id === c.id) || (x.source === c.source && x.sink === c.sink); })[0];
    if (!hit) {
      this.log.warn('iconix: AM-Verbindung ' + c.id + ' ist weg – verbinde neu');
      this.conn = null; this.connState = null; this.nextTry = 0; this.state = 'verbinde';
      this._save();
      return;
    }
    if (hit.state !== this.connState) this.log.info('iconix: AM-Verbindung ' + hit.id + ': ' + hit.state);
    this.connState = hit.state;
  }

  async _disconnect() {
    const c = this.conn;
    if (!c) return;
    this.conn = null; this.connState = null;
    this._save();
    if (c.id != null) {
      try { await this._call(this.am, 'disconnect', { mainConnectionID: c.id }); } catch (e) { this.log.warn('iconix: AM disconnect: ' + e); }
    }
    const r = ROUTES[c.routeId];
    if (r && r.mark) {
      let left = [];
      try { left = (await this._connections()).filter(function (x) { return x.source === c.source; }); } catch (e) { left = []; }
      if (!left.length) { try { await this._mark(c.source, false); } catch (e) { /* egal */ } }
    }
    this.log.info('iconix: AM getrennt ' + c.source + ' -> ' + c.sink);
  }

  /** Zeilen für die Audio-Diagnose: Weg, Verbindung, Quellen und Senken des Audiomanagers. */
  async diagLines() {
    const r = CarRoute.route(this.routeId);
    const out = ['--- Tonweg (Audiomanager) ---', 'Weg: ' + r.label + (r.source != null ? ' · Quelle ' + r.source + ' -> Senke ' + r.sink : '') +
      (r.device ? ' · Kanal ' + r.device.replace(/^smartx:/, '') : '')];
    out.push('Status: ' + this.short() + (this.conn ? ' · ID ' + this.conn.id : ''));
    if (!(await this._proxies())) { out.push(this.proxyErr); return out; }
    const fmt = (a, idKey) => a.map(function (x) { return x[idKey] + ' ' + (x.name || ''); }).join(', ');
    try {
      const conns = await this._connections();
      out.push('Verbindungen: ' + (conns.length ? conns.map(function (c) { return c.id + ': ' + c.source + '->' + c.sink + (c.state ? ' ' + c.state.replace('CS_', '') : ''); }).join(', ') : 'keine'));
    } catch (e) { out.push('Verbindungen: ' + e); }
    try {
      const src = listOf(await this._call(this.am, 'getListMainSources', {}, 3000), ['listMainSources']);
      out.push('Quellen: ' + (fmt(src, 'sourceID') || 'keine'));
    } catch (e) { out.push('Quellen: ' + e); }
    try {
      const snk = listOf(await this._call(this.am, 'getListMainSinks', {}, 3000), ['listMainSinks']);
      out.push('Senken: ' + (fmt(snk, 'sinkID') || 'keine'));
    } catch (e) { out.push('Senken: ' + e); }
    return out;
  }
}

module.exports = CarRoute;
module.exports.ROUTES = ROUTES;
module.exports.DEFAULT_ROUTE = DEFAULT_ROUTE;
