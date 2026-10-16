import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solarPosition, sunTimes } from '../js/solar.js';

const PARIS = { lat: 48.8566, lon: 2.3522 };

test('Paris, 21 juin, midi solaire : élévation ≈ 64,5°, azimut ≈ 180°', () => {
  const st = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lon);
  const p = solarPosition(st.solarNoon, PARIS.lat, PARIS.lon);
  assert.ok(Math.abs(p.elevation - 64.55) < 0.2, `élévation ${p.elevation}`);
  assert.ok(Math.abs(p.azimuth - 180) < 0.5, `azimut ${p.azimuth}`);
  assert.ok(Math.abs(p.zenith + p.elevation - 90) < 1e-9);
  assert.ok(Math.abs(st.maxElevation - p.elevation) < 1e-9);
});

test('midi solaire à Paris ≈ 11:52 UTC le 21 juin (équation du temps)', () => {
  const st = sunTimes(new Date('2026-06-21T08:00:00Z'), PARIS.lat, PARIS.lon);
  const min = st.solarNoon.getUTCHours() * 60 + st.solarNoon.getUTCMinutes();
  assert.ok(Math.abs(min - (11 * 60 + 52)) <= 1, st.solarNoon.toISOString());
});

test('lever/coucher à Paris le 21 juin (≈ 03:47 et 19:58 UTC)', () => {
  const st = sunTimes(new Date('2026-06-21T12:00:00Z'), PARIS.lat, PARIS.lon);
  const rise = st.sunrise.getUTCHours() * 60 + st.sunrise.getUTCMinutes();
  const set = st.sunset.getUTCHours() * 60 + st.sunset.getUTCMinutes();
  assert.ok(Math.abs(rise - (3 * 60 + 47)) <= 2, st.sunrise.toISOString());
  assert.ok(Math.abs(set - (19 * 60 + 58)) <= 2, st.sunset.toISOString());
  // au lever, centre géométrique à −0,833° → élévation apparente (réfraction incluse) légèrement négative
  const e = solarPosition(st.sunrise, PARIS.lat, PARIS.lon).elevation;
  assert.ok(e < 0 && e > -1, `${e}`);
});

test('soleil sous l’horizon la nuit', () => {
  const p = solarPosition(new Date('2026-06-21T23:30:00Z'), PARIS.lat, PARIS.lon);
  assert.ok(p.elevation < -10, `élévation ${p.elevation}`);
  const w = solarPosition(new Date('2026-12-21T02:00:00Z'), PARIS.lat, PARIS.lon);
  assert.ok(w.elevation < -30);
});

test('azimut : est le matin, ouest le soir', () => {
  const am = solarPosition(new Date('2026-03-20T07:00:00Z'), PARIS.lat, PARIS.lon);
  const pm = solarPosition(new Date('2026-03-20T17:00:00Z'), PARIS.lat, PARIS.lon);
  assert.ok(am.azimuth > 60 && am.azimuth < 130, `${am.azimuth}`);
  assert.ok(pm.azimuth > 230 && pm.azimuth < 300, `${pm.azimuth}`);
});

test('équinoxe à l’équateur : soleil quasi au zénith à midi', () => {
  const st = sunTimes(new Date('2026-03-20T12:00:00Z'), 0, 0);
  assert.ok(st.maxElevation > 89, `${st.maxElevation}`);
});

test('hémisphère sud et fuseau lointain (Sydney, 21 déc.)', () => {
  const st = sunTimes(new Date('2026-12-21T02:00:00Z'), -33.87, 151.21);
  assert.ok(Math.abs(st.maxElevation - (90 - 33.87 + 23.44)) < 0.3, `${st.maxElevation}`);
  assert.ok(st.sunrise < st.solarNoon && st.solarNoon < st.sunset);
  assert.ok(Math.abs(st.solarNoon - new Date('2026-12-21T02:00:00Z')) < 12 * 3600e3);
});

test('soleil de minuit et nuit polaire : lever/coucher null', () => {
  const summer = sunTimes(new Date('2026-06-21T12:00:00Z'), 78.2, 15.6);
  assert.equal(summer.sunrise, null);
  assert.equal(summer.sunset, null);
  assert.ok(summer.maxElevation > 30);
  const winter = sunTimes(new Date('2026-12-21T12:00:00Z'), 78.2, 15.6);
  assert.equal(winter.sunrise, null);
  assert.equal(winter.sunset, null);
  assert.ok(winter.maxElevation < 0);
});
