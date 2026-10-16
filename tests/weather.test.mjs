import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  fetchForecast, makeWeatherAt, searchPlace, weatherCodeLabel, clearWeatherCache,
  parseForecast, buildForecastUrl,
} from '../js/weather.js';
import { getBrowserPosition } from '../js/geo.js';

const FIX = new URL('./fixtures/', import.meta.url);
const forecastRaw = JSON.parse(readFileSync(new URL('openmeteo-forecast.json', FIX), 'utf8'));
const geocodingRaw = JSON.parse(readFileSync(new URL('openmeteo-geocoding.json', FIX), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** Simule fetch : enregistre les URL et renvoie une réponse façon Response. */
function mockFetch(body, { status = 200, calls = [] } = {}) {
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => (typeof body === 'string' ? JSON.parse(body) : clone(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

// Stockage factice type localStorage pour vérifier le cache persistant.
class FakeStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

beforeEach(() => {
  delete globalThis.localStorage;
  clearWeatherCache();
});

test('URL de prévision : paramètres requis', () => {
  const u = new URL(buildForecastUrl(43.68, 4.63));
  assert.equal(u.origin + u.pathname, 'https://api.open-meteo.com/v1/forecast');
  assert.equal(u.searchParams.get('timeformat'), 'unixtime');
  assert.equal(u.searchParams.get('timezone'), 'auto');
  assert.equal(u.searchParams.get('forecast_days'), '3');
  assert.equal(u.searchParams.get('hourly'),
    'cloud_cover,uv_index,uv_index_clear_sky,temperature_2m,relative_humidity_2m,shortwave_radiation,weather_code');
  assert.equal(u.searchParams.get('current'), 'cloud_cover,uv_index,temperature_2m,relative_humidity_2m,weather_code');
});

test('fetchForecast : parse la réponse unixtime en vrais instants UTC', async () => {
  const f = mockFetch(forecastRaw);
  const fc = await fetchForecast(43.68, 4.63, { fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(fc.elevation, 9);
  assert.equal(fc.timezone, 'Europe/Paris');
  assert.equal(fc.utcOffsetSeconds, 7200);
  assert.equal(fc.hourly.length, 72);
  // Première heure = minuit heure locale le 16/10 = 22:00 UTC le 15/10.
  assert.ok(fc.hourly[0].time instanceof Date);
  assert.equal(fc.hourly[0].time.toISOString(), '2026-10-15T22:00:00.000Z');
  assert.equal(fc.hourly[71].time.toISOString(), '2026-10-18T21:00:00.000Z');
  const h13 = fc.hourly[13]; // 13:00 CEST
  assert.equal(h13.time.toISOString(), '2026-10-16T11:00:00.000Z');
  assert.deepEqual(Object.keys(h13).sort(),
    ['cloudCoverPct', 'humidityPct', 'shortwaveWm2', 'temperatureC', 'time', 'uvIndex', 'uvIndexClearSky', 'weatherCode'].sort());
  assert.equal(h13.cloudCoverPct, forecastRaw.hourly.cloud_cover[13]);
  assert.equal(h13.uvIndex, forecastRaw.hourly.uv_index[13]);
  assert.equal(h13.uvIndexClearSky, forecastRaw.hourly.uv_index_clear_sky[13]);
  assert.equal(h13.shortwaveWm2, forecastRaw.hourly.shortwave_radiation[13]);
  assert.equal(fc.current.time.toISOString(), '2026-10-16T08:45:00.000Z');
  assert.equal(fc.current.cloudCoverPct, 9);
  assert.equal(fc.current.weatherCode, 0);
  assert.equal(typeof fc.current.temperatureC, 'number');
  assert.equal(typeof fc.current.humidityPct, 'number');
});

test('parseForecast : heures ISO locales (timeformat=iso8601) converties via utc_offset_seconds', () => {
  const raw = clone(forecastRaw);
  raw.hourly.time = raw.hourly.time.map((t) => new Date((t + 7200) * 1000).toISOString().slice(0, 16));
  raw.current.time = '2026-10-16T10:45';
  const fc = parseForecast(raw);
  assert.equal(fc.hourly[0].time.toISOString(), '2026-10-15T22:00:00.000Z');
  assert.equal(fc.current.time.toISOString(), '2026-10-16T08:45:00.000Z');
});

test('fetchForecast : valeurs null / colonnes manquantes → null', async () => {
  const raw = clone(forecastRaw);
  raw.hourly.uv_index[12] = null;
  raw.hourly.cloud_cover[13] = null;
  delete raw.hourly.shortwave_radiation;
  raw.current.uv_index = null;
  const fc = await fetchForecast(43.68, 4.63, { fetchImpl: mockFetch(raw), useCache: false });
  assert.equal(fc.hourly[12].uvIndex, null);
  assert.equal(fc.hourly[13].cloudCoverPct, null);
  assert.equal(fc.hourly[0].shortwaveWm2, null);
  assert.equal(fc.current.uvIndex, null);
});

test('fetchForecast : sans bloc current, prend l’heure la plus proche', async () => {
  const raw = clone(forecastRaw);
  delete raw.current;
  const fc = await fetchForecast(43.68, 4.63, { fetchImpl: mockFetch(raw), useCache: false });
  assert.ok(fc.current.time instanceof Date);
  assert.ok(fc.hourly.some((h) => h.time.getTime() === fc.current.time.getTime()));
});

test('fetchForecast : erreurs en français (réseau, HTTP, réponse invalide, coordonnées)', async () => {
  const netFail = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(fetchForecast(43.68, 4.63, { fetchImpl: netFail }),
    (e) => e.code === 'network' && /Impossible de contacter le service météo/.test(e.message));

  await assert.rejects(
    fetchForecast(43.68, 4.63, { fetchImpl: mockFetch({ error: true, reason: 'Parameter x invalid' }, { status: 400 }) }),
    (e) => e.code === 'http' && /HTTP 400/.test(e.message) && /Parameter x invalid/.test(e.message));

  await assert.rejects(fetchForecast(43.68, 4.63, { fetchImpl: mockFetch({}, { status: 503 }) }),
    (e) => e.code === 'http' && /HTTP 503/.test(e.message));

  const badJson = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  await assert.rejects(fetchForecast(43.68, 4.63, { fetchImpl: badJson }),
    (e) => e.code === 'invalid' && /Réponse invalide/.test(e.message));

  await assert.rejects(fetchForecast(43.68, 4.63, { fetchImpl: mockFetch({ latitude: 1 }) }),
    (e) => e.code === 'invalid' && /Réponse météo invalide/.test(e.message));

  await assert.rejects(fetchForecast(123, 4.63, { fetchImpl: mockFetch(forecastRaw) }),
    (e) => /Coordonnées invalides/.test(e.message));
});

test('fetchForecast : délai dépassé → erreur timeout', async () => {
  const hang = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  await assert.rejects(fetchForecast(43.68, 4.63, { fetchImpl: hang, timeoutMs: 20 }),
    (e) => e.code === 'timeout' && /ne répond pas/.test(e.message));
});

test('cache mémoire 10 min', async () => {
  const f = mockFetch(forecastRaw);
  const t0 = Date.UTC(2026, 9, 16, 8);
  await fetchForecast(43.68, 4.63, { fetchImpl: f, now: t0 });
  await fetchForecast(43.6801, 4.6302, { fetchImpl: f, now: t0 + 5 * 60e3 }); // même cellule ~1 km
  assert.equal(f.calls.length, 1);
  await fetchForecast(43.68, 4.63, { fetchImpl: f, now: t0 + 11 * 60e3 });
  assert.equal(f.calls.length, 2);
  await fetchForecast(48.85, 2.35, { fetchImpl: f, now: t0 + 11 * 60e3 });
  assert.equal(f.calls.length, 3);
  await fetchForecast(48.85, 2.35, { fetchImpl: f, useCache: false, now: t0 + 11 * 60e3 });
  assert.equal(f.calls.length, 4);
});

test('cache localStorage : survit au vidage du cache mémoire ; erreur non mise en cache', async () => {
  const ls = new FakeStorage();
  globalThis.localStorage = ls;
  const t0 = Date.UTC(2026, 9, 16, 8);
  const f = mockFetch(forecastRaw);
  await fetchForecast(43.68, 4.63, { fetchImpl: f, now: t0 });
  assert.ok([...ls.m.keys()].some((k) => k.startsWith('cyanocalc:v1:wx:')));
  // Simule un rechargement de page : cache mémoire vide, localStorage conservé.
  const saved = new Map(ls.m);
  clearWeatherCache();
  saved.forEach((v, k) => ls.setItem(k, v));
  const fc = await fetchForecast(43.68, 4.63, { fetchImpl: f, now: t0 + 60e3 });
  assert.equal(f.calls.length, 1);
  assert.equal(fc.hourly[0].time.toISOString(), '2026-10-15T22:00:00.000Z');

  // Entrée corrompue → re-téléchargement sans exception.
  clearWeatherCache();
  ls.setItem('cyanocalc:v1:wx:43.68,4.63', '{pas du json');
  await fetchForecast(43.68, 4.63, { fetchImpl: f, now: t0 });
  assert.equal(f.calls.length, 2);
});

test('cache : localStorage qui lève ne casse rien', async () => {
  const boom = () => { throw new Error('SecurityError'); };
  globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, key: boom, get length() { return boom(); } };
  const f = mockFetch(forecastRaw);
  const fc = await fetchForecast(43.68, 4.63, { fetchImpl: f });
  assert.equal(fc.hourly.length, 72);
  await fetchForecast(43.68, 4.63, { fetchImpl: f });
  assert.equal(f.calls.length, 1); // cache mémoire
  clearWeatherCache();
});

test('makeWeatherAt : interpolation linéaire, null hors plage', async () => {
  const fc = parseForecast(forecastRaw);
  const at = makeWeatherAt(fc);
  const h = forecastRaw.hourly;
  // Heure exacte
  const exact = at(new Date('2026-10-16T11:00:00Z'));
  assert.equal(exact.cloudCoverPct, h.cloud_cover[13]);
  assert.equal(exact.uvIndex, h.uv_index[13]);
  assert.equal(exact.uvIndexClearSky, h.uv_index_clear_sky[13]);
  // Mi-chemin 13:00 → 14:00 locales
  const mid = at(new Date('2026-10-16T11:30:00Z'));
  assert.ok(Math.abs(mid.cloudCoverPct - (h.cloud_cover[13] + h.cloud_cover[14]) / 2) < 1e-9);
  assert.ok(Math.abs(mid.uvIndex - (h.uv_index[13] + h.uv_index[14]) / 2) < 1e-9);
  // Quart d'heure
  const q = at(new Date('2026-10-16T11:15:00Z'));
  assert.ok(Math.abs(q.temperatureC - (h.temperature_2m[13] * 0.75 + h.temperature_2m[14] * 0.25)) < 1e-9);
  // Bornes incluses, hors plage → null
  assert.ok(at(new Date('2026-10-15T22:00:00Z')));
  assert.ok(at(new Date('2026-10-18T21:00:00Z')));
  assert.equal(at(new Date('2026-10-15T21:59:00Z')), null);
  assert.equal(at(new Date('2026-10-18T21:01:00Z')), null);
  assert.equal(at(new Date('invalid')), null);
  // Accepte aussi un timestamp en ms
  assert.equal(at(Date.parse('2026-10-16T11:00:00Z')).cloudCoverPct, h.cloud_cover[13]);
});

test('makeWeatherAt : gestion des null et prévision vide', () => {
  const raw = clone(forecastRaw);
  raw.hourly.cloud_cover[13] = null;
  raw.hourly.uv_index[13] = null;
  raw.hourly.uv_index_clear_sky[13] = null;
  const at = makeWeatherAt(parseForecast(raw));
  const v = at(new Date('2026-10-16T11:30:00Z'));
  assert.equal(v.cloudCoverPct, raw.hourly.cloud_cover[14]); // côté manquant remplacé
  assert.equal(v.uvIndex, raw.hourly.uv_index[14]);
  // Heure où les trois champs utiles sont null → null
  const raw2 = clone(forecastRaw);
  for (const k of ['cloud_cover', 'uv_index', 'uv_index_clear_sky']) raw2.hourly[k] = raw2.hourly[k].map(() => null);
  assert.equal(makeWeatherAt(parseForecast(raw2))(new Date('2026-10-16T11:30:00Z')), null);
  assert.equal(makeWeatherAt(null)(new Date()), null);
  assert.equal(makeWeatherAt({ hourly: [] })(new Date()), null);
});

test('searchPlace : URL, normalisation et libellé lisible', async () => {
  const f = mockFetch(geocodingRaw);
  const res = await searchPlace('Arles', { fetchImpl: f });
  const u = new URL(f.calls[0].url);
  assert.equal(u.origin + u.pathname, 'https://geocoding-api.open-meteo.com/v1/search');
  assert.equal(u.searchParams.get('name'), 'Arles');
  assert.equal(u.searchParams.get('count'), '5');
  assert.equal(u.searchParams.get('language'), 'fr');
  assert.equal(res.length, 4);
  const a = res[0];
  assert.equal(a.name, 'Arles');
  assert.equal(a.admin1, "Provence-Alpes-Côte d'Azur");
  assert.equal(a.country, 'France');
  assert.equal(a.lat, 43.67681);
  assert.equal(a.lon, 4.63031);
  assert.equal(a.elevation, 13);
  assert.equal(a.label, "Arles, Provence-Alpes-Côte d'Azur, France");
  assert.equal(res[3].label, 'Arles, Arkansas, États-Unis');
  // Cache mémoire
  await searchPlace('  arles ', { fetchImpl: f });
  assert.equal(f.calls.length, 1);
});

test('searchPlace : aucun résultat (pas de clé results), requête courte, erreurs', async () => {
  assert.deepEqual(await searchPlace('Zzxqwv', { fetchImpl: mockFetch({ generationtime_ms: 0.5 }) }), []);
  const f = mockFetch(geocodingRaw);
  assert.deepEqual(await searchPlace('a', { fetchImpl: f }), []);
  assert.deepEqual(await searchPlace('', { fetchImpl: f }), []);
  assert.deepEqual(await searchPlace(null, { fetchImpl: f }), []);
  assert.equal(f.calls.length, 0);
  // Libellé sans admin1 et doublon admin1 == name
  const res = await searchPlace('Monaco', {
    fetchImpl: mockFetch({ results: [
      { name: 'Monaco', latitude: 43.73, longitude: 7.42, country: 'Monaco', admin1: 'Monaco' },
      { name: 'Ville', latitude: 1, longitude: 2 },
      { name: 'Cassé' },
    ] }),
  });
  assert.equal(res.length, 2);
  assert.equal(res[0].label, 'Monaco');
  assert.equal(res[0].elevation, null);
  assert.equal(res[1].label, 'Ville');
  await assert.rejects(searchPlace('Paris', { fetchImpl: async () => { throw new TypeError('x'); } }),
    (e) => e.code === 'network' && /recherche de lieux/.test(e.message));
  await assert.rejects(searchPlace('Paris', { fetchImpl: mockFetch({ error: true, reason: 'x' }, { status: 400 }) }),
    (e) => e.code === 'http' && /HTTP 400/.test(e.message));
});

test('weatherCodeLabel : codes WMO en français', () => {
  assert.deepEqual(weatherCodeLabel(0), { label: 'Ciel dégagé', icon: '☀️' });
  assert.equal(weatherCodeLabel(3).label, 'Couvert');
  assert.equal(weatherCodeLabel(63).label, 'Pluie modérée');
  assert.equal(weatherCodeLabel(95).label, 'Orage');
  assert.equal(weatherCodeLabel('2').label, 'Partiellement nuageux');
  for (const c of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    const r = weatherCodeLabel(c);
    assert.ok(r.label && r.icon && r.label !== 'Conditions inconnues', `code ${c}`);
  }
  assert.equal(weatherCodeLabel(42).label, 'Conditions inconnues');
  assert.equal(weatherCodeLabel(null).label, 'Conditions inconnues');
  assert.equal(weatherCodeLabel(undefined).icon, '❔');
});

test('fixture prévision : 72 heures, cohérente', () => {
  const h = forecastRaw.hourly;
  for (const k of Object.keys(h)) assert.equal(h[k].length, 72, k);
  for (let i = 1; i < 72; i++) assert.equal(h.time[i] - h.time[i - 1], 3600);
});

// --- geo.js ---------------------------------------------------------------

test('getBrowserPosition : succès et erreurs en français', async () => {
  const ok = { getCurrentPosition: (s) => s({ coords: { latitude: 43.68, longitude: 4.63, accuracy: 25, altitude: null } }) };
  assert.deepEqual(await getBrowserPosition({ geolocation: ok }), { lat: 43.68, lon: 4.63, accuracyM: 25, altitudeM: null });

  const fail = (code) => ({ getCurrentPosition: (s, e) => e({ code, message: 'x' }) });
  await assert.rejects(getBrowserPosition({ geolocation: fail(1) }), (e) => e.code === 'permission' && /refusée/.test(e.message));
  await assert.rejects(getBrowserPosition({ geolocation: fail(2) }), (e) => e.code === 'unavailable' && /indisponible/.test(e.message));
  await assert.rejects(getBrowserPosition({ geolocation: fail(3) }), (e) => e.code === 'timeout' && /Délai dépassé/.test(e.message));

  let passedOpts;
  const spy = { getCurrentPosition: (s, e, o) => { passedOpts = o; s({ coords: { latitude: 1, longitude: 2 } }); } };
  await getBrowserPosition({ timeoutMs: 1234, geolocation: spy });
  assert.equal(passedOpts.timeout, 1234);

  // Node : pas de navigator.geolocation → message « non disponible »
  await assert.rejects(getBrowserPosition(), (e) => /géolocalisation n'est pas disponible|connexion sécurisée/.test(e.message));
});

// --- Météo passée (anciens tirages du journal) ---------------------------------------------
import { buildPastWeatherUrl, fetchPastWeather, ARCHIVE_URL, FORECAST_URL } from '../js/weather.js';

test('buildPastWeatherUrl : passé récent → API de prévision avec UV, ancien → archives', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  const recent = buildPastWeatherUrl(43.68, 4.63, new Date('2026-09-20T12:00:00Z'), now);
  assert.equal(recent.source, 'forecast');
  assert.ok(recent.url.startsWith(FORECAST_URL));
  const u = new URL(recent.url);
  assert.equal(u.searchParams.get('start_date'), '2026-09-19');
  assert.equal(u.searchParams.get('end_date'), '2026-09-21');
  assert.match(u.searchParams.get('hourly'), /uv_index_clear_sky/);
  const old = buildPastWeatherUrl(43.68, 4.63, new Date('2025-07-14T12:00:00Z'), now);
  assert.equal(old.source, 'archive');
  assert.ok(old.url.startsWith(ARCHIVE_URL));
  assert.equal(new URL(old.url).searchParams.get('hourly'), 'cloud_cover,weather_code');
  // La fin de période ne dépasse jamais maintenant.
  const yesterday = buildPastWeatherUrl(43.68, 4.63, new Date('2026-10-16T08:00:00Z'), now);
  assert.equal(new URL(yesterday.url).searchParams.get('end_date'), '2026-10-16');
});

test('fetchPastWeather : réponse d’archives (nuages seuls) exploitable par makeWeatherAt', async () => {
  const t0 = Date.parse('2025-07-13T22:00:00Z') / 1000;
  const raw = {
    latitude: 43.68, longitude: 4.63, elevation: 9, utc_offset_seconds: 7200, timezone: 'Europe/Paris',
    hourly: {
      time: Array.from({ length: 72 }, (_, i) => t0 + i * 3600),
      cloud_cover: Array.from({ length: 72 }, (_, i) => (i % 24 === 12 ? 40 : 10)),
      weather_code: Array.from({ length: 72 }, () => 1),
    },
  };
  const fetchImpl = mockFetch(raw);
  const f = await fetchPastWeather(43.68, 4.63, new Date('2025-07-14T10:00:00Z'), { fetchImpl, now: Date.parse('2026-10-16T12:00:00Z') });
  assert.equal(f.source, 'archive');
  assert.ok(fetchImpl.calls[0].url.startsWith(ARCHIVE_URL));
  const w = makeWeatherAt(f)(new Date('2025-07-14T10:00:00Z')); // 12 h après t0 → 40 %
  assert.equal(w.cloudCoverPct, 40);
  assert.equal(w.uvIndex, null);
});

test('fetchPastWeather : erreurs en français (futur, avant 1940, date invalide, HTTP)', async () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  await assert.rejects(fetchPastWeather(43, 4, new Date('2027-01-01T00:00:00Z'), { now }), /futur/);
  await assert.rejects(fetchPastWeather(43, 4, new Date('1930-06-01T00:00:00Z'), { now }), /1940/);
  await assert.rejects(fetchPastWeather(43, 4, new Date('x'), { now }), /invalide/);
  await assert.rejects(
    fetchPastWeather(43, 4, new Date('2025-06-01T12:00:00Z'), { now, fetchImpl: mockFetch({ error: true, reason: 'bad' }, { status: 400 }) }),
    (e) => e.code === 'http' && /archives météo/.test(e.message),
  );
});
