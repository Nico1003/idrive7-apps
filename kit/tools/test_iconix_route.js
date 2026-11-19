'use strict';
/**
 * Tests für Iconix Sounds 0.6: Audiomanager-Tonweg (car_route.js) gegen einen nachgebauten Audiomanager
 * und die SmartX-Ausgabe des Dienstes (engine.js: Kanal auflösen, Format, Umrechnung).
 *
 *   node kit/tools/test_iconix_route.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CarRoute = require(path.join(ROOT, 'apps/iconix_sounds/car_route.js'));
const E = require(path.join(ROOT, 'tools/iconix-audiod/engine.js'));

// ---- nachgebauter Audiomanager ------------------------------------------------
function fakeAm(opts) {
  opts = opts || {};
  const am = { conns: opts.conns || [], nextId: 50, calls: [], avail: {} };
  const signals = {
    proxy: async (iface, inst) => {
      assert.strictEqual(inst, '1');
      if (opts.noProxy) throw new Error('no SOME/IP config');
      return { iface };
    },
    call: async (p, method, params) => {
      am.calls.push(method + ' ' + JSON.stringify(params));
      if (method === 'getListMainConnections') return { listConnections: am.conns.map((c) => Object.assign({}, c)) };
      if (method === 'getListMainSources') return { listMainSources: [{ sourceID: 287, name: 'CarLifeMedia' }, { sourceID: 1048, name: 'OAPGenericOverlay' }] };
      if (method === 'getListMainSinks') return { listMainSinks: [{ sinkID: 1024, name: 'MediaSink_Front' }] };
      if (method === 'hookSourceAvailablityStatusChange') { am.avail[params.sourceID] = params.availability.availability; return {}; }
      if (method === 'connect') {
        if (opts.refuse) return { amError: 'E_NOT_POSSIBLE', mainConnectionID: null };
        const id = am.nextId++;
        am.conns.push({ mainConnectionID: id, sourceID: params.sourceID, sinkID: params.sinkID, connectionState: 2 });
        return { amError: 'E_OK', mainConnectionID: id };
      }
      if (method === 'disconnect') { am.conns = am.conns.filter((c) => c.mainConnectionID !== params.mainConnectionID); return { amError: 'E_OK' }; }
      throw new Error('unbekannt ' + method);
    }
  };
  return { am, signals };
}
const quiet = { info() {}, warn() {} };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route-'));

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('Overlay-Mix verbindet 1048 -> 1024 ohne Verfügbarkeitsmeldung und trennt wieder', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, tmp);
  r.want('overlay', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[1048, 1024]]);
  assert.strictEqual(am.avail[1048], undefined);
  assert.ok(fs.existsSync(path.join(tmp, 'iconix_route.json')));
  r.want('overlay', false);
  await r._step();
  assert.strictEqual(am.conns.length, 0);
  assert.strictEqual(r.state, 'aus');
  assert.ok(!fs.existsSync(path.join(tmp, 'iconix_route.json')));
});

test('CarLife exklusiv meldet 287 verfügbar, übernimmt fremde 287-Verbindung, meldet beim Trennen unverfügbar', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 7, sourceID: 287, sinkID: 1, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('carlife', true);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[287, 1024]]);
  assert.strictEqual(am.avail[287], 'A_AVAILABLE');
  r.want('carlife', false);
  await r._step();
  assert.strictEqual(am.avail[287], 'A_UNAVAILABLE');
});

test('Wegwechsel trennt den alten Weg zuerst', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  r.want('carlifeNav', true); await r._step();
  assert.deepStrictEqual(am.conns.map((c) => [c.sourceID, c.sinkID]), [[288, 1024]]);
});

test('bestehende passende Verbindung wird übernommen, verschwundene neu aufgebaut', async () => {
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 9, sourceID: 1048, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  assert.strictEqual(r.conn.id, 9);
  assert.ok(!am.calls.some((c) => c.indexOf('connect {') === 0));
  am.conns = [];          // z. B. vom System getrennt
  r.lastVerify = 0; await r._step();
  assert.strictEqual(r.conn, null);
  await r._step();
  assert.strictEqual(r.state, 'verbunden');
  assert.strictEqual(am.conns.length, 1);
});

test('Ablehnung und fehlendes SOME/IP werden als Fehler angezeigt, ohne zu werfen', async () => {
  const a = fakeAm({ refuse: true });
  const r = new CarRoute(a.signals, quiet, null);
  r.want('carlife', true); await r._step();
  assert.strictEqual(r.state, 'Fehler');
  assert.ok(/E_NOT_POSSIBLE/.test(r.short()), r.short());
  assert.strictEqual(a.am.avail[287], 'A_UNAVAILABLE');
  const b = fakeAm({ noProxy: true });
  const r2 = new CarRoute(b.signals, quiet, null);
  r2.want('overlay', true); await r2._step();
  assert.ok(/nicht erreichbar/.test(r2.short()), r2.short());
  const r3 = new CarRoute(null, quiet, null);
  r3.want('overlay', true); await r3._step();
  assert.strictEqual(r3.state, 'Fehler');
});

test('Wege ohne Audiomanager machen keine Aufrufe', async () => {
  const { am, signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('carplay', true); await r._step();
  r.want('alsa', true); await r._step();
  assert.strictEqual(am.calls.length, 0);
  assert.ok(/ohne Audiomanager/.test(r.short()));
});

test('liegengebliebene eigene Verbindung desselben Boots wird beim Start getrennt', async () => {
  const boot = (() => { try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch (e) { return null; } })();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iconix-route2-'));
  fs.writeFileSync(path.join(dir, 'iconix_route.json'), JSON.stringify({ mainConnectionID: 33, bootId: boot }));
  const { am, signals } = fakeAm({ conns: [{ mainConnectionID: 33, sourceID: 287, sinkID: 1024, connectionState: 2 }] });
  const r = new CarRoute(signals, quiet, dir);
  r.want('overlay', true); await r._step();
  if (boot) assert.ok(!am.conns.some((c) => c.mainConnectionID === 33));
  else assert.ok(am.conns.some((c) => c.mainConnectionID === 33)); // ohne Boot-ID (Windows) nichts anfassen
});

test('Diagnose listet Verbindungen, Quellen und Senken', async () => {
  const { signals } = fakeAm();
  const r = new CarRoute(signals, quiet, null);
  r.want('overlay', true); await r._step();
  const lines = (await r.diagLines()).join('\n');
  assert.ok(/1048->1024 CONNECTED/.test(lines), lines);
  assert.ok(/287 CarLifeMedia/.test(lines) && /1024 MediaSink_Front/.test(lines), lines);
});

test('SmartX: Kanal auflösen, Format aus dem Namen, kein Rückfall auf andere Geräte', () => {
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_24_MONO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO');
  assert.strictEqual(E.resolveSmartx('smartx:Media_Overlay_Converter_Source_CF_24_MONO', ['Media_Overlay_Converter_Source_CF_48_STEREO']),
    'plug:smartx:Media_Overlay_Converter_Source_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('smartx:CarLifeNavigation', []), 'plug:smartx:CarLifeNavigation_CF_48_STEREO');
  assert.strictEqual(E.resolveSmartx('plughw:0,0', []), 'plughw:0,0');
  assert.deepStrictEqual(E.formatOf('plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO'), { rate: 24000, ch: 1 });
  assert.deepStrictEqual(E.formatOf('plug:smartx:CarLifeMedia_CF_48_STEREO'), { rate: 48000, ch: 2 });
  process.env.ICONIX_PYTHON = process.execPath; // irgendein vorhandenes Programm als "Python"
  const c = E.candidates({ device: 'plug:smartx:CarLifeMedia_CF_48_STEREO' });
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].argv.slice(1), ['play', 'plug:smartx:CarLifeMedia_CF_48_STEREO', '48000', '40000', '2']);
  const m = E.candidates({ device: 'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO' });
  assert.deepStrictEqual(m[0].argv.slice(3), ['24000', '40000', '1']);
});

test('Umrechnung 48 -> 24 kHz: Tiefpass gegen Aliasing, tiefe Töne bleiben', () => {
  const tone = (hz, n) => { const f = new Float32Array(n * 2); for (let i = 0; i < n; i++) f[i * 2] = f[i * 2 + 1] = 0.5 * Math.sin(2 * Math.PI * hz * i / 48000); return f; };
  const rms = (b) => { let s = 0; const m = b.length / 2; for (let i = m / 2; i < m; i++) { const v = b.readInt16LE(i * 2) / 32767; s += v * v; } return Math.sqrt(s / (m / 2)); };
  const n = 9600;
  const low = E.toPcmFmt(tone(500, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2));
  const high = E.toPcmFmt(tone(18000, n), n, { rate: 24000, ch: 1 }, new E.Decimator(2)); // würde als 6 kHz zurückfallen
  assert.strictEqual(low.length, n); // n/2 Frames x 2 Byte
  assert.ok(rms(low) > 0.3, 'tiefer Ton bleibt: ' + rms(low));
  assert.ok(rms(high) < 0.005, '18 kHz wird unterdrückt: ' + rms(high));
  // Zustand über Blöcke: zwei halbe Blöcke = ein ganzer
  const dec = new E.Decimator(2), t = tone(500, n);
  const a = E.toPcmFmt(t.subarray(0, n), n / 2, { rate: 24000, ch: 1 }, dec);
  const b = E.toPcmFmt(t.subarray(n), n / 2, { rate: 24000, ch: 1 }, dec);
  assert.ok(Buffer.concat([a, b]).equals(low));
  assert.strictEqual(E.toPcmFmt(t, n, { rate: 48000, ch: 2 }).length, n * 4);
});

// ---- Synthese (synth.js v2) ----------------------------------------------------
const Synth = require(path.join(ROOT, 'tools/iconix-audiod/synth.js'));
const Profiles = require(path.join(ROOT, 'tools/iconix-audiod/profiles.js'));
function drive(id, sr, secs, fn) {
  const s = new Synth(sr);
  s.configure({ profile: id, volume: 1, intensity: 0.7 });
  s._setProfile(id); s.pending = null; s._reset();
  const blk = Math.round(sr / 100), f = new Float32Array(blk * 2), out = new Float32Array(Math.round(secs * sr));
  let peak = 0;
  for (let pos = 0; pos + blk <= out.length; pos += blk) {
    s.setParams(fn(pos / sr));
    peak = Math.max(peak, s.render(f, blk));
    for (let i = 0; i < blk; i++) out[pos + i] = f[i * 2];
  }
  return { out, peak };
}
function bandShare(x, sr, hz) { // Energieanteil oberhalb hz (einfache DFT über Stichproben-Frequenzen)
  let hi = 0, tot = 0;
  for (let f = 20; f < sr / 2; f *= 1.06) {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i += 1) { const w = 2 * Math.PI * f * i / sr; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); }
    const p = (re * re + im * im) * f; tot += p; if (f > hz) hi += p;
  }
  return hi / tot;
}

test('alle Profile: kein NaN, kein Übersteuern, kaum Energie über 2 kHz (nichts Schrilles)', () => {
  for (const id of Profiles.ids) {
    const r = drive(id, 24000, 5, (t) => t < 1 ? { rpm: 800, load: 0.05, speed: 0 } : { rpm: 1200 + 3500 * (t - 1) / 4, load: 1, speed: 30 + 60 * t / 5 });
    assert.ok(r.out.every((v) => v === v), id + ': NaN');
    assert.ok(r.peak <= 1 && r.peak > 0.05, id + ': Spitze ' + r.peak);
    const share = bandShare(r.out.subarray(r.out.length - 4800), 24000, 2000);
    assert.ok(share < 0.08, id + ': ' + (share * 100).toFixed(1) + ' % über 2 kHz');
  }
});

test('Verbrenner: Grundton = Zündfrequenz der virtuellen Drehzahl (Profil-Abbildung)', () => {
  const s = new Synth(24000);
  s.configure({ profile: 'six', carIdle: 800, carRedline: 4800 });
  s._setProfile('six');
  const p = Profiles.get('six');
  assert.strictEqual(s._virtualRpm(800), p.idleRpm);
  assert.strictEqual(s._virtualRpm(4800), p.maxRpm);
  assert.ok(p.maxRpm <= 6500, 'Drehzahlband nur leicht gestreckt');
  // Zündfrequenz eines Reihensechsers bei 3000 U/min = 150 Hz: dort deutlich mehr Energie als bei 1000 Hz
  const r = drive('six', 24000, 1.2, () => ({ rpm: 800 + (3000 - 750) / (6000 - 750) * 4000, load: 0.8, speed: 80 }));
  const x = r.out.subarray(4800);
  const at = (f) => { let re = 0, im = 0; for (let i = 0; i < x.length; i++) { const w = 2 * Math.PI * f * i / 24000; re += x[i] * Math.cos(w); im += x[i] * Math.sin(w); } return Math.hypot(re, im); };
  assert.ok(at(150) > 5 * at(1000), 'Zündfrequenz dominiert: ' + at(150).toFixed(1) + ' vs ' + at(1000).toFixed(1));
});

test('Schub leiser als Last, ohne Übersteuern', () => {
  const r = drive('v8', 24000, 9, (t) => t < 6 ? { rpm: 1100 + 3700 * t / 6, load: 1, speed: 80 } : { rpm: 4800 - 3200 * (t - 6) / 3, load: 0, overrun: true, speed: 90 });
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  const wot = rms(r.out.subarray(24000 * 3, 24000 * 6)), ovr = rms(r.out.subarray(24000 * 6.3));
  assert.ok(ovr < wot * 0.7 && ovr > wot * 0.1, 'Schub ' + ovr.toFixed(3) + ' vs Last ' + wot.toFixed(3));
  assert.ok(r.peak <= 1);
});

test('keine Knackser: niedrige Drehzahl unter Last, Schaltknicke, Gas weg (Spitzenfaktor im Hochpass)', () => {
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const r = drive(id, 24000, 6, (t) => {
      if (t < 4) { const g = t % 1; return { rpm: 1300 + 800 * g, load: g < 0.22 ? 0.25 : 1, speed: 50 }; }
      return { rpm: 2600, load: t < 4.05 ? 1 : 0, overrun: t > 4.05, speed: 80 };
    });
    // Hochpass über die ganze Fahrt (Filter eingeschwungen), Spitze/RMS je 50 ms ab 0,5 s
    const hp = new Synth.Biquad().set('hp', 1000, 0.7, 24000), y = r.out.map((v) => hp.run(v));
    let worst = 0;
    for (let w = 12000; w + 1200 <= y.length; w += 1200) {
      let pk = 0, ss = 0;
      for (let i = w; i < w + 1200; i++) { ss += y[i] * y[i]; if (Math.abs(y[i]) > pk) pk = Math.abs(y[i]); }
      const rms = Math.sqrt(ss / 1200);
      if (rms > 1e-5) worst = Math.max(worst, pk / rms);
    }
    assert.ok(worst < 8, id + ': Spitzenfaktor ' + worst.toFixed(1) + ' (Knackser?)');
  }
});

test('keine Patscher, keine Schubumluft, kein Mechanik-Klicken, kein Turbo- oder Ansaugrauschen', () => {
  const src = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/synth.js'), 'utf8');
  assert.ok(!/popRate|popHeat|fBov|mechEnv|turboGain|fTurbo|inGain|fHelm/.test(src));
  assert.ok(Profiles.list.every((p) => p.popRate === undefined && p.turbo === undefined && p.intake === undefined));
});

test('Rauschen nur als Hauch: mindestens 36 dB unter dem Motorton', () => {
  const rms = (a) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);
  for (const id of Profiles.ids.filter((i) => Profiles.get(i).kind !== 'electric')) {
    const p = Profiles.get(id), rasp = p.rasp, fn = (t) => ({ rpm: 1100 + 3500 * t / 4, load: 1, speed: 60 });
    const full = drive(id, 24000, 4, fn).out;
    p.rasp = 0; const clean = drive(id, 24000, 4, fn).out; p.rasp = rasp;
    const db = 20 * Math.log10(rms(full.map((v, i) => v - clean[i])) / rms(clean));
    assert.ok(db < -36, id + ': Rauschen ' + db.toFixed(1) + ' dB');
  }
});

test('Rechenzeit bei 24 kHz im Rahmen (Head Unit)', () => {
  const s = new Synth(24000); s.configure({ profile: 'v10', volume: 1 }); s._setProfile('v10');
  const f = new Float32Array(960), t0 = process.hrtime.bigint();
  for (let k = 0; k < 250; k++) { s.setParams({ rpm: 1000 + (k % 50) * 76, load: 0.8, speed: 80 }); s.render(f, 480); }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  assert.ok(ms < 40, ms.toFixed(1) + ' ms pro Sekunde Audio');
});

test('Dienst rendert für einen 24-kHz-Mono-Kanal halb so viele Frames mit 2 Byte', () => {
  const eng = new E.Engine({ log() {} });
  const writes = [];
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    write(b) { writes.push(b.length); return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Date.now() - 100; eng.written = 0;
  eng._tick();
  const bytes = writes.reduce((a, b) => a + b, 0);
  assert.ok(eng.written % 2 === 0 && eng.written > 0);
  assert.strictEqual(bytes, eng.written / 2 * 2);
  assert.strictEqual(eng.status().wants, true);
});

test('Regelkreis mit Rückmeldung des Players: Vorlauf begrenzt (Start 120 ms), auch wenn der Kanal hängt', () => {
  const eng = new E.Engine({ log() {} });
  let bytes = 0;
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, write(b) { bytes += b.length; return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  eng.t0 = Date.now() - 5000; eng.written = 0;
  for (let i = 0; i < 20; i++) eng._tick();               // Kanal spielt nichts ab (z. B. noch nicht verbunden)
  const queuedMs = (bytes / 2) / 24000 * 1000;
  assert.ok(queuedMs <= E.FB_LEAD_START + 1 && queuedMs > 50, 'Warteschlange ' + queuedMs.toFixed(0) + ' ms');
  eng.out.played = bytes / 2;                                // alles gespielt -> genau ein Vorlauf wird nachgelegt
  const before = bytes; eng._tick();
  assert.ok(Math.abs((bytes - before) / 2 / 24 - E.FB_LEAD_START) < 2, 'nachgelegt ' + ((bytes - before) / 48).toFixed(0) + ' ms');
});

test('Lautstärke: sanftere Kurve und Kompressor heben Konstantfahrt an, Vollgas übersteuert nicht', () => {
  const lvl = (vol, load) => { const s = new Synth(24000); s.configure({ profile: 'subtle', volume: vol, enabled: true }); s._setProfile('subtle');
    const f = new Float32Array(4800); let pk = 0, sum = 0, n = 0;
    for (let k = 0; k < 60; k++) { s.setParams({ rpm: 2200, load, speed: 80 }); s.render(f, 2400); if (k > 30) for (let i = 0; i < 4800; i += 2) { const v = Math.abs(f[i]); pk = Math.max(pk, v); sum += v * v; n++; } }
    return { pk, rms: Math.sqrt(sum / n) }; };
  const cruise = lvl(0.6, 0.15), full = lvl(1, 1);
  assert.ok(cruise.rms > 0.03, 'Konstantfahrt bei 60 %: RMS ' + cruise.rms.toFixed(3));
  assert.ok(full.pk <= 1, 'Vollgas: Spitze ' + full.pk.toFixed(2));
});

test('Runterschalten: Zwischengas (Drehzahl springt hoch, Moment negativ) klingt nach Gasstoß, nicht nach Schub', () => {
  const VehicleFeed = require(path.join(ROOT, 'apps/iconix_sounds/vehicle_feed.js'));
  const feed = new VehicleFeed(null, { info() {}, warn() {} }, () => ({ loadSource: 'auto', maxTorque: 400, carIdle: 800 }));
  const out = [];
  feed.on('sample', (x) => out.push(x));
  const realNow = Date.now;
  let t = 1e12;
  Date.now = () => t;
  try {
    feed.v.torque = -20; feed.v.torqueAt = t; feed.v.speed = 60; feed.v.speedAt = t;
    for (let i = 0; i < 10; i++) { t += 50; feed.v.rpm = 1800; feed.v.torqueAt = t; feed._sample(); }   // Schub
    assert.ok(out[out.length - 1].overrun, 'vorher Schub');
    for (let i = 0; i < 6; i++) { t += 50; feed.v.rpm = 1800 + 200 * (i + 1); feed.v.torqueAt = t; feed._sample(); } // Zwischengas
    const blip = out[out.length - 1];
    assert.ok(!blip.overrun && blip.load > 0.2, 'beim Zwischengas: overrun ' + blip.overrun + ', Last ' + blip.load.toFixed(2));
    for (let i = 0; i < 12; i++) { t += 50; feed.v.rpm = 3000; feed.v.torqueAt = t; feed._sample(); }   // wieder Schub
    assert.ok(out[out.length - 1].overrun, 'danach wieder Schub');
  } finally { Date.now = realNow; }
});

test('Autostart: App hat einen Hintergrund-Einstieg (background) und app.json autostart', () => {
  const src = fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/main.js'), 'utf8');
  assert.ok(/background\(bg\)\s*\{\s*return startCore\(bg\)/.test(src));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/iconix_sounds/app.json'), 'utf8')).autostart, true);
});

test('Vorlauf: Start 120 ms, Aussetzer +30 ms, ruhig wieder knapper bis 70 ms', () => {
  const eng = new E.Engine({ log() {} });
  eng.out = { child: {}, blocked: false, fmt: { rate: 24000, ch: 1 }, step: E.Output.prototype.step, list: [], opts: { device: 'x' },
    played: 0, underruns: 0, write() { return true; }, start() { return true; }, stop() {} };
  eng.synth.configure({ enabled: true, volume: 0.5 });
  eng.params({ rpm: 2000, load: 0.5, speed: 50, overrun: false });
  const realNow = Date.now; let t = realNow();
  Date.now = () => t;
  try {
    eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START);
    eng.out.underruns = 1; eng.lastParams = t; eng._tick();
    assert.strictEqual(eng.fbLead, E.FB_LEAD_START + 30);
    for (let i = 0; i < 40; i++) { t += 21000; eng.lastParams = t; eng._tick(); }
    assert.strictEqual(eng.fbLead, E.FB_LEAD_MS);
  } finally { Date.now = realNow; }
});

test('Player: Stille-Schutz gegen Leerlaufen und Stille zu Beginn (alsa_play.py)', () => {
  const py = fs.readFileSync(path.join(ROOT, 'tools/iconix-audiod/alsa_play.py'), 'utf8');
  assert.ok(/select\.select\(\[fd\]/.test(py) && /snd_pcm_writei\(h, zeros, fill_n\)/.test(py));
  assert.ok(/os\.write\(1, \('P %d/.test(py), 'Rückmeldung der gespielten Frames');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  if (fail) { console.log(fail + ' Test(s) fehlgeschlagen'); process.exit(1); }
  console.log('Alle Iconix-Tonweg-Tests bestanden');
})();
