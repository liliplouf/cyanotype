// app.js — Orchestration de l'interface : état, DOM, météo, graphique, minuteur, bande test, journal.
// Règle de sécurité : aucune donnée externe (noms de lieux, notes, fichiers importés) n'est insérée
// via innerHTML ; tout passe par textContent / createElement.

import { solarPosition } from './solar.js';
import {
  effectiveUVA,
  settingsFactor,
  integratedExposure,
  dayProfile,
  lampExposureMinutes,
  adviceFor,
} from './exposure.js';
import {
  CHEMISTRY,
  SUBSTRATE,
  COATING,
  HUMIDITY_STATE,
  GLASS,
  NEGATIVE,
  LIGHT_SOURCE,
  RESULT_GOAL,
  getById,
} from './factors.js';
import { fetchForecast, makeWeatherAt, searchPlace, weatherCodeLabel } from './weather.js';
import { getBrowserPosition } from './geo.js';
import * as store from './storage.js';

// ---------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------

const MAX_MINUTES = 360;
const RAD = Math.PI / 180;
const SVGNS = 'http://www.w3.org/2000/svg';
const PARIS = { label: 'Paris, Île-de-France, France', lat: 48.8566, lon: 2.3522, altitudeM: 35, origin: 'default' };

const GROUND = [
  { id: 'normal', label: 'Sol ordinaire (herbe, terre, pavés)', albedo: 0 },
  { id: 'water', label: 'Bord de mer, plan d’eau', albedo: 0.1 },
  { id: 'sand', label: 'Sable clair, béton, mur blanc', albedo: 0.3 },
  { id: 'snow', label: 'Neige fraîche', albedo: 0.8 },
];

const PROCESS = [
  { sel: 'p-chemistry', key: 'chemistry', list: CHEMISTRY },
  { sel: 'p-substrate', key: 'substrate', list: SUBSTRATE },
  { sel: 'p-coating', key: 'coating', list: COATING },
  { sel: 'p-humidity', key: 'humidityState', list: HUMIDITY_STATE },
  { sel: 'p-glass', key: 'glass', list: GLASS },
  { sel: 'p-negative', key: 'negative', list: NEGATIVE },
  { sel: 'p-goal', key: 'resultGoal', list: RESULT_GOAL },
];

const DEFAULTS = {
  place: { ...PARIS },
  startMode: 'now',
  startLocal: '',
  weatherManual: false,
  manualCloud: 0,
  manualUV: '',
  ground: 'normal',
  lightSource: 'sun',
  powerW: null,
  distanceCm: null,
  chemistry: 'classic',
  substrate: 'cotton_paper',
  coating: 'single',
  humidityState: 'dry',
  glass: 'none',
  negative: 'digital_transparency',
  resultGoal: 'standard',
  calibrationId: '',
  stripCount: 5,
  stripStep: 25,
  stripMethod: 'uncover',
};
const PERSIST_KEYS = Object.keys(DEFAULTS).filter((k) => k !== 'startLocal');

const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const RESULT_LABEL = { under: 'Sous-exposé', good: 'Bon', over: 'Surexposé' };

// ---------------------------------------------------------------------------------------------
// État
// ---------------------------------------------------------------------------------------------

const state = {
  ...structuredClone(DEFAULTS),
  forecast: null,
  forecastAt: 0,
  weatherLoading: false,
  weatherError: null,
  result: null,
  profile: null,
  best: null,
};
let calibrations = [];

// ---------------------------------------------------------------------------------------------
// Utilitaires DOM et formatage
// ---------------------------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const pad = (n) => String(n).padStart(2, '0');

/** Crée un élément ; les enfants chaîne deviennent des nœuds texte (jamais du HTML). */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id, text) {
  const n = typeof id === 'string' ? $(id) : id;
  if (n && n.textContent !== text) n.textContent = text;
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function fmtNum(x, d = 0) {
  if (!isNum(x)) return '—';
  return x.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtFactor(f) {
  if (!isNum(f)) return '×1';
  const d = Math.abs(f - Math.round(f * 100) / 100) > 1e-9 ? 3 : Math.abs(f - Math.round(f * 10) / 10) > 1e-9 ? 2 : 1;
  return `×${f.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: Math.min(d, 3) })}`;
}

/** Durée en minutes → « mm:ss » ou « h:mm:ss ». */
function fmtMMSS(min) {
  if (!isNum(min) || min < 0) return '--:--';
  let s = Math.round(min * 60);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/** Durée en toutes lettres (lecteurs d'écran, phrases). */
function fmtWords(min) {
  if (!isNum(min)) return 'inatteignable';
  const s = Math.round(min * 60);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h) return `${h} h ${pad(m)} min`;
  return ss ? `${m} min ${pad(ss)} s` : `${m} min`;
}

// ---- Fuseau horaire du lieu ----
// Open-Meteo fournit utcOffsetSeconds (timezone=auto) : toutes les heures affichées et saisies le
// sont dans le fuseau du lieu. Sans prévisions, on retombe sur l'heure locale du navigateur.

function placeOffsetSec() {
  const f = state.forecast;
  return f && isNum(f.utcOffsetSeconds) ? f.utcOffsetSeconds : null;
}

function offsetSec(date) {
  const o = placeOffsetSec();
  return o !== null ? o : -(date || new Date()).getTimezoneOffset() * 60;
}

function parts(date) {
  const s = new Date(date.getTime() + offsetSec(date) * 1000);
  return { y: s.getUTCFullYear(), mo: s.getUTCMonth(), d: s.getUTCDate(), h: s.getUTCHours(), mi: s.getUTCMinutes(), wd: s.getUTCDay() };
}

function fmtClock(date) {
  if (!(date instanceof Date) || !isNum(date.getTime())) return '—';
  const p = parts(date);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

function dayKey(date) {
  const p = parts(date);
  return `${p.y}-${pad(p.mo + 1)}-${pad(p.d)}`;
}

function fmtInput(date) {
  const p = parts(date);
  return `${dayKey(date)}T${pad(p.h)}:${pad(p.mi)}`;
}

function parseInput(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(str || '');
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const o = placeOffsetSec();
  const date = o !== null ? new Date(Date.UTC(y, mo - 1, d, h, mi) - o * 1000) : new Date(y, mo - 1, d, h, mi);
  return isNum(date.getTime()) ? date : null;
}

function fmtDayLong(date) {
  const p = parts(date);
  return `${JOURS[p.wd]} ${p.d === 1 ? '1er' : p.d} ${MOIS[p.mo]}`;
}

function fmtOffset(sec) {
  const a = Math.abs(sec);
  return `UTC${sec >= 0 ? '+' : '−'}${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}`;
}

function fmtCoord(v, pos, neg) {
  return `${fmtNum(Math.abs(v), 3)}° ${v >= 0 ? pos : neg}`;
}

// ---------------------------------------------------------------------------------------------
// Réglages, sauvegarde
// ---------------------------------------------------------------------------------------------

function applySaved(saved) {
  if (!saved || typeof saved !== 'object') return;
  for (const k of PERSIST_KEYS) {
    if (saved[k] === undefined) continue;
    if (k === 'place') {
      const p = saved.place;
      if (p && isNum(p.lat) && isNum(p.lon)) {
        state.place = {
          label: typeof p.label === 'string' && p.label ? p.label.slice(0, 200) : 'Lieu enregistré',
          lat: clamp(p.lat, -90, 90),
          lon: clamp(p.lon, -180, 180),
          altitudeM: isNum(p.altitudeM) ? p.altitudeM : null,
          origin: typeof p.origin === 'string' ? p.origin : 'saved',
        };
      }
    } else {
      state[k] = saved[k];
    }
  }
  // Validation des identifiants (catalogues susceptibles d'évoluer).
  for (const { key, list } of PROCESS) if (!getById(list, state[key])) state[key] = DEFAULTS[key];
  if (!getById(LIGHT_SOURCE, state.lightSource)) state.lightSource = 'sun';
  if (!getById(GROUND, state.ground)) state.ground = 'normal';
  if (!['now', 'custom'].includes(state.startMode)) state.startMode = 'now';
  if (!['uncover', 'cover'].includes(state.stripMethod)) state.stripMethod = 'uncover';
  state.manualCloud = clamp(Number(state.manualCloud) || 0, 0, 100);
  state.stripCount = clamp(Math.round(Number(state.stripCount) || 5), 2, 12);
  state.stripStep = clamp(Number(state.stripStep) || 25, 5, 100);
  state.weatherManual = Boolean(state.weatherManual);
}

const saveNow = () => {
  const out = {};
  for (const k of PERSIST_KEYS) out[k] = state[k];
  store.saveSettings(out);
};
const save = debounce(saveNow, 400);

// ---------------------------------------------------------------------------------------------
// Paramètres moteur
// ---------------------------------------------------------------------------------------------

function currentCalibration() {
  return calibrations.find((c) => c.id === state.calibrationId) || null;
}

function engineSettings() {
  const cal = currentCalibration();
  return {
    chemistry: state.chemistry,
    substrate: state.substrate,
    coating: state.coating,
    humidityState: state.humidityState,
    glass: state.glass,
    negative: state.negative,
    resultGoal: state.resultGoal,
    calibrationFactor: cal ? cal.factor : 1,
  };
}

function lightSource() {
  return getById(LIGHT_SOURCE, state.lightSource) || LIGHT_SOURCE[0];
}
const isLamp = () => lightSource().kind === 'lamp';
const albedo = () => (getById(GROUND, state.ground) || GROUND[0]).albedo;
const altitude = () => (isNum(state.place.altitudeM) ? state.place.altitudeM : isNum(state.forecast?.elevation) ? state.forecast.elevation : 0);

function startDate() {
  if (state.startMode === 'custom') {
    const d = parseInput(state.startLocal);
    if (d) return d;
  }
  return new Date();
}

// ---- Météo : fonction weatherAt(date) selon le mode ----

let forecastWx = { forecast: null, fn: null };
function forecastWeatherAt() {
  if (!state.forecast) return null;
  if (forecastWx.forecast !== state.forecast) forecastWx = { forecast: state.forecast, fn: makeWeatherAt(state.forecast) };
  return forecastWx.fn;
}

/** Indice UV ciel clair approché (Madronich) si Open-Meteo ne le fournit pas. */
function uvClearEstimate(elevDeg, altM) {
  if (!(elevDeg > 0)) return 0;
  return 12.5 * Math.sin(elevDeg * RAD) ** 2.42 * (1 + 0.06 * clamp(altM / 1000, 0, 6));
}

const isManualWeather = () => state.weatherManual || !state.forecast;

let wxCache = { key: '', fn: null };
function weatherKey(start) {
  if (!isManualWeather()) return `f|${state.forecastAt}`;
  const uv = state.manualUV === '' ? '' : `${state.manualUV}|${Math.floor(start.getTime() / 60000)}`;
  return `m|${state.manualCloud}|${uv}|${state.forecastAt}`;
}

function getWeatherAt(start = startDate()) {
  const key = `${weatherKey(start)}|${state.place.lat},${state.place.lon}`;
  if (wxCache.key === key) return wxCache.fn;
  const fwx = forecastWeatherAt();
  let fn;
  if (!isManualWeather()) {
    fn = fwx;
  } else {
    const { lat, lon } = state.place;
    const alt = altitude();
    const cloud = clamp(Number(state.manualCloud) || 0, 0, 100);
    const uvi = state.manualUV === '' ? NaN : Number(state.manualUV);
    const clearAt = (d) => {
      const w = fwx ? fwx(d) : null;
      if (w && isNum(w.uvIndexClearSky)) return w.uvIndexClearSky;
      return uvClearEstimate(solarPosition(d, lat, lon).elevation, alt);
    };
    let ratio = null;
    if (isNum(uvi) && uvi >= 0) {
      const c0 = clearAt(start);
      if (c0 >= 0.5) ratio = clamp(uvi / c0, 0.03, 1.15);
    }
    fn = (d) => {
      const out = { cloudCoverPct: cloud };
      if (ratio !== null) {
        const c = clearAt(d);
        out.uvIndex = ratio * c;
        out.uvIndexClearSky = c;
      }
      return out;
    };
  }
  wxCache = { key, fn };
  return fn;
}

// ---------------------------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------------------------

let profileCache = { key: '', profile: null };

function computeProfile(start, settings, weatherAt) {
  const key = JSON.stringify([state.place.lat, state.place.lon, altitude(), settings, albedo(), weatherKey(start), dayKey(start), placeOffsetSec()]);
  if (profileCache.key === key) return profileCache.profile;
  const noon = parseInput(`${dayKey(start)}T12:00`) || start;
  const profile = dayProfile({
    day: noon,
    lat: state.place.lat,
    lon: state.place.lon,
    altitudeM: altitude(),
    settings,
    weatherAt,
    albedo: albedo(),
    stepMinutes: 15,
    maxMinutes: MAX_MINUTES,
  });
  profileCache = { key, profile };
  return profile;
}

function findBest(profile, now) {
  if (!profile || !profile.length) return null;
  const sameDay = dayKey(profile[0].t) === dayKey(now);
  const isFuture = (p) => p.t.getTime() >= now.getTime() - 7.5 * 60000;
  let candidates = profile.map((p, i) => ({ p, i })).filter(({ p }) => isNum(p.minutes));
  let remaining = false;
  if (sameDay) {
    const fut = candidates.filter(({ p }) => isFuture(p));
    if (fut.length) {
      candidates = fut;
      remaining = true;
    }
  }
  if (!candidates.length) return null;
  let best = candidates[0];
  for (const c of candidates) if (c.p.minutes < best.p.minutes) best = c;
  const lim = best.p.minutes * 1.1;
  const ok = (i) => isNum(profile[i]?.minutes) && profile[i].minutes <= lim && (!remaining || isFuture(profile[i]));
  let lo = best.i;
  let hi = best.i;
  while (lo > 0 && ok(lo - 1)) lo--;
  while (hi < profile.length - 1 && ok(hi + 1)) hi++;
  return { idx: best.i, lo, hi, from: profile[lo].t, to: profile[hi].t, minutes: best.p.minutes, remaining, sameDay };
}

function compute({ silent = false } = {}) {
  const start = startDate();
  const settings = engineSettings();
  const r = { start, settings, factor: settingsFactor(settings), lamp: isLamp(), error: null };
  try {
    if (r.lamp) {
      const minutes = lampExposureMinutes({ sourceId: state.lightSource, powerW: Number(state.powerW), distanceCm: Number(state.distanceCm), settings });
      r.minutes = isNum(minutes) && minutes > 0 ? minutes : Infinity;
      r.reachable = isNum(r.minutes);
      r.end = r.reachable ? new Date(start.getTime() + r.minutes * 60000) : null;
      state.profile = null;
      state.best = null;
    } else {
      const weatherAt = getWeatherAt(start);
      const ie = integratedExposure({
        start,
        lat: state.place.lat,
        lon: state.place.lon,
        altitudeM: altitude(),
        settings,
        weatherAt,
        albedo: albedo(),
        maxMinutes: MAX_MINUTES,
      });
      Object.assign(r, ie);
      const pos = solarPosition(start, state.place.lat, state.place.lon);
      r.elevation = pos.elevation;
      const w = (weatherAt && weatherAt(start)) || {};
      r.weather = w;
      r.uva = effectiveUVA({
        elevationDeg: pos.elevation,
        altitudeM: altitude(),
        cloudCoverPct: w.cloudCoverPct ?? undefined,
        uvIndex: w.uvIndex ?? undefined,
        uvIndexClearSky: w.uvIndexClearSky ?? undefined,
        albedo: albedo(),
      });
      state.profile = computeProfile(start, settings, weatherAt);
      state.best = findBest(state.profile, new Date());
    }
  } catch (err) {
    console.warn('Erreur de calcul', err);
    r.error = err && err.message ? err.message : String(err);
    r.minutes = NaN;
    r.reachable = false;
  }
  state.result = r;
  renderResult(silent);
  renderWeather();
  renderChart();
  renderStrip();
  renderTimerIdle();
  prefillJournal();
  updateDock();
}

const scheduleCompute = debounce(() => compute(), 120);

function changed() {
  save();
  scheduleCompute();
}

// ---------------------------------------------------------------------------------------------
// Rendu : lieu, météo
// ---------------------------------------------------------------------------------------------

function renderPlace() {
  const p = state.place;
  setText('place-name', p.label || 'Lieu');
  const bits = [fmtCoord(p.lat, 'N', 'S'), fmtCoord(p.lon, 'E', 'O')];
  const alt = altitude();
  bits.push(`${fmtNum(alt, 0)} m${isNum(p.altitudeM) ? '' : ' (auto)'}`);
  const o = placeOffsetSec();
  if (o !== null) bits.push(`${fmtOffset(o)}${state.forecast.timezone ? ` · ${state.forecast.timezone}` : ''}`);
  setText('place-meta', bits.join(' · '));
  $('in-lat').value = String(Math.round(p.lat * 10000) / 10000);
  $('in-lon').value = String(Math.round(p.lon * 10000) / 10000);
  $('in-alt').value = isNum(p.altitudeM) ? String(Math.round(p.altitudeM)) : '';
  const tz = o !== null ? `Heure locale du lieu (${fmtOffset(o)}).` : 'Heure de votre appareil (fuseau du lieu inconnu sans météo).';
  setText('tz-hint', tz);
}

function skyFromCloud(c) {
  if (c < 15) return { label: 'Ciel clair', icon: '☀️' };
  if (c < 45) return { label: 'Peu nuageux', icon: '🌤️' };
  if (c < 80) return { label: 'Partiellement nuageux', icon: '⛅' };
  return { label: 'Couvert', icon: '☁️' };
}

function renderWeather() {
  const manual = isManualWeather();
  const start = state.result?.start || startDate();
  const fwx = forecastWeatherAt();
  const fw = fwx ? fwx(start) : null;

  $('weather-banner').hidden = !state.weatherError;
  if (state.weatherError) setText('weather-banner-msg', state.weatherError);
  $('manual-fields').hidden = !manual;
  $('weather-manual').checked = state.weatherManual;
  $('weather-manual').closest('.check').hidden = !state.forecast;

  let label;
  let icon;
  let cloud = null;
  let uv = null;
  if (manual) {
    cloud = clamp(Number(state.manualCloud) || 0, 0, 100);
    ({ label, icon } = skyFromCloud(cloud));
    label += state.forecast ? ' (saisie manuelle)' : state.weatherLoading ? '' : ' (valeur manuelle)';
    uv = state.manualUV === '' ? null : Number(state.manualUV);
  } else if (fw) {
    ({ label, icon } = isNum(fw.weatherCode) ? weatherCodeLabel(fw.weatherCode) : skyFromCloud(fw.cloudCoverPct ?? 0));
    cloud = fw.cloudCoverPct;
    uv = fw.uvIndex;
  } else {
    label = 'Hors de la période de prévision';
    icon = '❔';
  }
  setText('w-icon', icon);
  setText('w-label', label);
  setText('w-cloud', isNum(cloud) ? `${fmtNum(cloud, 0)} %` : '—');
  setText('w-uv', isNum(uv) ? fmtNum(uv, 1) : '—');
  setText('w-temp', fw && isNum(fw.temperatureC) ? `${fmtNum(fw.temperatureC, 0)} °C` : '—');
  setText('w-hum', fw && isNum(fw.humidityPct) ? `${fmtNum(fw.humidityPct, 0)} %` : '—');

  let src;
  if (state.weatherLoading) src = 'Chargement des prévisions Open-Meteo…';
  else if (state.forecast && !fw) src = 'Date hors des 3 jours de prévision : ciel clair supposé (ou saisissez la météo).';
  else if (state.forecast) src = `Prévision Open-Meteo pour ${fmtClock(start)}${state.weatherManual ? ' — remplacée par votre saisie' : ''} · mise à jour à ${fmtClock(new Date(state.forecastAt))}`;
  else src = 'Sans prévisions : ciel clair par défaut, ajustez les valeurs ci-dessous.';
  setText('w-source', src);
  setText('manual-cloud-out', `${fmtNum(Number(state.manualCloud) || 0, 0)} %`);
}

// ---------------------------------------------------------------------------------------------
// Rendu : résultat
// ---------------------------------------------------------------------------------------------

function renderResult(silent) {
  const r = state.result;
  const live = $('result-live');
  if (silent) live.setAttribute('aria-live', 'off');

  const big = $('res-time');
  big.classList.remove('is-long', 'is-na');
  const now = new Date();
  const otherDay = dayKey(r.start) !== dayKey(now);
  const startTxt = state.startMode === 'now' ? `maintenant (${fmtClock(r.start)})` : `${otherDay ? `${fmtDayLong(r.start)}, ` : ''}${fmtClock(r.start)}`;

  if (r.error) {
    setText(big, '--:--');
    setText('res-sub', `Calcul impossible : ${r.error}`);
  } else if (r.reachable) {
    const txt = fmtMMSS(r.minutes);
    setText(big, txt);
    if (txt.length > 5) big.classList.add('is-long');
    setText('res-sub', `${r.minutes >= 60 ? 'h:min:s' : 'min:s'} · ${fmtWords(r.minutes)} · fin vers ${fmtClock(r.end)}`);
  } else {
    big.classList.add('is-na');
    setText(big, 'Inatteignable');
    let why;
    if (r.lamp) why = 'Vérifiez la puissance et la distance de la lampe.';
    else if (r.limitedBy === 'sunset' || r.elevation <= 0) why = `Le soleil se couche avant d'atteindre la dose (${fmtNum((r.fractionReached || 0) * 100, 0)} % atteints).`;
    else why = `Plus de ${MAX_MINUTES / 60} h de pose nécessaires dans ces conditions.`;
    setText('res-sub', why);
  }
  setText('res-range', r.reachable ? `Fourchette : ${fmtMMSS(r.minutes * 0.8)} – ${fmtMMSS(r.minutes * 1.25)} (−20 % / +25 %)` : '');
  const ctx = [state.place.label.split(',')[0], state.startMode === 'now' ? `départ ${fmtClock(r.start)}` : `départ ${startTxt}`];
  if (!r.lamp) {
    const w = r.weather || {};
    if (isNum(w.cloudCoverPct)) ctx.push(`nuages ${fmtNum(w.cloudCoverPct, 0)} %`);
    if (!state.forecast) ctx.push(state.weatherLoading ? 'météo…' : 'sans météo');
  } else {
    ctx.push(lightSource().label);
  }
  setText('res-context', ctx.join(' · '));
  $('res-calib').hidden = Boolean(currentCalibration());
  setText('res-end', r.reachable ? fmtClock(r.end) : '—');
  setText('res-elev', r.lamp ? '—' : `${fmtNum(r.elevation, 0)}°`);
  setText('res-uva', r.lamp ? '—' : `${fmtNum(r.uva, 2)}`);

  // Meilleur créneau
  const bestEl = $('res-best');
  const b = state.best;
  if (!r.lamp && b) {
    bestEl.hidden = false;
    bestEl.replaceChildren(
      `${b.remaining ? 'Meilleur créneau restant' : b.sameDay ? 'Meilleur créneau (passé)' : 'Meilleur créneau'} : `,
      el('strong', {}, `${fmtClock(b.from)} – ${fmtClock(b.to)}`),
      `, environ ${fmtWords(b.minutes)} de pose.`,
    );
  } else {
    bestEl.hidden = true;
  }

  // Conseils
  let advice = [];
  try {
    if (r.lamp) {
      advice = [
        'Lampe UV : gardez la distance constante et centrez le châssis — les bords reçoivent moins de lumière.',
        'Les lampes chauffent : ventilez et vérifiez que le négatif ne colle pas.',
      ];
      if (r.reachable && r.minutes > 45) advice.push('Pose longue : rapprochez la lampe (le temps varie comme le carré de la distance).');
    } else {
      const w = r.weather || {};
      advice = adviceFor({
        elevationDeg: r.elevation,
        cloudCoverPct: isNum(w.cloudCoverPct) ? w.cloudCoverPct : undefined,
        minutes: r.reachable ? r.minutes : Infinity,
        humidityPct: isNum(w.humidityPct) ? w.humidityPct : undefined,
        temperatureC: isNum(w.temperatureC) ? w.temperatureC : undefined,
      });
    }
  } catch (e) {
    console.warn(e);
  }
  $('res-advice').replaceChildren(...advice.map((a) => el('li', {}, a)));
  setText('advice-count', `(${advice.length})`);
  setText('process-factor', fmtFactor(r.factor));

  if (silent) setTimeout(() => live.setAttribute('aria-live', 'polite'), 250);
}

// ---------------------------------------------------------------------------------------------
// Graphique de la journée (SVG fait main)
// ---------------------------------------------------------------------------------------------

let chart = null; // modèle courant pour l'interaction
let hoverIdx = null;

function niceStep(range, target) {
  const steps = [1, 2, 5, 10, 15, 20, 30, 60, 90, 120];
  for (const s of steps) if (range / s <= target) return s;
  return 180;
}

function niceCeil(v) {
  if (v <= 5) return 5;
  if (v <= 10) return 10;
  if (v <= 15) return 15;
  if (v <= 20) return 20;
  if (v <= 30) return 30;
  if (v <= 45) return 45;
  if (v <= 60) return 60;
  if (v <= 90) return 90;
  if (v <= 120) return 120;
  if (v <= 180) return 180;
  if (v <= 240) return 240;
  return 360;
}

function renderChart() {
  const wrap = $('chart-wrap');
  const root = $('chart');
  const empty = $('chart-empty');
  const tbody = $('chart-table').querySelector('tbody');
  const title = $('chart-title');
  root.replaceChildren(title);
  hideTip();
  chart = null;
  const r = state.result;
  const prof = state.profile;

  const showEmpty = (msg) => {
    empty.hidden = false;
    empty.textContent = msg;
    root.setAttribute('viewBox', `0 0 ${wrap.clientWidth || 600} 220`);
    root.setAttribute('height', '220');
    tbody.replaceChildren();
    setText('chart-subtitle', '');
  };
  if (!r || r.lamp) return showEmpty('Le graphique de la journée concerne la pose au soleil. Avec une lampe, le temps ne dépend pas de l’heure.');
  if (!prof || prof.length < 2) return showEmpty('Le soleil ne se lève pas ce jour-là à cet endroit : pas de pose au soleil possible.');
  empty.hidden = true;

  const start = r.start;
  setText('chart-subtitle', `${fmtDayLong(prof[0].t)} — lever ${fmtClock(prof[0].t)}, coucher ≈ ${fmtClock(prof[prof.length - 1].t)}`);

  const W = Math.max(280, Math.round(wrap.clientWidth || 600));
  const H = W < 520 ? 250 : 300;
  const m = { l: 46, r: 38, t: 26, b: 30 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  root.setAttribute('viewBox', `0 0 ${W} ${H}`);
  root.setAttribute('width', String(W));
  root.setAttribute('height', String(H));

  const t0 = prof[0].t.getTime();
  const t1 = prof[prof.length - 1].t.getTime();
  const x = (t) => m.l + ((t instanceof Date ? t.getTime() : t) - t0) / (t1 - t0) * pw;

  const finite = prof.map((p) => p.minutes).filter(isNum);
  const minM = finite.length ? Math.min(...finite) : 10;
  const maxM = finite.length ? Math.max(...finite) : 60;
  // Plafond « intelligent » : on montre surtout la zone utile (≈ 4× le minimum), sans écraser la courbe.
  const cap = niceCeil(Math.max(5, Math.min(maxM, Math.max(minM * 4, minM + 20))));
  const yM = (v) => m.t + ph - (Math.min(v, cap) / cap) * ph;
  const maxElev = Math.max(...prof.map((p) => p.elevation), 10);
  const eTop = Math.min(90, Math.ceil(maxElev / 10) * 10);
  const yE = (e) => m.t + ph - (clamp(e, 0, eTop) / eTop) * ph;

  const g = (cls) => svg('g', { class: cls });
  const gGrid = g('c-grid-g');
  const gBack = g('c-back');
  const gFront = g('c-front');
  root.append(gGrid, gBack, gFront);

  // Grille et axe Y (minutes)
  const yStep = niceStep(cap, 5);
  for (let v = 0; v <= cap + 1e-9; v += yStep) {
    const y = yM(v);
    gGrid.append(svg('line', { class: 'c-grid', x1: m.l, x2: W - m.r, y1: y, y2: y }));
    gGrid.append(svg('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, yStep % 60 === 0 && v > 0 ? `${v / 60} h` : String(v)));
  }
  gGrid.append(svg('text', { x: m.l - 8, y: m.t - 12, 'text-anchor': 'end', class: 'c-unit' }, 'min'));
  // Axe droit (élévation)
  for (const e of [0, eTop / 2, eTop]) {
    gGrid.append(svg('text', { x: W - m.r + 6, y: yE(e) + 4, 'text-anchor': 'start' }, `${Math.round(e)}°`));
  }
  gGrid.append(svg('text', { x: W - m.r + 6, y: m.t - 12, 'text-anchor': 'start', class: 'c-unit' }, 'soleil'));

  // Axe X : heures locales du lieu
  const off = offsetSec(prof[0].t) * 1000;
  const hourMs = 3600000;
  const hours = (t1 - t0) / hourMs;
  const xStepH = pw / hours > 55 ? 1 : pw / hours > 28 ? 2 : 3;
  const firstHour = Math.ceil((t0 + off) / hourMs) * hourMs - off;
  gGrid.append(svg('line', { class: 'c-axis', x1: m.l, x2: W - m.r, y1: m.t + ph, y2: m.t + ph }));
  for (let t = firstHour; t <= t1; t += hourMs) {
    const h = parts(new Date(t)).h;
    if (h % xStepH !== 0) continue;
    const xx = x(t);
    gGrid.append(svg('line', { class: 'c-grid', x1: xx, x2: xx, y1: m.t, y2: m.t + ph, 'stroke-dasharray': '2 4' }));
    gGrid.append(svg('text', { x: xx, y: H - 10, 'text-anchor': 'middle' }, `${h}h`));
  }

  // Nuages : barres discrètes « suspendues » en haut du graphique, une par heure
  const weatherAt = getWeatherAt(start);
  const hourPx = pw / hours;
  const cloudRows = new Map();
  if (weatherAt) {
    for (let t = firstHour; t <= t1; t += hourMs) {
      const w = weatherAt(new Date(t));
      const c = w && isNum(w.cloudCoverPct) ? w.cloudCoverPct : null;
      cloudRows.set(t, c);
      if (!c) continue;
      const bh = (c / 100) * ph * 0.3;
      const bw = Math.max(3, hourPx * 0.62);
      gBack.append(svg('rect', { class: 'c-cloud', x: x(t) - bw / 2, y: m.t, width: bw, height: bh, rx: 2 }));
    }
  }

  // Élévation solaire en aire légère
  let dE = `M${x(prof[0].t).toFixed(1)},${yE(0).toFixed(1)}`;
  let dEl = '';
  prof.forEach((p, i) => {
    const seg = `${x(p.t).toFixed(1)},${yE(p.elevation).toFixed(1)}`;
    dE += ` L${seg}`;
    dEl += `${i ? ' L' : 'M'}${seg}`;
  });
  dE += ` L${x(prof[prof.length - 1].t).toFixed(1)},${yE(0).toFixed(1)} Z`;
  gBack.append(svg('path', { class: 'c-elev', d: dE }));
  gBack.append(svg('path', { class: 'c-elev-line', d: dEl }));

  // Meilleur créneau
  const b = state.best;
  const stepPx = pw / (prof.length - 1);
  if (b) {
    const bx0 = Math.max(m.l, x(b.from) - stepPx / 2);
    const bx1 = Math.min(W - m.r, x(b.to) + stepPx / 2);
    gBack.append(svg('rect', { class: 'c-best', x: bx0, y: m.t, width: Math.max(4, bx1 - bx0), height: ph, rx: 4 }));
    const lx = clamp((bx0 + bx1) / 2, m.l + 30, W - m.r - 30);
    gBack.append(svg('text', { class: 'c-best-label', x: lx, y: m.t + ph - 8, 'text-anchor': 'middle' }, 'meilleur'));
  }

  // Courbe du temps de pose (coupée au-dessus du plafond, pointillée en haut si > plafond)
  let dLine = '';
  let dOver = '';
  let prevIn = false;
  let prevOver = false;
  prof.forEach((p) => {
    const xx = x(p.t).toFixed(1);
    if (isNum(p.minutes) && p.minutes <= cap) {
      dLine += `${prevIn ? ' L' : ' M'}${xx},${yM(p.minutes).toFixed(1)}`;
      prevIn = true;
      prevOver = false;
    } else if (isNum(p.minutes)) {
      dOver += `${prevOver ? ' L' : ' M'}${xx},${m.t.toFixed(1)}`;
      prevOver = true;
      prevIn = false;
    } else {
      prevIn = false;
      prevOver = false;
    }
  });
  if (dOver) gFront.append(svg('path', { class: 'c-over', d: dOver.trim() }));
  if (dLine) gFront.append(svg('path', { class: 'c-line', d: dLine.trim() }));
  if (b && isNum(b.minutes)) gFront.append(svg('circle', { class: 'c-best-dot', cx: x(prof[b.idx].t), cy: yM(b.minutes), r: 5 }));

  // Ligne « maintenant »
  const nowMs = Date.now();
  if (nowMs >= t0 && nowMs <= t1) {
    const nx = x(nowMs);
    gFront.append(svg('line', { class: 'c-now', x1: nx, x2: nx, y1: m.t - 4, y2: m.t + ph }));
    const anchor = nx > W - m.r - 40 ? 'end' : nx < m.l + 40 ? 'start' : 'middle';
    gFront.append(svg('text', { class: 'c-now-label', x: nx, y: m.t - 9, 'text-anchor': anchor }, 'maintenant'));
  }

  // Départ choisi
  const sMs = start.getTime();
  if (sMs >= t0 && sMs <= t1 && !(state.startMode === 'now' && Math.abs(sMs - nowMs) < 60000)) {
    const sx = x(sMs);
    gFront.append(svg('line', { class: 'c-sel', x1: sx, x2: sx, y1: m.t, y2: m.t + ph }));
  }
  if (sMs >= t0 && sMs <= t1 && isNum(r.minutes)) {
    gFront.append(svg('circle', { class: 'c-sel-dot', cx: x(sMs), cy: yM(r.minutes), r: 6 }));
  }

  // Calques d'interaction
  const gHover = g('c-hover-g');
  root.append(gHover);
  root.append(svg('rect', { x: m.l - 10, y: 0, width: pw + 20, height: H, fill: 'transparent' }));

  chart = { prof, x, yM, W, H, m, cap, gHover, cloudRows, weatherAt };
  if (hoverIdx !== null && document.activeElement === wrap) setHover(Math.min(hoverIdx, prof.length - 1));

  // Tableau de données accessible (une ligne par heure)
  const rows = prof.filter((p) => parts(p.t).mi === 0).map((p) => {
    const w = weatherAt ? weatherAt(p.t) : null;
    return el('tr', {},
      el('td', {}, fmtClock(p.t)),
      el('td', {}, isNum(p.minutes) ? fmtMMSS(p.minutes) : 'inatteignable'),
      el('td', {}, `${fmtNum(p.elevation, 0)}°`),
      el('td', {}, w && isNum(w.cloudCoverPct) ? `${fmtNum(w.cloudCoverPct, 0)} %` : '—'));
  });
  tbody.replaceChildren(...rows);
}

function idxFromClientX(clientX) {
  if (!chart) return null;
  const rect = $('chart').getBoundingClientRect();
  const px = (clientX - rect.left) * (chart.W / rect.width);
  if (px < chart.m.l - 12 || px > chart.W - chart.m.r + 12) return null;
  let best = 0;
  let bd = Infinity;
  chart.prof.forEach((p, i) => {
    const d = Math.abs(chart.x(p.t) - px);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

function hideTip() {
  $('chart-tip').hidden = true;
  if (chart) chart.gHover.replaceChildren();
}

function setHover(i) {
  hoverIdx = i;
  if (!chart || i === null || i === undefined) return hideTip();
  const p = chart.prof[i];
  const xx = chart.x(p.t);
  const yy = isNum(p.minutes) ? chart.yM(p.minutes) : chart.m.t;
  chart.gHover.replaceChildren(
    svg('line', { class: 'c-hover', x1: xx, x2: xx, y1: chart.m.t, y2: chart.m.t + (chart.H - chart.m.t - chart.m.b) }),
    svg('circle', { class: 'c-hover-dot', cx: xx, cy: yy, r: 5.5 }),
  );
  const w = chart.weatherAt ? chart.weatherAt(p.t) : null;
  const tip = $('chart-tip');
  const end = isNum(p.minutes) ? new Date(p.t.getTime() + p.minutes * 60000) : null;
  tip.replaceChildren(
    el('strong', {}, `Départ ${fmtClock(p.t)}`),
    el('span', {}, `Pose : ${isNum(p.minutes) ? `${fmtMMSS(p.minutes)}${end ? ` (fin ${fmtClock(end)})` : ''}` : 'inatteignable'}`),
    el('span', {}, `Soleil : ${fmtNum(p.elevation, 0)}° · UV-A ${fmtNum(p.uva, 2)}`),
    el('span', {}, `Nuages : ${w && isNum(w.cloudCoverPct) ? `${fmtNum(w.cloudCoverPct, 0)} %` : '—'}`),
    el('span', {}, 'Cliquer / Entrée : choisir cette heure'),
  );
  tip.hidden = false;
  const wrapW = $('chart-wrap').clientWidth;
  const scale = wrapW / chart.W;
  const left = clamp(xx * scale, 85, wrapW - 85);
  tip.style.left = `${left}px`;
  if (yy * scale < 120) {
    tip.style.top = `${yy * scale + 24}px`;
    tip.style.transform = 'translate(-50%, 0)';
  } else {
    tip.style.top = `${yy * scale}px`;
    tip.style.transform = '';
  }
}

function chooseProfileIndex(i) {
  if (!chart || i === null) return;
  const p = chart.prof[i];
  state.startMode = 'custom';
  state.startLocal = fmtInput(p.t);
  syncStartControls();
  setText('geo-status', '');
  changed();
}

function bindChart() {
  const wrap = $('chart-wrap');
  const root = $('chart');
  root.addEventListener('pointermove', (e) => setHover(idxFromClientX(e.clientX)));
  root.addEventListener('pointerdown', (e) => setHover(idxFromClientX(e.clientX)));
  root.addEventListener('pointerleave', () => {
    if (document.activeElement !== wrap) setHover(null);
  });
  root.addEventListener('click', (e) => chooseProfileIndex(idxFromClientX(e.clientX)));
  wrap.addEventListener('focus', () => {
    if (!chart) return;
    const sMs = state.result?.start?.getTime() ?? Date.now();
    let best = state.best ? state.best.idx : 0;
    let bd = Infinity;
    chart.prof.forEach((p, i) => {
      const d = Math.abs(p.t.getTime() - sMs);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    setHover(best);
  });
  wrap.addEventListener('blur', () => setHover(null));
  wrap.addEventListener('keydown', (e) => {
    if (!chart) return;
    const n = chart.prof.length;
    let i = hoverIdx ?? 0;
    if (e.key === 'ArrowRight') i = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseProfileIndex(i);
      return;
    } else return;
    e.preventDefault();
    setHover(i);
  });
  let raf = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (state.result) renderChart();
    });
  });
  ro.observe(wrap);
}

// ---------------------------------------------------------------------------------------------
// Bande test
// ---------------------------------------------------------------------------------------------

function stripPlan() {
  const n = clamp(Math.round(Number(state.stripCount) || 5), 2, 12);
  const step = clamp(Number(state.stripStep) || 25, 5, 100);
  let clipped = false;
  const bands = [];
  for (let k = 0; k < n; k++) {
    const pct = (k - (n - 1) / 2) * step;
    let mult = 1 + pct / 100;
    if (mult < 0.05) {
      mult = 0.05;
      clipped = true;
    }
    bands.push({ num: k + 1, pct, mult });
  }
  const M = Math.max(...bands.map((b) => b.mult));
  return { n, step, bands, M, clipped };
}

function renderStrip() {
  const r = state.result;
  const plan = stripPlan();
  const base = r && r.reachable ? r.minutes : null;
  const uncover = state.stripMethod === 'uncover';
  setText('strip-base', base ? fmtMMSS(base) : 'indisponible');
  setText('strip-action-head', uncover ? 'Découvrir à t =' : 'Couvrir à t =');

  const ordered = [...plan.bands].sort((a, b) => (uncover ? b.mult - a.mult : a.mult - b.mult));
  const rows = ordered.map((b) => {
    const at = uncover ? (plan.M - b.mult) * (base ?? NaN) : b.mult * (base ?? NaN);
    const shade = Math.round(25 + 70 * (b.mult / plan.M));
    const swatch = el('span', { class: 'strip-band', 'aria-hidden': 'true' });
    swatch.style.background = `color-mix(in srgb, #0b3d91 ${shade}%, #f7f4ec)`;
    const tr = el('tr', { class: Math.abs(b.pct) < 1e-9 ? 'is-ref' : null },
      el('td', {}, swatch, `Bande ${b.num}`),
      el('td', {}, b.pct === 0 ? 'référence' : `${b.pct > 0 ? '+' : '−'}${fmtNum(Math.abs(b.pct), 0)} %`),
      el('td', {}, base ? fmtMMSS(b.mult * base) : '—'),
      el('td', {}, base ? `${fmtMMSS(at)}${!uncover && b.mult === plan.M ? ' (fin)' : ''}` : '—'));
    return tr;
  });
  $('strip-table').querySelector('tbody').replaceChildren(...rows);

  const total = base ? fmtMMSS(plan.M * base) : '—';
  const first = ordered[0];
  setText('strip-howto', uncover
    ? `Couvrez toute la bande test d'un carton opaque. Au top départ, découvrez la bande ${first.num} ; puis découvrez chaque bande au temps indiqué (on laisse les bandes déjà découvertes exposées). Arrêtez tout à t = ${total}. La bande ${plan.bands[plan.n - 1].num} reçoit la pose la plus longue.`
    : `Laissez toute la bande test découverte. Au top départ, lancez la pose ; glissez ensuite le carton pour couvrir chaque bande au temps indiqué. La dernière bande est couverte à t = ${total} (fin).`);
  setText('strip-warning', plan.clipped
    ? 'Attention : avec ce pas, les bandes les plus courtes tomberaient à 0 % ou moins — elles sont limitées à 5 % du temps calculé. Réduisez le pas ou le nombre de bandes.'
    : 'Temps calculés pour une lumière constante ; le minuteur bande test suit la dose réelle et bipe à chaque étape.');
  $('btn-strip-timer').disabled = !base;
}

// ---------------------------------------------------------------------------------------------
// Minuteur (dose intégrée)
// ---------------------------------------------------------------------------------------------

const timer = {
  status: 'idle', // idle | running | paused | done
  base: 0, // fraction de dose déjà reçue avant le segment courant
  seg: null,
  runMsBefore: 0,
  multiplier: 1,
  milestones: [],
  label: 'Pose',
  kind: 'normal',
  predicted: null,
  interval: null,
  wakeLock: null,
};
let audioCtx = null;

function ensureAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {
    audioCtx = null;
  }
}

function beep(count = 1, freq = 880, dur = 0.18, gap = 0.14) {
  if (!audioCtx) return;
  try {
    let t = audioCtx.currentTime + 0.03;
    for (let i = 0; i < count; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.45, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur + 0.03);
      t += dur + gap;
    }
  } catch {
    /* audio indisponible */
  }
}

function vibrate(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern);
  } catch {
    /* ignore */
  }
}

function requestNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      const p = Notification.requestPermission();
      if (p && p.catch) p.catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, tag: 'cyanotype-timer', lang: 'fr' });
    }
  } catch {
    /* certains mobiles exigent un service worker : le bip et la vibration suffisent */
  }
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !timer.wakeLock && document.visibilityState === 'visible') {
      const lock = await navigator.wakeLock.request('screen');
      timer.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (timer.wakeLock === lock) timer.wakeLock = null;
      });
    }
  } catch {
    /* refusé ou non supporté */
  }
}

function releaseWakeLock() {
  try {
    if (timer.wakeLock) timer.wakeLock.release();
  } catch {
    /* ignore */
  }
  timer.wakeLock = null;
}

/** Nouveau segment de dose à partir de maintenant pour la fraction restante. */
function newSegment() {
  const now = new Date();
  const remaining = Math.max(1e-6, 1 - timer.base);
  const s = engineSettings();
  s.calibrationFactor = (s.calibrationFactor || 1) * timer.multiplier * remaining;
  if (isLamp()) {
    const minutes = lampExposureMinutes({ sourceId: state.lightSource, powerW: Number(state.powerW), distanceCm: Number(state.distanceCm), settings: s });
    timer.seg = { start: now.getTime(), minutes, curve: null, reachable: isNum(minutes) && minutes > 0 };
  } else {
    const ie = integratedExposure({
      start: now,
      lat: state.place.lat,
      lon: state.place.lon,
      altitudeM: altitude(),
      settings: s,
      weatherAt: getWeatherAt(now),
      albedo: albedo(),
      maxMinutes: MAX_MINUTES,
    });
    const curve = ie.doseCurve.map((p) => ({ m: (p.t.getTime() - now.getTime()) / 60000, c: p.cumulative }));
    timer.seg = { start: now.getTime(), minutes: ie.minutes, curve, reachable: ie.reachable };
  }
}

function segFrac(elMin) {
  const seg = timer.seg;
  if (!seg) return 0;
  if (!seg.curve || seg.curve.length < 2) return seg.reachable ? clamp(elMin / seg.minutes, 0, 1) : 0;
  const c = seg.curve;
  if (elMin <= 0) return 0;
  if (elMin >= c[c.length - 1].m) return seg.reachable ? 1 : c[c.length - 1].c;
  let lo = 0;
  let hi = c.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c[mid].m <= elMin) lo = mid;
    else hi = mid;
  }
  const span = c[hi].m - c[lo].m;
  return clamp(c[lo].c + (span > 0 ? ((c[hi].c - c[lo].c) * (elMin - c[lo].m)) / span : 0), 0, 1);
}

/** Minutes (depuis le début du segment) pour atteindre la fraction f du segment. */
function segTimeFor(f) {
  const seg = timer.seg;
  if (!seg) return NaN;
  if (!seg.curve || seg.curve.length < 2) return seg.reachable ? f * seg.minutes : NaN;
  const c = seg.curve;
  for (let i = 1; i < c.length; i++) {
    if (c[i].c >= f) {
      const d = c[i].c - c[i - 1].c;
      return c[i - 1].m + (d > 0 ? ((f - c[i - 1].c) / d) * (c[i].m - c[i - 1].m) : 0);
    }
  }
  return NaN;
}

function timerProgress() {
  if (!timer.seg) return { frac: timer.base, elSeg: 0 };
  const elSeg = timer.status === 'running' ? (Date.now() - timer.seg.start) / 60000 : 0;
  const frac = timer.status === 'running' ? timer.base + (1 - timer.base) * segFrac(elSeg) : timer.base;
  return { frac, elSeg };
}

function startTimer({ kind = 'normal', multiplier = 1, milestones = [], label = 'Pose' } = {}) {
  ensureAudio();
  requestNotificationPermission();
  stopInterval();
  Object.assign(timer, {
    status: 'running',
    base: 0,
    runMsBefore: 0,
    multiplier,
    milestones: milestones.map((x) => ({ ...x, fired: false })),
    label,
    kind,
  });
  newSegment();
  timer.predicted = state.result && state.result.reachable ? state.result.minutes : timer.seg.minutes;
  acquireWakeLock();
  const msgs = [];
  if (kind === 'strip') {
    msgs.push(state.stripMethod === 'uncover'
      ? `C'est parti : découvrez la bande ${stripPlan().bands[stripPlan().n - 1].num} maintenant.`
      : 'C’est parti : toutes les bandes sont exposées.');
  } else {
    msgs.push(`Pose démarrée à ${fmtClock(new Date())}.`);
  }
  if (state.startMode === 'custom' && Math.abs(startDate().getTime() - Date.now()) > 5 * 60000) {
    msgs.push('Le minuteur part de maintenant, pas de l’heure choisie.');
  }
  if (!timer.seg.reachable) msgs.push('Attention : la dose ne sera pas atteinte avant le coucher du soleil.');
  setText('timer-status', msgs.join(' '));
  beep(1, 660, 0.12);
  timer.interval = setInterval(tick, 250);
  tick();
  $('minuteur').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function stopInterval() {
  if (timer.interval) clearInterval(timer.interval);
  timer.interval = null;
}

function pauseTimer() {
  if (timer.status !== 'running') return;
  const { frac, elSeg } = timerProgress();
  timer.pausedRemaining = timer.seg.reachable ? Math.max(0, timer.seg.minutes - elSeg) : NaN;
  timer.runMsBefore += Date.now() - timer.seg.start;
  timer.base = frac;
  timer.status = 'paused';
  stopInterval();
  releaseWakeLock();
  setText('timer-status', `En pause — ${fmtNum(frac * 100, 0)} % de la dose reçue. Couvrez le châssis.`);
  renderTimer();
}

function resumeTimer() {
  if (timer.status !== 'paused') return;
  ensureAudio();
  timer.status = 'running';
  newSegment();
  acquireWakeLock();
  setText('timer-status', 'Reprise : le temps restant est recalculé avec le soleil actuel.');
  timer.interval = setInterval(tick, 250);
  tick();
}

function cancelTimer() {
  stopInterval();
  releaseWakeLock();
  Object.assign(timer, { status: 'idle', base: 0, seg: null, runMsBefore: 0, milestones: [] });
  setText('timer-status', 'Minuteur annulé.');
  setText('timer-step', '');
  $('timer-step').hidden = true;
  document.title = baseTitle;
  renderTimer();
  renderTimerIdle();
}

function finishTimer() {
  const elapsedMin = (timer.runMsBefore + (Date.now() - timer.seg.start)) / 60000;
  stopInterval();
  releaseWakeLock();
  timer.status = 'done';
  timer.base = 1;
  timer.elapsed = elapsedMin;
  const msg = timer.kind === 'strip'
    ? `Bande test terminée (${fmtWords(elapsedMin)}). Rincez, puis notez la meilleure bande.`
    : `Pose terminée en ${fmtWords(elapsedMin)} ! Retirez le châssis et rincez.`;
  setText('timer-status', msg);
  $('timer-step').hidden = true;
  beep(3, 988, 0.22, 0.12);
  setTimeout(() => beep(3, 988, 0.22, 0.12), 1200);
  vibrate([300, 150, 300, 150, 600]);
  notify('Cyanotype : pose terminée', msg);
  document.title = `✓ Terminé — ${baseTitle}`;
  if (timer.kind === 'normal') {
    const pred = $('j-predicted');
    if (isNum(timer.predicted)) {
      pred.value = String(Math.round(timer.predicted * 100) / 100);
      pred.dataset.dirty = '1';
    }
    const s = Math.round(elapsedMin * 60);
    $('j-actual-min').value = String(Math.floor(s / 60));
    $('j-actual-sec').value = String(s % 60);
  }
  renderTimer();
}

function tick() {
  if (timer.status !== 'running' || !timer.seg) return;
  const { frac, elSeg } = timerProgress();
  for (const ms of timer.milestones) {
    if (!ms.fired && frac >= ms.fraction) {
      ms.fired = true;
      beep(2, 784, 0.15, 0.1);
      vibrate(250);
      setText('timer-status', `${ms.label} maintenant !`);
    }
  }
  const remaining = timer.seg.reachable ? timer.seg.minutes - elSeg : NaN;
  if ((timer.seg.reachable && remaining <= 0) || frac >= 0.9999) {
    finishTimer();
    return;
  }
  renderTimer();
}

function renderTimer() {
  const disp = $('timer-display');
  const bar = $('timer-bar');
  const prog = $('timer-progress');
  const { frac, elSeg } = timerProgress();
  disp.classList.toggle('is-paused', timer.status === 'paused');
  disp.classList.toggle('is-done', timer.status === 'done');
  $('minuteur').classList.toggle('is-running', timer.status === 'running');
  $('minuteur').classList.toggle('is-idle', timer.status === 'idle');
  setText('timer-label', timer.status === 'idle' ? 'Temps calculé' : timer.label);

  if (timer.status === 'done') {
    setText(disp, '00:00');
  } else if (timer.status !== 'idle' && timer.seg) {
    const remaining = timer.status === 'paused' ? timer.pausedRemaining : timer.seg.reachable ? Math.max(0, timer.seg.minutes - elSeg) : NaN;
    setText(disp, isNum(remaining) ? fmtMMSS(remaining) : '—:—');
    const elapsed = (timer.runMsBefore + (timer.status === 'running' ? Date.now() - timer.seg.start : 0)) / 60000;
    const end = isNum(remaining) && timer.status === 'running' ? new Date(Date.now() + remaining * 60000) : null;
    setText('timer-meta', `Dose reçue : ${fmtNum(frac * 100, 0)} % · écoulé ${fmtMMSS(elapsed)}${end ? ` · fin vers ${fmtClock(end)}` : ''}`);
    if (timer.status === 'running') document.title = `${isNum(remaining) ? fmtMMSS(remaining) : '…'} · ${baseTitle}`;
    // Prochaine étape (bande test)
    const next = timer.milestones.find((x) => !x.fired);
    const stepEl = $('timer-step');
    if (next && timer.status === 'running') {
      const f = (next.fraction - timer.base) / (1 - timer.base);
      const tAt = segTimeFor(f);
      stepEl.hidden = false;
      setText(stepEl, `Prochaine étape : ${next.label.toLowerCase()}${isNum(tAt) ? ` dans ${fmtMMSS(Math.max(0, tAt - elSeg))}` : ''}`);
    } else {
      stepEl.hidden = true;
    }
  }
  const pct = Math.round(clamp(frac, 0, 1) * 1000) / 10;
  bar.style.width = `${timer.status === 'idle' ? 0 : pct}%`;
  prog.setAttribute('aria-valuenow', String(Math.round(timer.status === 'idle' ? 0 : pct)));

  const active = timer.status === 'running' || timer.status === 'paused';
  const start = $('btn-start-timer');
  const pause = $('timer-pause');
  const cancel = $('timer-cancel');
  start.hidden = active;
  start.disabled = active;
  setText('btn-start-label', timer.status === 'done' ? 'Recommencer' : 'Démarrer le minuteur');
  pause.hidden = !active;
  pause.disabled = !active;
  setText(pause, timer.status === 'paused' ? 'Reprendre' : 'Pause');
  cancel.hidden = timer.status === 'idle';
  cancel.disabled = timer.status === 'idle';
  setText(cancel, timer.status === 'done' ? 'Réinitialiser' : 'Annuler');
  $('btn-strip-timer').disabled = active || !(state.result && state.result.reachable);
  updateDock();
}

function renderTimerIdle() {
  if (timer.status !== 'idle') return;
  const r = state.result;
  setText('timer-display', r && r.reachable ? fmtMMSS(r.minutes) : '--:--');
  setText('timer-meta', 'Dose reçue : 0 %');
  renderTimer();
}

function startStripTimer() {
  const plan = stripPlan();
  const uncover = state.stripMethod === 'uncover';
  const milestones = [];
  if (uncover) {
    [...plan.bands].sort((a, b) => b.mult - a.mult).slice(1).forEach((b) => {
      milestones.push({ fraction: (plan.M - b.mult) / plan.M, label: `Découvrez la bande ${b.num}` });
    });
  } else {
    [...plan.bands].sort((a, b) => a.mult - b.mult).slice(0, -1).forEach((b) => {
      milestones.push({ fraction: b.mult / plan.M, label: `Couvrez la bande ${b.num}` });
    });
  }
  startTimer({ kind: 'strip', multiplier: plan.M, milestones, label: `Bande test (${plan.n} bandes)` });
}

// ---------------------------------------------------------------------------------------------
// Barre fixe mobile
// ---------------------------------------------------------------------------------------------

const visible = { resultat: true, minuteur: false };
function updateDock() {
  const dock = $('dock');
  const running = timer.status === 'running' || timer.status === 'paused';
  const show = running ? !visible.minuteur : !visible.resultat && !visible.minuteur;
  dock.hidden = !show;
  if (!show) return;
  const r = state.result;
  if (running) {
    setText('dock-label', timer.status === 'paused' ? 'En pause' : 'Restant');
    setText('dock-time', $('timer-display').textContent);
    $('dock-link').setAttribute('href', '#minuteur');
    setText('dock-action', timer.status === 'paused' ? 'Reprendre' : 'Pause');
  } else {
    setText('dock-label', 'Pose');
    setText('dock-time', r && r.reachable ? fmtMMSS(r.minutes) : '--:--');
    $('dock-link').setAttribute('href', '#resultat');
    setText('dock-action', timer.status === 'done' ? 'Terminé' : 'Démarrer');
  }
}

// ---------------------------------------------------------------------------------------------
// Calibrations et journal
// ---------------------------------------------------------------------------------------------

function refreshCalibrations() {
  calibrations = store.listCalibrations();
  if (state.calibrationId && !calibrations.some((c) => c.id === state.calibrationId)) state.calibrationId = '';
  const sel = $('p-calibration');
  sel.replaceChildren(new Option('Aucune (×1)', ''), ...calibrations.map((c) => new Option(`${c.name} (${fmtFactor(c.factor)})`, c.id)));
  sel.value = state.calibrationId;
  const cur = currentCalibration();
  setText('p-calibration-desc', cur
    ? `Facteur personnel ${fmtFactor(cur.factor)}${cur.notes ? ` — ${cur.notes}` : ''}`
    : calibrations.length ? 'Choisissez une calibration enregistrée.' : 'Créez-en une depuis le journal, après une bande test.');

  const list = $('cal-list');
  if (!calibrations.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'Aucune calibration pour l’instant.'));
    return;
  }
  list.replaceChildren(...calibrations.map((c) => {
    const del = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Supprimer la calibration ${c.name}` }, 'Supprimer');
    del.addEventListener('click', () => {
      if (!confirm(`Supprimer la calibration « ${c.name} » ?`)) return;
      store.deleteCalibration(c.id);
      refreshCalibrations();
      changed();
    });
    const created = new Date(c.createdAt);
    return el('li', {},
      el('div', { class: 'item-main' },
        el('p', { class: 'item-title' }, c.name, c.id === state.calibrationId ? el('span', { class: 'badge badge-good' }, 'active') : null),
        el('p', { class: 'item-meta' }, `${fmtFactor(c.factor)} · créée le ${isNum(created.getTime()) ? created.toLocaleDateString('fr-FR') : '?'}`),
        c.notes ? el('p', { class: 'item-notes' }, c.notes) : null),
      del);
  }));
}

function placeText(place) {
  if (!place) return '';
  if (typeof place === 'string') return place;
  return typeof place.label === 'string' ? place.label : '';
}

function refreshJournal() {
  const entries = store.listJournal();
  const list = $('journal-list');
  if (!entries.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'Le journal est vide. Ajoutez votre premier tirage.'));
    return;
  }
  const shown = entries.slice(0, 50);
  list.replaceChildren(...shown.map((e) => {
    const d = new Date(e.date);
    const del = el('button', { type: 'button', class: 'icon-btn', 'aria-label': `Supprimer l'entrée du ${d.toLocaleString('fr-FR')}` }, 'Supprimer');
    del.addEventListener('click', () => {
      if (!confirm('Supprimer cette entrée du journal ?')) return;
      store.deleteJournalEntry(e.id);
      refreshJournal();
    });
    const s = e.settings || {};
    const chem = getById(CHEMISTRY, s.chemistry);
    const sub = getById(SUBSTRATE, s.substrate);
    const meta = [
      `Prévu ${isNum(e.predictedMinutes) ? fmtMMSS(e.predictedMinutes) : '—'}`,
      `réel ${isNum(e.actualMinutes) ? fmtMMSS(e.actualMinutes) : '—'}`,
      chem ? chem.label : null,
      sub ? sub.label : null,
    ].filter(Boolean).join(' · ');
    const title = `${isNum(d.getTime()) ? d.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date inconnue'}${placeText(e.place) ? ` — ${placeText(e.place)}` : ''}`;
    return el('li', {},
      el('div', { class: 'item-main' },
        el('p', { class: 'item-title' }, title, e.result ? el('span', { class: `badge badge-${e.result}` }, RESULT_LABEL[e.result]) : null),
        el('p', { class: 'item-meta' }, meta),
        e.notes ? el('p', { class: 'item-notes' }, e.notes) : null),
      del);
  }));
  if (entries.length > shown.length) list.append(el('li', { class: 'empty' }, `… et ${entries.length - shown.length} entrées plus anciennes (dans l’export JSON).`));
}

function prefillJournal() {
  const pred = $('j-predicted');
  const r = state.result;
  if (pred.dataset.dirty === '1' || !r || !r.reachable) return;
  pred.value = String(Math.round(r.minutes * 100) / 100);
}

function readJournalForm() {
  const predicted = Number($('j-predicted').value);
  const mi = Number($('j-actual-min').value || 0);
  const se = Number($('j-actual-sec').value || 0);
  const actual = mi + se / 60;
  const result = document.querySelector('input[name="j-result"]:checked')?.value || 'good';
  return {
    predicted: isNum(predicted) && predicted > 0 ? predicted : null,
    actual: isNum(actual) && actual > 0 ? actual : null,
    result,
    notes: $('j-notes').value.trim(),
  };
}

function journalStatus(msg, kind = '') {
  const s = $('journal-status');
  s.textContent = msg;
  s.className = `status-text${kind ? ` is-${kind}` : ''}`;
}

function bindJournal() {
  $('j-predicted').addEventListener('input', (e) => {
    e.target.dataset.dirty = '1';
  });
  $('journal-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = readJournalForm();
    $('j-actual-min').removeAttribute('aria-invalid');
    if (!f.actual) {
      $('j-actual-min').setAttribute('aria-invalid', 'true');
      journalStatus('Indiquez le temps réellement utilisé (minutes et/ou secondes).', 'error');
      $('j-actual-min').focus();
      return;
    }
    const r = state.result;
    store.addJournalEntry({
      date: new Date().toISOString(),
      place: { label: state.place.label, lat: state.place.lat, lon: state.place.lon },
      settings: {
        ...engineSettings(),
        lightSource: state.lightSource,
        powerW: isLamp() ? Number(state.powerW) || null : null,
        distanceCm: isLamp() ? Number(state.distanceCm) || null : null,
        cloudCoverPct: r?.weather?.cloudCoverPct ?? null,
        elevationDeg: isNum(r?.elevation) ? Math.round(r.elevation * 10) / 10 : null,
      },
      predictedMinutes: f.predicted,
      actualMinutes: Math.round(f.actual * 1000) / 1000,
      result: f.result,
      notes: f.notes,
    });
    refreshJournal();
    journalStatus('Tirage ajouté au journal.', 'ok');
  });
  $('btn-create-cal').addEventListener('click', () => {
    const f = readJournalForm();
    if (!f.actual || !f.predicted) {
      journalStatus('Pour calibrer, il faut le temps prévu et le temps réellement utilisé.', 'error');
      return;
    }
    if (f.result !== 'good') {
      journalStatus('Une calibration se crée à partir d’un tirage réussi : choisissez « Bon » (faites d’abord une bande test si besoin).', 'error');
      return;
    }
    // Le temps prévu inclut la calibration actuelle : on la retire pour obtenir un facteur absolu.
    const curFactor = currentCalibration()?.factor || 1;
    const factor = store.computeCalibrationFactor(f.actual, f.predicted / curFactor);
    const chem = getById(CHEMISTRY, state.chemistry);
    const name = $('j-cal-name').value.trim() || `${chem ? chem.label : 'Calibration'} — ${new Date().toLocaleDateString('fr-FR')}`;
    try {
      const cal = store.saveCalibration({ name, factor, notes: f.notes });
      state.calibrationId = cal.id;
      refreshCalibrations();
      changed();
      journalStatus(`Calibration « ${cal.name} » créée (${fmtFactor(cal.factor)}) et sélectionnée dans le procédé.`, 'ok');
      $('j-cal-name').value = '';
    } catch (err) {
      journalStatus(err.message || 'Impossible de créer la calibration.', 'error');
    }
  });

  $('btn-export').addEventListener('click', () => {
    saveNow();
    const blob = new Blob([store.exportAll()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: `cyanotype-sauvegarde-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    const s = $('io-status');
    s.className = 'status-text is-ok';
    s.textContent = 'Sauvegarde exportée.';
  });
  $('in-import').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    const s = $('io-status');
    if (!file) return;
    try {
      const text = await file.text();
      const res = store.importAll(text);
      const placeBefore = `${state.place.lat},${state.place.lon}`;
      if (res.settings) {
        applySaved(store.loadSettings());
        applyStateToForm();
      }
      refreshCalibrations();
      refreshJournal();
      s.className = 'status-text is-ok';
      s.textContent = `Import réussi : ${res.calibrations} calibration(s), ${res.journal} entrée(s) de journal${res.settings ? ', réglages restaurés' : ''}${res.skipped ? ` (${res.skipped} élément(s) ignoré(s))` : ''}.`;
      if (`${state.place.lat},${state.place.lon}` !== placeBefore) {
        state.forecast = null;
        renderPlace();
        loadWeather();
      }
      compute();
    } catch (err) {
      s.className = 'status-text is-error';
      s.textContent = err.message || 'Import impossible.';
    } finally {
      e.target.value = '';
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Lieu : géolocalisation, recherche, coordonnées
// ---------------------------------------------------------------------------------------------

let weatherReq = 0;
async function loadWeather({ quiet = false } = {}) {
  const id = ++weatherReq;
  const { lat, lon } = state.place;
  state.weatherLoading = !quiet;
  if (!quiet) renderWeather();
  try {
    const f = await fetchForecast(lat, lon);
    if (id !== weatherReq) return;
    state.forecast = f;
    state.forecastAt = Date.now();
    state.weatherError = null;
  } catch (err) {
    if (id !== weatherReq) return;
    if (!state.forecast) state.forecast = null;
    state.weatherError = err && err.message ? err.message : 'Prévisions indisponibles.';
  }
  state.weatherLoading = false;
  renderPlace();
  compute();
}

function setPlace(place, { fetch = true } = {}) {
  state.place = {
    label: place.label || 'Lieu',
    lat: clamp(Number(place.lat), -90, 90),
    lon: clamp(Number(place.lon), -180, 180),
    altitudeM: isNum(place.altitudeM) ? place.altitudeM : null,
    origin: place.origin || 'manual',
  };
  state.forecast = null;
  state.forecastAt = 0;
  state.weatherError = null;
  profileCache.key = '';
  renderPlace();
  save();
  compute();
  if (fetch) loadWeather();
}

async function useBrowserPosition({ auto = false } = {}) {
  const st = $('geo-status');
  st.className = 'status-text';
  st.textContent = 'Localisation en cours…';
  $('btn-geo').disabled = true;
  try {
    const pos = await getBrowserPosition({ timeoutMs: 10000 });
    setPlace({
      label: 'Ma position',
      lat: pos.lat,
      lon: pos.lon,
      altitudeM: isNum(pos.altitudeM) ? Math.round(pos.altitudeM) : null,
      origin: 'gps',
    });
    st.className = 'status-text is-ok';
    st.textContent = `Position trouvée${isNum(pos.accuracyM) ? ` (± ${fmtNum(pos.accuracyM, 0)} m)` : ''}.`;
  } catch (err) {
    st.className = auto ? 'status-text' : 'status-text is-error';
    st.textContent = auto ? `${err.message || 'Position indisponible.'} Lieu par défaut : Paris.` : err.message || 'Position indisponible.';
  } finally {
    $('btn-geo').disabled = false;
  }
}

function bindPlaceSearch() {
  const input = $('place-search');
  const list = $('place-results');
  let results = [];
  let active = -1;
  let req = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const highlight = (i) => {
    active = i;
    [...list.children].forEach((li, k) => li.setAttribute('aria-selected', String(k === i)));
    if (i >= 0 && list.children[i]) {
      input.setAttribute('aria-activedescendant', list.children[i].id);
      list.children[i].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const choose = (i) => {
    const p = results[i];
    if (!p) return;
    close();
    input.value = '';
    setPlace({ label: p.label || p.name, lat: p.lat, lon: p.lon, altitudeM: isNum(p.elevation) ? p.elevation : null, origin: 'search' });
    const st = $('geo-status');
    st.className = 'status-text is-ok';
    st.textContent = `Lieu choisi : ${p.label || p.name}.`;
  };
  const showMessage = (msg) => {
    results = [];
    list.replaceChildren(el('li', { role: 'option', 'aria-disabled': 'true', id: 'place-opt-msg' }, msg));
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };

  const run = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) return close();
    const id = ++req;
    try {
      const res = await searchPlace(q);
      if (id !== req) return;
      results = res;
      if (!res.length) return showMessage('Aucun lieu trouvé.');
      list.replaceChildren(...res.map((p, i) => {
        const li = el('li', { role: 'option', id: `place-opt-${i}`, 'aria-selected': 'false' },
          p.name,
          el('small', {}, [p.admin1, p.country].filter(Boolean).join(', ') + (isNum(p.elevation) ? ` · ${fmtNum(p.elevation, 0)} m` : '')));
        li.addEventListener('mousedown', (ev) => ev.preventDefault());
        li.addEventListener('click', () => choose(i));
        return li;
      }));
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      highlight(-1);
    } catch (err) {
      if (id !== req) return;
      showMessage(err.message || 'Recherche impossible (hors ligne ?). Saisissez les coordonnées.');
    }
  }, 300);

  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (results.length) highlight((active + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) highlight(active <= 0 ? results.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active >= 0 ? active : 0);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(close, 150));

  $('coords-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const lat = Number($('in-lat').value);
    const lon = Number($('in-lon').value);
    const altRaw = $('in-alt').value.trim();
    const alt = altRaw === '' ? null : Number(altRaw);
    const st = $('coords-status');
    const okLat = $('in-lat').value !== '' && isNum(lat) && Math.abs(lat) <= 90;
    const okLon = $('in-lon').value !== '' && isNum(lon) && Math.abs(lon) <= 180;
    $('in-lat').setAttribute('aria-invalid', String(!okLat));
    $('in-lon').setAttribute('aria-invalid', String(!okLon));
    if (!okLat || !okLon || (alt !== null && !isNum(alt))) {
      st.className = 'status-text is-error';
      st.textContent = 'Latitude entre −90 et 90, longitude entre −180 et 180.';
      return;
    }
    setPlace({ label: `Coordonnées ${fmtNum(lat, 3)}, ${fmtNum(lon, 3)}`, lat, lon, altitudeM: alt, origin: 'manual' });
    st.className = 'status-text is-ok';
    st.textContent = 'Coordonnées appliquées.';
  });

  $('btn-geo').addEventListener('click', () => useBrowserPosition());
}

// ---------------------------------------------------------------------------------------------
// Formulaire : remplissage et liaisons
// ---------------------------------------------------------------------------------------------

function fillSelect(sel, list) {
  sel.replaceChildren(...list.map((it) => new Option(it.label, it.id)));
}

function processHint(key, list) {
  const it = getById(list, state[key]);
  return it ? `${fmtFactor(it.factor)} — ${it.description || ''}` : '';
}

function syncStartControls() {
  document.querySelectorAll('input[name="start-mode"]').forEach((r) => {
    r.checked = r.value === state.startMode;
  });
  const input = $('start-at');
  if (state.startMode === 'now') input.value = fmtInput(new Date());
  else if (state.startLocal) input.value = state.startLocal;
}

function syncLampFields() {
  const src = lightSource();
  const lamp = src.kind === 'lamp';
  $('lamp-fields').hidden = !lamp;
  setText('source-summary', lamp ? src.label : 'Soleil (lampe UV en option)');
  if (lamp) $('source-details').open = true;
  setText('light-source-desc', src.description || '');
  if (lamp) {
    if (!isNum(Number(state.powerW)) || !(Number(state.powerW) > 0)) state.powerW = src.refPowerW;
    if (!isNum(Number(state.distanceCm)) || !(Number(state.distanceCm) > 0)) state.distanceCm = src.refDistanceCm;
    $('lamp-power').value = String(state.powerW);
    $('lamp-distance').value = String(state.distanceCm);
  }
}

function applyStateToForm() {
  for (const { sel, key, list } of PROCESS) {
    $(sel).value = state[key];
    setText(`${sel}-desc`, processHint(key, list));
  }
  $('light-source').value = state.lightSource;
  syncLampFields();
  $('ground').value = state.ground;
  $('weather-manual').checked = state.weatherManual;
  $('manual-cloud').value = String(state.manualCloud);
  $('manual-uv').value = state.manualUV === '' || state.manualUV === null ? '' : String(state.manualUV);
  $('strip-count').value = String(state.stripCount);
  $('strip-step').value = String(state.stripStep);
  $('strip-method').value = state.stripMethod;
  syncStartControls();
  renderPlace();
}

function bindForm() {
  for (const { sel, key, list } of PROCESS) {
    $(sel).addEventListener('change', (e) => {
      state[key] = e.target.value;
      setText(`${sel}-desc`, processHint(key, list));
      changed();
    });
  }
  $('p-calibration').addEventListener('change', (e) => {
    state.calibrationId = e.target.value;
    refreshCalibrations();
    changed();
  });
  $('light-source').addEventListener('change', (e) => {
    const prev = state.lightSource;
    state.lightSource = e.target.value;
    if (prev !== state.lightSource) {
      state.powerW = null;
      state.distanceCm = null;
    }
    syncLampFields();
    changed();
  });
  $('lamp-power').addEventListener('input', (e) => {
    state.powerW = Number(e.target.value) || null;
    changed();
  });
  $('lamp-distance').addEventListener('input', (e) => {
    state.distanceCm = Number(e.target.value) || null;
    changed();
  });
  $('ground').addEventListener('change', (e) => {
    state.ground = e.target.value;
    changed();
  });
  $('weather-manual').addEventListener('change', (e) => {
    state.weatherManual = e.target.checked;
    renderWeather();
    changed();
  });
  $('manual-cloud').addEventListener('input', (e) => {
    state.manualCloud = Number(e.target.value) || 0;
    setText('manual-cloud-out', `${fmtNum(state.manualCloud, 0)} %`);
    changed();
  });
  $('manual-uv').addEventListener('input', (e) => {
    const v = e.target.value.trim();
    state.manualUV = v === '' || !isNum(Number(v)) ? '' : clamp(Number(v), 0, 20);
    changed();
  });
  document.querySelectorAll('input[name="start-mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      state.startMode = r.value;
      if (state.startMode === 'custom' && !state.startLocal) state.startLocal = fmtInput(new Date());
      syncStartControls();
      changed();
    });
  });
  $('start-at').addEventListener('input', (e) => {
    if (!parseInput(e.target.value)) return;
    state.startMode = 'custom';
    state.startLocal = e.target.value;
    document.querySelectorAll('input[name="start-mode"]').forEach((r) => {
      r.checked = r.value === 'custom';
    });
    changed();
  });
  const stripChange = () => {
    state.stripCount = clamp(Math.round(Number($('strip-count').value) || 5), 2, 12);
    state.stripStep = clamp(Number($('strip-step').value) || 25, 5, 100);
    state.stripMethod = $('strip-method').value;
    save();
    renderStrip();
  };
  ['strip-count', 'strip-step'].forEach((id) => $(id).addEventListener('input', stripChange));
  $('strip-method').addEventListener('change', stripChange);

  // Minuteur
  $('btn-start-timer').addEventListener('click', () => startTimer());
  $('timer-pause').addEventListener('click', () => (timer.status === 'paused' ? resumeTimer() : pauseTimer()));
  $('timer-cancel').addEventListener('click', () => cancelTimer());
  $('btn-strip-timer').addEventListener('click', () => startStripTimer());
  $('dock-action').addEventListener('click', () => {
    if (timer.status === 'running') pauseTimer();
    else if (timer.status === 'paused') resumeTimer();
    else if (timer.status === 'done') $('minuteur').scrollIntoView({ behavior: 'smooth' });
    else startTimer();
  });

  $('btn-retry-weather').addEventListener('click', () => loadWeather());
  window.addEventListener('online', () => {
    if (state.weatherError) loadWeather();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (timer.status === 'running') {
      acquireWakeLock();
      tick();
    }
    if (state.forecast && Date.now() - state.forecastAt > 30 * 60000) loadWeather({ quiet: true });
    if (state.startMode === 'now') compute({ silent: true });
  });

  // Barre fixe mobile : visible quand le résultat et le minuteur sont hors écran.
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) visible[e.target.id] = e.isIntersecting;
      updateDock();
    }, { threshold: 0.15 });
    io.observe($('resultat'));
    io.observe($('minuteur'));
  }
}

// ---------------------------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------------------------

const baseTitle = document.title;

function init() {
  for (const { sel, list } of PROCESS) fillSelect($(sel), list);
  fillSelect($('light-source'), LIGHT_SOURCE);
  fillSelect($('ground'), GROUND);

  const saved = store.loadSettings();
  const firstLaunch = !saved || !saved.place;
  applySaved(saved);
  calibrations = store.listCalibrations();
  applyStateToForm();
  refreshCalibrations();
  refreshJournal();
  bindForm();
  bindPlaceSearch();
  bindChart();
  bindJournal();
  try {
    $('advice-box').open = window.matchMedia('(min-width: 1000px)').matches;
  } catch {
    /* ignore */
  }
  compute();

  if (firstLaunch) {
    // Calcul immédiat sur Paris, puis bascule si l'utilisateur partage sa position.
    loadWeather();
    useBrowserPosition({ auto: true });
  } else {
    loadWeather();
  }

  // Mode « maintenant » : on suit l'heure (et le soleil) en continu.
  setInterval(() => {
    if (state.startMode === 'now') {
      $('start-at').value = fmtInput(new Date());
      compute({ silent: true });
    } else {
      renderChart();
    }
    if (state.forecast && Date.now() - state.forecastAt > 30 * 60000 && navigator.onLine !== false) loadWeather({ quiet: true });
  }, 30000);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
