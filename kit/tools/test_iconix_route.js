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
  assert.deepStrictEqual(c[0].argv.slice(1), ['play', 'plug:smartx:CarLifeMedia_CF_48_STEREO', '48000', '80000', '2']);
  const m = E.candidates({ device: 'plug:smartx:Media_Overlay_Converter_Source_CF_24_MONO' });
  assert.deepStrictEqual(m[0].argv.slice(3), ['24000', '80000', '1']);
});

test('Umrechnung 48 kHz Stereo -> 24 kHz Mono', () => {
  const f = new Float32Array([0.5, 0.5, 1, 1, -1, -1, 0, 0]);
  const b = E.toPcmFmt(f, 4, { rate: 24000, ch: 1 });
  assert.strictEqual(b.length, 4);
  assert.strictEqual(b.readInt16LE(0), (0.75 * 32767) | 0);
  assert.strictEqual(b.readInt16LE(2), (-0.5 * 32767) | 0);
  const s = E.toPcmFmt(f, 4, { rate: 48000, ch: 2 });
  assert.strictEqual(s.length, 16);
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

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('ok   ' + name); } catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  }
  if (fail) { console.log(fail + ' Test(s) fehlgeschlagen'); process.exit(1); }
  console.log('Alle Iconix-Tonweg-Tests bestanden');
})();
