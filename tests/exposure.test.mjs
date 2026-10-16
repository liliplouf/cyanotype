import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSkyUVA,
  cloudTransmission,
  effectiveUVA,
  settingsFactor,
  REFERENCE_MINUTES,
  exposureMinutesConstant,
  integratedExposure,
  dayProfile,
  lampExposureMinutes,
  adviceFor,
} from '../js/exposure.js';
import { solarPosition, sunTimes } from '../js/solar.js';
import * as F from '../js/factors.js';

const PARIS = { lat: 48.8566, lon: 2.3522 };
const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} ≉ ${b} (±${tol})`);

// ------------------------------------------------------------------ factors
test('catalogues : structure et références à 1', () => {
  for (const name of ['CHEMISTRY', 'SUBSTRATE', 'COATING', 'HUMIDITY_STATE', 'GLASS', 'NEGATIVE', 'LIGHT_SOURCE', 'RESULT_GOAL']) {
    const list = F[name];
    assert.ok(Array.isArray(list) && list.length > 0, name);
    const ids = new Set();
    for (const it of list) {
      assert.equal(typeof it.id, 'string');
      assert.equal(typeof it.label, 'string');
      assert.equal(typeof it.description, 'string');
      assert.ok(it.factor > 0, `${name}.${it.id}`);
      assert.ok(!ids.has(it.id), `doublon ${it.id}`);
      ids.add(it.id);
    }
  }
  assert.equal(F.getById(F.CHEMISTRY, 'classic').factor, 1);
  assert.equal(F.getById(F.SUBSTRATE, 'cotton_paper').factor, 1);
  assert.equal(F.getById(F.GLASS, 'none').factor, 1);
  assert.equal(F.getById(F.NEGATIVE, 'photogram').factor, 1);
  assert.equal(F.getById(F.CHEMISTRY, 'nope'), undefined);
  assert.equal(F.getById(null, 'x'), undefined);
  const nw = F.getById(F.CHEMISTRY, 'new_ware').factor;
  assert.ok(nw >= 0.25 && nw <= 0.35);
  assert.ok(F.getById(F.GLASS, 'acrylic_standard').factor >= 3);
  const fg = F.getById(F.GLASS, 'float_glass').factor;
  assert.ok(fg >= 1.15 && fg <= 1.25);
  assert.equal(F.getById(F.LIGHT_SOURCE, 'sun').kind, 'sun');
  for (const l of F.LIGHT_SOURCE.filter((x) => x.kind === 'lamp')) {
    assert.ok(l.refMinutes > 0 && l.refPowerW > 0 && l.refDistanceCm > 0, l.id);
  }
});

// ------------------------------------------------------------------ clear sky
test('clearSkyUVA : 1 au zénith, 0 sous l’horizon, croissante, gain d’altitude modéré', () => {
  close(clearSkyUVA(90), 1, 1e-12);
  assert.equal(clearSkyUVA(0), 0);
  assert.equal(clearSkyUVA(-5), 0);
  let prev = 0;
  for (let h = 1; h <= 90; h++) {
    const v = clearSkyUVA(h);
    assert.ok(v > prev, `non croissante à ${h}°`);
    prev = v;
  }
  const r = clearSkyUVA(45, 1000) / clearSkyUVA(45, 0);
  assert.ok(r >= 1.05 && r <= 1.08, `gain/km ${r}`);
  // ordres de grandeur : 30° ≈ 0,4–0,5 ; 10° ≈ 0,1–0,15
  assert.ok(clearSkyUVA(30) > 0.38 && clearSkyUVA(30) < 0.5);
  assert.ok(clearSkyUVA(10) > 0.08 && clearSkyUVA(10) < 0.17);
});

test('cloudTransmission : 1 ciel clair, décroissante, ~0,44 couvert', () => {
  assert.equal(cloudTransmission(0), 1);
  close(cloudTransmission(100), 0.44, 0.01);
  let prev = 1.01;
  for (let c = 0; c <= 100; c += 5) {
    const t = cloudTransmission(c);
    assert.ok(t < prev && t > 0 && t <= 1);
    prev = t;
  }
  assert.equal(cloudTransmission(150), cloudTransmission(100));
});

test('effectiveUVA : ratio UV prioritaire, albédo, sans données = ciel clair', () => {
  const base = clearSkyUVA(50, 0);
  close(effectiveUVA({ elevationDeg: 50 }), base, 1e-12);
  close(effectiveUVA({ elevationDeg: 50, cloudCoverPct: 100 }), base * cloudTransmission(100), 1e-12);
  // le ratio uv/uvClear est utilisé à la place de la couverture nuageuse
  close(effectiveUVA({ elevationDeg: 50, cloudCoverPct: 100, uvIndex: 3, uvIndexClearSky: 6 }), base * 0.5, 1e-12);
  // la valeur absolue de l'indice UV n'intervient pas
  close(
    effectiveUVA({ elevationDeg: 50, uvIndex: 2, uvIndexClearSky: 4 }),
    effectiveUVA({ elevationDeg: 50, uvIndex: 4, uvIndexClearSky: 8 }),
    1e-12
  );
  // UV ciel clair trop faible → couverture nuageuse
  close(effectiveUVA({ elevationDeg: 50, cloudCoverPct: 50, uvIndex: 0, uvIndexClearSky: 0.2 }), base * cloudTransmission(50), 1e-12);
  assert.ok(effectiveUVA({ elevationDeg: 50, albedo: 0.8 }) > base * 1.1);
  assert.equal(effectiveUVA({ elevationDeg: -3, cloudCoverPct: 0 }), 0);
});

// ------------------------------------------------------------------ settings & constant
test('settingsFactor : produit des facteurs et calibration', () => {
  assert.equal(settingsFactor(undefined), 1);
  assert.equal(settingsFactor({}), 1);
  assert.equal(settingsFactor({ chemistry: 'classic', substrate: 'cotton_paper', glass: 'none' }), 1);
  const s = { chemistry: 'new_ware', glass: 'float_glass', negative: 'digital_transparency', calibrationFactor: 1.1 };
  const expected =
    F.getById(F.CHEMISTRY, 'new_ware').factor *
    F.getById(F.GLASS, 'float_glass').factor *
    F.getById(F.NEGATIVE, 'digital_transparency').factor *
    1.1;
  close(settingsFactor(s), expected, 1e-12);
  assert.equal(settingsFactor({ chemistry: 'inconnu', calibrationFactor: -2 }), 1);
});

test('temps de référence ≈ REFERENCE_MINUTES quand uva = 1', () => {
  assert.ok(REFERENCE_MINUTES >= 6 && REFERENCE_MINUTES <= 10);
  close(exposureMinutesConstant(1, {}), REFERENCE_MINUTES, 1e-12);
  close(exposureMinutesConstant(0.5, {}), 2 * REFERENCE_MINUTES, 1e-12);
  assert.equal(exposureMinutesConstant(0, {}), Infinity);
  assert.equal(exposureMinutesConstant(1e-9, {}), Infinity);
  assert.ok(exposureMinutesConstant(1, { chemistry: 'new_ware' }) < REFERENCE_MINUTES / 2.5);
  assert.ok(exposureMinutesConstant(1, { glass: 'acrylic_standard' }) > 3 * REFERENCE_MINUTES);
  assert.ok(exposureMinutesConstant(1, { humidityState: 'humidified' }) < REFERENCE_MINUTES);
});

test('monotonie : plus de nuages ⇒ pose plus longue ; soleil plus bas ⇒ plus longue', () => {
  let prev = 0;
  for (let c = 0; c <= 100; c += 10) {
    const m = exposureMinutesConstant(effectiveUVA({ elevationDeg: 45, cloudCoverPct: c }), {});
    assert.ok(m > prev, `nuages ${c}%`);
    prev = m;
  }
  prev = 0;
  for (let h = 90; h >= 5; h -= 5) {
    const m = exposureMinutesConstant(effectiveUVA({ elevationDeg: h }), {});
    assert.ok(m > prev, `élévation ${h}°`);
    prev = m;
  }
});

test('ordre de grandeur réaliste : Paris, midi, 21 juin, ciel clair ≈ 9 min', () => {
  const st = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lon);
  const m = exposureMinutesConstant(effectiveUVA({ elevationDeg: st.maxElevation }), {});
  assert.ok(m > 8 && m < 11, `${m}`);
});

// ------------------------------------------------------------------ integrated
test('integratedExposure ≈ version constante à midi (soleil quasi immobile, météo constante)', () => {
  const st = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lon);
  const start = new Date(st.solarNoon.getTime() - 4 * 60000);
  const weatherAt = () => ({ cloudCoverPct: 40 });
  const r = integratedExposure({ start, ...PARIS, altitudeM: 35, settings: {}, weatherAt });
  const uva = effectiveUVA({ elevationDeg: solarPosition(start, PARIS.lat, PARIS.lon).elevation, altitudeM: 35, cloudCoverPct: 40 });
  const c = exposureMinutesConstant(uva, {});
  assert.ok(r.reachable);
  close(r.minutes, c, 0.02 * c);
  assert.ok(Math.abs(r.end - start - r.minutes * 60000) < 1);
  const last = r.doseCurve[r.doseCurve.length - 1];
  close(last.cumulative, 1, 1e-9);
  assert.equal(r.doseCurve[0].cumulative, 0);
  for (let i = 1; i < r.doseCurve.length; i++) assert.ok(r.doseCurve[i].cumulative >= r.doseCurve[i - 1].cumulative);
  assert.equal(r.limitedBy, null);
});

test('integratedExposure : nuages ⇒ plus long, weatherAt null ⇒ ciel clair', () => {
  const start = new Date('2026-06-21T09:00:00Z');
  const clear = integratedExposure({ start, ...PARIS, settings: {}, weatherAt: () => null });
  const none = integratedExposure({ start, ...PARIS, settings: {} });
  const cloudy = integratedExposure({ start, ...PARIS, settings: {}, weatherAt: () => ({ cloudCoverPct: 100 }) });
  close(clear.minutes, none.minutes, 1e-9);
  assert.ok(cloudy.minutes > clear.minutes * 1.8);
});

test('integratedExposure : inatteignable si le soleil se couche avant', () => {
  const st = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lon);
  const start = new Date(st.sunset.getTime() - 20 * 60000);
  const r = integratedExposure({ start, ...PARIS, settings: {}, weatherAt: () => ({ cloudCoverPct: 100 }) });
  assert.equal(r.reachable, false);
  assert.equal(r.minutes, Infinity);
  assert.equal(r.end, null);
  assert.equal(r.limitedBy, 'sunset');
  assert.ok(r.fractionReached < 1);
  // de nuit (soirée)
  const night = integratedExposure({ start: new Date('2026-06-21T21:30:00Z'), ...PARIS, settings: {} });
  assert.equal(night.reachable, false);
  // plafond maxMinutes
  const capped = integratedExposure({ start: new Date('2026-06-21T10:00:00Z'), ...PARIS, settings: { glass: 'polycarbonate', coating: 'double' }, maxMinutes: 30 });
  assert.equal(capped.reachable, false);
  assert.equal(capped.limitedBy, 'maxMinutes');
});

test('integratedExposure : météo variable (nuages l’après-midi) rallonge la pose', () => {
  const start = new Date('2026-06-21T11:00:00Z');
  const boundary = new Date('2026-06-21T11:05:00Z').getTime();
  const weatherAt = (d) => ({ cloudCoverPct: d.getTime() < boundary ? 0 : 100 });
  const r = integratedExposure({ start, ...PARIS, settings: {}, weatherAt });
  const clear = integratedExposure({ start, ...PARIS, settings: {} });
  assert.ok(r.minutes > clear.minutes * 1.5);
});

// ------------------------------------------------------------------ day profile
test('dayProfile : cohérent avec integratedExposure, minimum vers midi, rapide', () => {
  const day = new Date('2026-06-21T12:00:00Z');
  const weatherAt = (d) => ({ cloudCoverPct: 20 + 30 * Math.sin(d.getTime() / 3.6e6), uvIndex: 5, uvIndexClearSky: 7 });
  const args = { day, ...PARIS, altitudeM: 35, settings: { negative: 'digital_transparency', glass: 'float_glass' }, weatherAt };
  const t0 = performance.now();
  const prof = dayProfile(args);
  const dt = performance.now() - t0;
  assert.ok(dt < 50, `dayProfile trop lent : ${dt.toFixed(1)} ms`);

  const st = sunTimes(day, PARIS.lat, PARIS.lon);
  assert.ok(prof.length > 50);
  assert.ok(prof[0].t >= st.sunrise && prof[prof.length - 1].t <= st.sunset);
  for (const p of prof) assert.equal(p.t.getTime() % (15 * 60000), 0);
  assert.equal(prof[prof.length - 1].minutes, Infinity);

  // comparaison point par point avec l'intégration directe
  for (const p of prof.filter((_, i) => i % 7 === 0)) {
    const r = integratedExposure({ start: p.t, ...PARIS, altitudeM: 35, settings: args.settings, weatherAt });
    if (Number.isFinite(p.minutes)) close(p.minutes, r.minutes, 0.05, `${p.t.toISOString()} ${p.minutes} vs ${r.minutes}`);
    else assert.equal(r.reachable, false);
  }

  const finite = prof.filter((p) => Number.isFinite(p.minutes));
  const best = finite.reduce((a, b) => (b.minutes < a.minutes ? b : a));
  assert.ok(Math.abs(best.t - st.solarNoon) < 2.5 * 3600e3, best.t.toISOString());
});

test('dayProfile : nuit polaire → [], soleil de minuit → journée entière', () => {
  assert.deepEqual(dayProfile({ day: new Date('2026-12-21T12:00:00Z'), lat: 78.2, lon: 15.6, settings: {} }), []);
  const t0 = performance.now();
  const p = dayProfile({ day: new Date('2026-06-21T12:00:00Z'), lat: 78.2, lon: 15.6, settings: {} });
  assert.ok(performance.now() - t0 < 50);
  assert.ok(p.length >= 95);
  assert.ok(p.every((x) => x.elevation > 0));
});

// ------------------------------------------------------------------ lamp
test('lampExposureMinutes : référence, inverse du carré, puissance', () => {
  const src = F.getById(F.LIGHT_SOURCE, 'uv_led_365');
  const ref = lampExposureMinutes({ sourceId: 'uv_led_365', powerW: src.refPowerW, distanceCm: src.refDistanceCm, settings: {} });
  close(ref, src.refMinutes, 1e-12);
  const far = lampExposureMinutes({ sourceId: 'uv_led_365', powerW: src.refPowerW, distanceCm: src.refDistanceCm * 2, settings: {} });
  close(far, 4 * ref, 1e-9);
  const strong = lampExposureMinutes({ sourceId: 'uv_led_365', powerW: src.refPowerW * 2, distanceCm: src.refDistanceCm, settings: {} });
  close(strong, ref / 2, 1e-9);
  const ware = lampExposureMinutes({ sourceId: 'uv_led_365', settings: { chemistry: 'new_ware' } });
  close(ware, ref * settingsFactor({ chemistry: 'new_ware' }), 1e-9);
  assert.ok(Number.isNaN(lampExposureMinutes({ sourceId: 'sun', settings: {} })));
  assert.ok(Number.isNaN(lampExposureMinutes({ sourceId: 'inconnu' })));
});

// ------------------------------------------------------------------ advice
test('adviceFor : conseils pertinents en français', () => {
  const low = adviceFor({ elevationDeg: 12, cloudCoverPct: 0, minutes: 30 });
  assert.ok(low.some((s) => /bas/i.test(s)));
  const variable = adviceFor({ elevationDeg: 50, cloudCoverPct: 50, minutes: 15 });
  assert.ok(variable.some((s) => /minuteur intégré/i.test(s)));
  const long = adviceFor({ elevationDeg: 40, cloudCoverPct: 10, minutes: 60 });
  assert.ok(long.some((s) => /New Cyanotype/i.test(s)));
  const hot = adviceFor({ elevationDeg: 60, temperatureC: 34, humidityPct: 85 });
  assert.ok(hot.some((s) => /chaleur/i.test(s)));
  assert.ok(hot.some((s) => /humide/i.test(s)));
  assert.ok(adviceFor({ minutes: Infinity }).some((s) => /coucher/i.test(s)));
  assert.ok(adviceFor({ elevationDeg: -4 }).some((s) => /horizon/i.test(s)));
  const ok = adviceFor({ elevationDeg: 60, cloudCoverPct: 0, minutes: 10, humidityPct: 50, temperatureC: 22 });
  assert.equal(ok.length, 1);
  assert.ok(Array.isArray(adviceFor()));
});
