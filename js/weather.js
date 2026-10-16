// weather.js — Prévisions Open-Meteo + géocodage (agent Données).
// Module ES pur : aucun accès à window/document/navigator au chargement.
// API gratuite, sans clé, CORS autorisé : https://open-meteo.com/en/docs

export const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
// Archives (réanalyse ERA5, horaire, depuis 1940, ~5 jours de retard) pour les tirages anciens.
export const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
// En deçà, l'API de prévision sert aussi le passé récent (jusqu'à 92 jours) avec l'indice UV.
export const RECENT_PAST_DAYS = 85;

const HOURLY_VARS = [
  'cloud_cover', 'uv_index', 'uv_index_clear_sky', 'temperature_2m',
  'relative_humidity_2m', 'shortwave_radiation', 'weather_code',
];
const CURRENT_VARS = ['cloud_cover', 'uv_index', 'temperature_2m', 'relative_humidity_2m', 'weather_code'];

export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_PREFIX = 'cyanocalc:v1:wx:';
const DEFAULT_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

function weatherError(message, code, cause) {
  const err = new Error(message);
  err.code = code; // 'network' | 'http' | 'invalid' | 'timeout' | 'args'
  if (cause !== undefined) err.cause = cause;
  return err;
}

/** Nombre fini ou null (null, undefined, NaN, chaînes non numériques → null). */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isFiniteCoord(v, limit) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= limit;
}

/**
 * Convertit un horodatage Open-Meteo en Date (instant UTC).
 * - nombre : secondes Unix (timeformat=unixtime) — cas nominal ;
 * - chaîne ISO sans fuseau ("2026-10-16T14:00", timeformat=iso8601) : heure locale
 *   du lieu → on retranche utcOffsetSeconds pour obtenir le vrai instant.
 */
function toDate(t, utcOffsetSeconds) {
  if (typeof t === 'number' && Number.isFinite(t)) return new Date(t * 1000);
  if (typeof t === 'string' && t) {
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(t);
    const iso = t.length === 16 ? `${t}:00` : t;
    const ms = Date.parse(hasZone ? iso : `${iso}Z`);
    if (!Number.isFinite(ms)) return null;
    return new Date(hasZone ? ms : ms - (utcOffsetSeconds || 0) * 1000);
  }
  return null;
}

function getLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (ls && typeof ls.getItem === 'function') return ls;
  } catch { /* accès interdit (mode privé, iframe sandbox…) */ }
  return null;
}

function cacheKey(lat, lon) {
  // Arrondi à 0,01° (~1 km) : la résolution des modèles est bien plus grossière.
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Cache (mémoire + localStorage, 10 min)
// ---------------------------------------------------------------------------

const memoryCache = new Map(); // key -> { ts, raw }

function cacheGet(key, now) {
  const mem = memoryCache.get(key);
  if (mem && now - mem.ts < CACHE_TTL_MS && mem.ts <= now) return mem.raw;
  const ls = getLocalStorage();
  if (!ls) return null;
  try {
    const s = ls.getItem(CACHE_PREFIX + key);
    if (!s) return null;
    const obj = JSON.parse(s);
    if (obj && typeof obj.ts === 'number' && now - obj.ts < CACHE_TTL_MS && obj.ts <= now && obj.raw) {
      memoryCache.set(key, { ts: obj.ts, raw: obj.raw });
      return obj.raw;
    }
    ls.removeItem(CACHE_PREFIX + key);
  } catch { /* entrée corrompue ou stockage inaccessible : on ignore */ }
  return null;
}

function cacheSet(key, raw, now) {
  memoryCache.set(key, { ts: now, raw });
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    // Ménage : supprime les entrées météo expirées.
    const stale = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(CACHE_PREFIX) && k !== CACHE_PREFIX + key) {
        try {
          const o = JSON.parse(ls.getItem(k));
          if (!o || typeof o.ts !== 'number' || now - o.ts >= CACHE_TTL_MS) stale.push(k);
        } catch { stale.push(k); }
      }
    }
    stale.forEach((k) => ls.removeItem(k));
    ls.setItem(CACHE_PREFIX + key, JSON.stringify({ ts: now, raw }));
  } catch { /* quota dépassé ou stockage bloqué : le cache mémoire suffit */ }
}

/** Vide le cache météo (mémoire + localStorage). Utile pour forcer un rafraîchissement et pour les tests. */
export function clearWeatherCache() {
  memoryCache.clear();
  geocodeCache.clear();
  const ls = getLocalStorage();
  if (!ls) return;
  try {
    const keys = [];
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => ls.removeItem(k));
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Requête HTTP commune
// ---------------------------------------------------------------------------

async function getJson(url, fetchImpl, timeoutMs, what) {
  const doFetch = fetchImpl
    || (typeof globalThis.fetch === 'function' ? (u, i) => globalThis.fetch(u, i) : null);
  if (typeof doFetch !== 'function') {
    throw weatherError(`Impossible de contacter ${what} : aucune fonction fetch disponible.`, 'network');
  }
  let controller = null;
  let timer = null;
  const init = { headers: { Accept: 'application/json' } };
  if (typeof AbortController === 'function' && timeoutMs > 0) {
    controller = new AbortController();
    init.signal = controller.signal;
    timer = setTimeout(() => controller.abort(), timeoutMs);
  }
  let res;
  try {
    res = await doFetch(url, init);
  } catch (e) {
    if (controller && controller.signal.aborted) {
      throw weatherError(`${capitalize(what)} ne répond pas (délai de ${Math.round(timeoutMs / 1000)} s dépassé). Vérifiez votre connexion ou saisissez les conditions manuellement.`, 'timeout', e);
    }
    throw weatherError(`Impossible de contacter ${what}. Vérifiez votre connexion internet ou saisissez les conditions manuellement.`, 'network', e);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res || typeof res !== 'object') {
    throw weatherError(`Réponse invalide reçue de ${what}.`, 'invalid');
  }
  if (!res.ok) {
    let reason = '';
    try {
      const body = await res.json();
      if (body && typeof body.reason === 'string') reason = ` : ${body.reason}`;
    } catch { /* corps non JSON */ }
    const status = res.status ?? '?';
    throw weatherError(`${capitalize(what)} a renvoyé une erreur (HTTP ${status})${reason}.`, 'http');
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    throw weatherError(`Réponse invalide reçue de ${what} (JSON illisible).`, 'invalid', e);
  }
  if (!data || typeof data !== 'object') {
    throw weatherError(`Réponse invalide reçue de ${what}.`, 'invalid');
  }
  if (data.error === true) {
    throw weatherError(`${capitalize(what)} a signalé une erreur${data.reason ? ` : ${data.reason}` : ''}.`, 'http');
  }
  return data;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Prévisions
// ---------------------------------------------------------------------------

export function buildForecastUrl(lat, lon) {
  const p = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lon.toFixed(4),
    hourly: HOURLY_VARS.join(','),
    current: CURRENT_VARS.join(','),
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: '3',
  });
  return `${FORECAST_URL}?${p.toString()}`;
}

/**
 * Transforme la réponse brute d'Open-Meteo en objet normalisé (voir SPEC §4).
 * Exportée pour pouvoir être testée / réutilisée avec une réponse déjà en mémoire.
 */
export function parseForecast(raw) {
  const invalid = (detail) => weatherError(`Réponse météo invalide : ${detail}.`, 'invalid');
  if (!raw || typeof raw !== 'object') throw invalid('réponse vide');
  const h = raw.hourly;
  if (!h || typeof h !== 'object' || !Array.isArray(h.time)) throw invalid('données horaires absentes');

  const utcOffsetSeconds = num(raw.utc_offset_seconds) ?? 0;
  const col = (name) => (Array.isArray(h[name]) ? h[name] : []);
  const cc = col('cloud_cover'), uv = col('uv_index'), uvc = col('uv_index_clear_sky'),
    t2 = col('temperature_2m'), rh = col('relative_humidity_2m'), sw = col('shortwave_radiation'),
    wc = col('weather_code');

  const hourly = [];
  for (let i = 0; i < h.time.length; i++) {
    const time = toDate(h.time[i], utcOffsetSeconds);
    if (!time) continue;
    const code = num(wc[i]);
    hourly.push({
      time,
      cloudCoverPct: num(cc[i]),
      uvIndex: num(uv[i]),
      uvIndexClearSky: num(uvc[i]),
      temperatureC: num(t2[i]),
      humidityPct: num(rh[i]),
      shortwaveWm2: num(sw[i]),
      weatherCode: code === null ? null : Math.round(code),
    });
  }
  if (hourly.length === 0) throw invalid('aucune heure exploitable');
  hourly.sort((a, b) => a.time - b.time);

  let current;
  const c = raw.current;
  const cTime = c && typeof c === 'object' ? toDate(c.time, utcOffsetSeconds) : null;
  if (cTime) {
    const code = num(c.weather_code);
    current = {
      time: cTime,
      cloudCoverPct: num(c.cloud_cover),
      uvIndex: num(c.uv_index),
      temperatureC: num(c.temperature_2m),
      humidityPct: num(c.relative_humidity_2m),
      weatherCode: code === null ? null : Math.round(code),
    };
  } else {
    // Pas de bloc "current" : on prend l'heure de prévision la plus proche de maintenant.
    const now = Date.now();
    let best = hourly[0];
    for (const x of hourly) if (Math.abs(x.time - now) < Math.abs(best.time - now)) best = x;
    current = {
      time: best.time,
      cloudCoverPct: best.cloudCoverPct,
      uvIndex: best.uvIndex,
      temperatureC: best.temperatureC,
      humidityPct: best.humidityPct,
      weatherCode: best.weatherCode,
    };
  }

  return {
    elevation: num(raw.elevation) ?? 0,
    timezone: typeof raw.timezone === 'string' ? raw.timezone : 'UTC',
    utcOffsetSeconds,
    current,
    hourly,
  };
}

/**
 * Télécharge les prévisions (3 jours, horaires) pour un lieu.
 * Options : fetchImpl (injection pour tests), useCache (défaut true), timeoutMs, now (ms, tests).
 * @returns {Promise<{elevation, timezone, utcOffsetSeconds, current, hourly}>}
 */
export async function fetchForecast(lat, lon, { fetchImpl, useCache = true, timeoutMs = DEFAULT_TIMEOUT_MS, now } = {}) {
  lat = Number(lat);
  lon = Number(lon);
  if (!isFiniteCoord(lat, 90) || !isFiniteCoord(lon, 180)) {
    throw weatherError('Coordonnées invalides : latitude entre -90 et 90, longitude entre -180 et 180.', 'args');
  }
  const t = typeof now === 'number' ? now : Date.now();
  const key = cacheKey(lat, lon);
  if (useCache) {
    const cached = cacheGet(key, t);
    if (cached) {
      try { return parseForecast(cached); } catch { /* cache corrompu : on re-télécharge */ }
    }
  }
  const raw = await getJson(buildForecastUrl(lat, lon), fetchImpl, timeoutMs, 'le service météo (Open-Meteo)');
  const forecast = parseForecast(raw); // lève si invalide → rien n'est mis en cache
  if (useCache) cacheSet(key, raw, t);
  return forecast;
}

// ---------------------------------------------------------------------------
// Météo passée (journal : anciens tirages)
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;
const isoDay = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * URL de la météo horaire autour d'une date passée (veille → lendemain, pour couvrir tout fuseau).
 * Passé récent (< RECENT_PAST_DAYS) : API de prévision (nuages + indice UV). Plus ancien : archives
 * ERA5 (nuages seulement, ce qui suffit au moteur).
 * @returns {{url: string, source: 'forecast'|'archive'}}
 */
export function buildPastWeatherUrl(lat, lon, date, now = Date.now()) {
  const t = date.getTime();
  const recent = now - t < RECENT_PAST_DAYS * DAY_MS;
  const p = new URLSearchParams({
    latitude: Number(lat).toFixed(4),
    longitude: Number(lon).toFixed(4),
    start_date: isoDay(t - DAY_MS),
    end_date: isoDay(Math.min(t + DAY_MS, now)),
    hourly: recent ? 'cloud_cover,uv_index,uv_index_clear_sky,weather_code' : 'cloud_cover,weather_code',
    timezone: 'auto',
    timeformat: 'unixtime',
  });
  return { url: `${recent ? FORECAST_URL : ARCHIVE_URL}?${p.toString()}`, source: recent ? 'forecast' : 'archive' };
}

/**
 * Météo horaire autour d'une date passée, au même format que fetchForecast (+ `source`).
 * À passer à makeWeatherAt pour recalculer le temps de pose qu'aurait prévu le moteur ce jour-là.
 */
export async function fetchPastWeather(lat, lon, date, { fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, now } = {}) {
  lat = Number(lat);
  lon = Number(lon);
  if (!isFiniteCoord(lat, 90) || !isFiniteCoord(lon, 180)) {
    throw weatherError('Coordonnées invalides : latitude entre -90 et 90, longitude entre -180 et 180.', 'args');
  }
  const t = date instanceof Date ? date.getTime() : NaN;
  const nowMs = typeof now === 'number' ? now : Date.now();
  if (!Number.isFinite(t)) throw weatherError('Date du tirage invalide.', 'args');
  if (t > nowMs) throw weatherError('La date du tirage est dans le futur.', 'args');
  if (new Date(t).getUTCFullYear() < 1940) throw weatherError('Les archives météo commencent en 1940.', 'args');
  const { url, source } = buildPastWeatherUrl(lat, lon, new Date(t), nowMs);
  const raw = await getJson(url, fetchImpl, timeoutMs, 'les archives météo (Open-Meteo)');
  return { ...parseForecast(raw), source };
}

// ---------------------------------------------------------------------------
// Interpolation horaire
// ---------------------------------------------------------------------------

const INTERP_FIELDS = ['cloudCoverPct', 'uvIndex', 'uvIndexClearSky', 'temperatureC', 'humidityPct', 'shortwaveWm2'];

function lerpField(a, b, f) {
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return a + (b - a) * f;
}

/**
 * Fabrique weatherAt(date) pour exposure.integratedExposure : interpolation linéaire
 * entre les heures encadrantes. Renvoie null hors de la plage des prévisions ou si
 * aucune donnée utile n'est disponible. Une valeur manquante (null) d'un côté est
 * remplacée par celle de l'autre côté.
 * Champs renvoyés : cloudCoverPct, uvIndex, uvIndexClearSky (+ temperatureC, humidityPct,
 * shortwaveWm2, weatherCode de l'heure la plus proche, en bonus).
 */
export function makeWeatherAt(forecast) {
  const hourly = (forecast && Array.isArray(forecast.hourly) ? forecast.hourly : [])
    .filter((x) => x && x.time instanceof Date && Number.isFinite(x.time.getTime()))
    .slice()
    .sort((a, b) => a.time - b.time);
  const times = hourly.map((x) => x.time.getTime());

  return function weatherAt(date) {
    const t = date instanceof Date ? date.getTime() : Number(date);
    if (!Number.isFinite(t) || times.length === 0) return null;
    if (t < times[0] || t > times[times.length - 1]) return null;

    // Recherche dichotomique du dernier index i tel que times[i] <= t.
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t) lo = mid; else hi = mid - 1;
    }
    const a = hourly[lo];
    const b = hourly[Math.min(lo + 1, hourly.length - 1)];
    const span = times[Math.min(lo + 1, times.length - 1)] - times[lo];
    const f = span > 0 ? (t - times[lo]) / span : 0;

    const out = {};
    for (const k of INTERP_FIELDS) out[k] = lerpField(num(a[k]), num(b[k]), f);
    out.weatherCode = (f < 0.5 ? a : b).weatherCode ?? (f < 0.5 ? b : a).weatherCode ?? null;

    if (out.cloudCoverPct === null && out.uvIndex === null && out.uvIndexClearSky === null) return null;
    if (out.cloudCoverPct !== null) out.cloudCoverPct = Math.min(100, Math.max(0, out.cloudCoverPct));
    return out;
  };
}

// ---------------------------------------------------------------------------
// Géocodage
// ---------------------------------------------------------------------------

const geocodeCache = new Map(); // query normalisée -> { ts, results }

function makeLabel(r) {
  const parts = [];
  for (const p of [r.name, r.admin1, r.country]) {
    if (typeof p === 'string' && p.trim() && !parts.includes(p.trim())) parts.push(p.trim());
  }
  return parts.join(', ');
}

/**
 * Recherche de lieux par nom (Open-Meteo Geocoding, résultats en français).
 * Renvoie [] pour une requête trop courte ou sans résultat.
 */
export async function searchPlace(query, { fetchImpl, count = 5, timeoutMs = DEFAULT_TIMEOUT_MS, useCache = true } = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (q.length < 2) return [];
  const norm = q.toLowerCase();
  if (useCache) {
    const hit = geocodeCache.get(norm);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.results.map((r) => ({ ...r }));
  }
  const p = new URLSearchParams({ name: q, count: String(count), language: 'fr', format: 'json' });
  const data = await getJson(`${GEOCODING_URL}?${p.toString()}`, fetchImpl, timeoutMs, 'le service de recherche de lieux (Open-Meteo)');
  if (data.results !== undefined && !Array.isArray(data.results)) {
    throw weatherError('Réponse invalide du service de recherche de lieux.', 'invalid');
  }
  const results = (data.results || [])
    .map((r) => {
      if (!r || typeof r !== 'object') return null;
      const lat = num(r.latitude), lon = num(r.longitude);
      if (lat === null || lon === null || typeof r.name !== 'string') return null;
      const place = {
        name: r.name,
        admin1: typeof r.admin1 === 'string' ? r.admin1 : '',
        country: typeof r.country === 'string' ? r.country : '',
        lat,
        lon,
        elevation: num(r.elevation),
        countryCode: typeof r.country_code === 'string' ? r.country_code : '',
        timezone: typeof r.timezone === 'string' ? r.timezone : '',
      };
      place.label = makeLabel(place);
      return place;
    })
    .filter(Boolean);
  if (useCache) geocodeCache.set(norm, { ts: Date.now(), results });
  return results.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// Codes météo WMO (Open-Meteo "weather_code")
// ---------------------------------------------------------------------------

const WMO = {
  0: ['Ciel dégagé', '☀️'],
  1: ['Plutôt dégagé', '🌤️'],
  2: ['Partiellement nuageux', '⛅'],
  3: ['Couvert', '☁️'],
  45: ['Brouillard', '🌫️'],
  48: ['Brouillard givrant', '🌫️'],
  51: ['Bruine légère', '🌦️'],
  53: ['Bruine modérée', '🌦️'],
  55: ['Bruine dense', '🌧️'],
  56: ['Bruine verglaçante légère', '🌧️'],
  57: ['Bruine verglaçante dense', '🌧️'],
  61: ['Pluie faible', '🌦️'],
  63: ['Pluie modérée', '🌧️'],
  65: ['Pluie forte', '🌧️'],
  66: ['Pluie verglaçante faible', '🌧️'],
  67: ['Pluie verglaçante forte', '🌧️'],
  71: ['Neige faible', '🌨️'],
  73: ['Neige modérée', '🌨️'],
  75: ['Neige forte', '❄️'],
  77: ['Grains de neige', '🌨️'],
  80: ['Averses de pluie faibles', '🌦️'],
  81: ['Averses de pluie modérées', '🌧️'],
  82: ['Averses de pluie violentes', '⛈️'],
  85: ['Averses de neige faibles', '🌨️'],
  86: ['Averses de neige fortes', '❄️'],
  95: ['Orage', '⛈️'],
  96: ['Orage avec grêle faible', '⛈️'],
  99: ['Orage avec forte grêle', '⛈️'],
};

export function weatherCodeLabel(code) {
  const n = num(code);
  const e = n === null ? null : WMO[Math.round(n)];
  if (!e) return { label: 'Conditions inconnues', icon: '❔' };
  return { label: e[0], icon: e[1] };
}
