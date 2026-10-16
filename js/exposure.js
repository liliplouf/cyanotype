// Modèle d'exposition du cyanotype.
//
// Le cyanotype est sensibilisé par la photoréduction du fer(III) : la sensibilité utile se situe
// dans les UV-A (≈ 320–400 nm, pic vers 350–380 nm). L'indice UV « érythémal » est dominé par les
// UV-B et varie beaucoup plus vite avec la hauteur du soleil (ozone) : on ne l'utilise donc JAMAIS
// en valeur absolue, seulement le rapport UV/UV ciel clair comme estimation de la transmission
// nuageuse (cet effet des nuages ne dépend que faiblement de la longueur d'onde dans l'UV).
//
// Unités : « UV-A relatif » = 1 pour un soleil au zénith, ciel clair, niveau de la mer, plan horizontal.
// La dose est en « UV-A relatif × minute » ; la dose cible vaut REFERENCE_MINUTES × settingsFactor.
// Module ES pur, sans dépendance ni accès au DOM.

import { solarPosition, sunTimes } from './solar.js';
import {
  CHEMISTRY,
  SUBSTRATE,
  COATING,
  HUMIDITY_STATE,
  GLASS,
  NEGATIVE,
  RESULT_GOAL,
  LIGHT_SOURCE,
  getById,
} from './factors.js';

const RAD = Math.PI / 180;
const MS_PER_MIN = 60000;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---------------------------------------------------------------------------------------------
// Ciel clair
// ---------------------------------------------------------------------------------------------

// Épaisseur optique effective verticale dans l'UV-A (~365 nm) : Rayleigh ≈ 0,5 (∝ λ^-4,08 ;
// Bodhaine et al. 1999) + aérosols d'un ciel « moyennement clair » ≈ 0,2.
const UVA_TAU = 0.7;
// Fraction de la lumière diffusée qui atteint le sol (diffusion Rayleigh symétrique ~0,5,
// aérosols surtout vers l'avant) : le diffus représente ainsi ~30–40 % du global UV-A au zénith,
// conforme aux mesures (le ciel bleu est une grosse source d'UV-A, ce qui explique qu'on puisse
// insoler à l'ombre).
const UVA_DIFFUSE_DOWN = 0.6;
// Gain d'altitude : les mesures alpines donnent ~ +8–11 %/km pour les UV-A (Blumthaler et al. 1997,
// J. Photochem. Photobiol. B 39:130), en partie dû à la neige environnante et aux aérosols plus
// faibles. On retient un gain modéré et prudent de +6 %/km (linéaire, plafonné à 6 km).
const ALTITUDE_GAIN_PER_KM = 0.06;

/** Masse d'air relative, formule de Kasten & Young (1989, Applied Optics 28:4735). z en degrés. */
function airMass(zenithDeg) {
  return 1 / (Math.cos(zenithDeg * RAD) + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}

function rawClearSky(elevationDeg) {
  const z = 90 - elevationDeg;
  const t = Math.exp(-UVA_TAU * airMass(z)); // transmission du faisceau direct (Beer-Lambert)
  // Global horizontal = direct (sin h · T) + diffus (fraction descendante de ce qui a été diffusé).
  return Math.sin(elevationDeg * RAD) * (t + UVA_DIFFUSE_DOWN * (1 - t));
}
const RAW_ZENITH = rawClearSky(90);

/**
 * Irradiance UV-A relative en ciel clair sur plan horizontal (1,0 = soleil au zénith, niveau mer).
 * @param {number} elevationDeg élévation apparente du soleil (°)
 * @param {number} [altitudeM=0] altitude du lieu (m)
 * @returns {number} 0 si le soleil est sous l'horizon. ≈ 0,89 à 64,5°, ≈ 0,44 à 30°, ≈ 0,13 à 10°.
 */
export function clearSkyUVA(elevationDeg, altitudeM = 0) {
  if (!isNum(elevationDeg) || elevationDeg <= 0) return 0;
  const h = Math.min(90, elevationDeg);
  const km = clamp(isNum(altitudeM) ? altitudeM / 1000 : 0, 0, 6);
  return (rawClearSky(h) / RAW_ZENITH) * (1 + ALTITUDE_GAIN_PER_KM * km);
}

// ---------------------------------------------------------------------------------------------
// Nuages, albédo
// ---------------------------------------------------------------------------------------------

/**
 * Transmission nuageuse des UV (0..1) en fonction de la couverture nuageuse totale (%).
 * Forme de Kasten & Czeplak (1980) 1 − a·N^b, avec des coefficients ajustés à l'UV
 * (a ≈ 0,5–0,6 ; b ≈ 2,5–3,5 selon les études, cf. la revue de Calbó, Pagès & González 2005,
 * Rev. Geophys. 43, RG2002 ; Josefsson & Landelius 2000). Retenu : a = 0,56, b = 2,5.
 * L'exposant élevé traduit le fait qu'un ciel partiellement voilé (cirrus, cumulus épars) atténue
 * peu les UV ; un ciel entièrement couvert en laisse passer ~45 % (davantage sous voile mince,
 * beaucoup moins sous nimbostratus épais : le rapport UV/UV ciel clair d'Open-Meteo est préféré).
 */
export function cloudTransmission(cloudCoverPct) {
  if (!isNum(cloudCoverPct)) return 1;
  const n = clamp(cloudCoverPct, 0, 100) / 100;
  return 1 - 0.56 * n ** 2.5;
}

// Rapport UV / UV ciel clair : plancher (ciel très sombre) et plafond (renforcement au bord des
// cumulus, jusqu'à +15–25 % ponctuellement ; on reste prudent).
const SKY_RATIO_MIN = 0.03;
const SKY_RATIO_MAX = 1.15;
// En dessous de cette valeur d'UV ciel clair (soleil bas), l'indice UV arrondi est trop bruité.
const UV_CLEAR_MIN_RELIABLE = 0.5;

/** Facteur « ciel » (0..~1,15) à partir des données météo disponibles. */
function skyFactor(cloudCoverPct, uvIndex, uvIndexClearSky) {
  const hasRatio = isNum(uvIndex) && isNum(uvIndexClearSky) && uvIndexClearSky > 0;
  if (hasRatio && uvIndexClearSky >= UV_CLEAR_MIN_RELIABLE) {
    return clamp(uvIndex / uvIndexClearSky, SKY_RATIO_MIN, SKY_RATIO_MAX);
  }
  if (isNum(cloudCoverPct)) return cloudTransmission(cloudCoverPct);
  if (hasRatio && uvIndexClearSky > 0.05) {
    return clamp(uvIndex / uvIndexClearSky, SKY_RATIO_MIN, SKY_RATIO_MAX);
  }
  return 1; // aucune information : ciel clair supposé
}

// Albédo du sol : la lumière réfléchie par le sol est en partie renvoyée vers le bas par
// l'atmosphère (albédo sphérique du ciel ρ ≈ 0,2 dans l'UV-A) → gain 1 / (1 − ρ·A).
// Neige fraîche (A ≈ 0,8) : ≈ +19 %. Par défaut A = 0 (sol ordinaire, déjà inclus dans la référence).
const SKY_BACKSCATTER = 0.2;
function albedoFactor(albedo) {
  if (!isNum(albedo)) return 1;
  return 1 / (1 - SKY_BACKSCATTER * clamp(albedo, 0, 1));
}

/**
 * Irradiance UV-A relative effective (ciel clair × ciel réel × albédo).
 * Si `uvIndex` et `uvIndexClearSky` (Open-Meteo) sont fournis, seul leur RAPPORT est utilisé comme
 * transmission nuageuse ; sinon `cloudCoverPct` via cloudTransmission ; sinon ciel clair.
 */
export function effectiveUVA({
  elevationDeg,
  altitudeM = 0,
  cloudCoverPct,
  uvIndex,
  uvIndexClearSky,
  albedo = 0,
} = {}) {
  const clear = clearSkyUVA(elevationDeg, altitudeM);
  if (clear === 0) return 0;
  return clear * skyFactor(cloudCoverPct, uvIndex, uvIndexClearSky) * albedoFactor(albedo);
}

// ---------------------------------------------------------------------------------------------
// Réglages et temps de pose
// ---------------------------------------------------------------------------------------------

/**
 * Temps de pose (min) au soleil pour uva relatif = 1, réglages de référence (classique, coton,
 * une couche, sec, sans verre, photogramme, standard). Ordre de grandeur de la pratique : 10 à
 * 15 min en plein soleil d'été sous nos latitudes (uva ≈ 0,7–0,9), 20–30 min au printemps.
 */
export const REFERENCE_MINUTES = 8;

const SETTING_CATALOGS = [
  ['chemistry', CHEMISTRY],
  ['substrate', SUBSTRATE],
  ['coating', COATING],
  ['humidityState', HUMIDITY_STATE],
  ['glass', GLASS],
  ['negative', NEGATIVE],
  ['resultGoal', RESULT_GOAL],
];

/**
 * Produit des facteurs des catalogues × calibration personnelle. Identifiants inconnus ou absents → 1.
 * @param {{chemistry?, substrate?, coating?, humidityState?, glass?, negative?, resultGoal?, calibrationFactor?}} settings
 */
export function settingsFactor(settings) {
  const s = settings || {};
  let f = 1;
  for (const [key, list] of SETTING_CATALOGS) {
    const item = getById(list, s[key]);
    if (item && isNum(item.factor) && item.factor > 0) f *= item.factor;
  }
  const cal = s.calibrationFactor;
  if (isNum(cal) && cal > 0) f *= cal;
  return f;
}

const UVA_EPSILON = 1e-4;

/** Temps de pose (min) sous irradiance constante. Infinity si uva ≈ 0. */
export function exposureMinutesConstant(uvaRel, settings) {
  if (!isNum(uvaRel) || uvaRel < UVA_EPSILON) return Infinity;
  return (REFERENCE_MINUTES * settingsFactor(settings)) / uvaRel;
}

// ---------------------------------------------------------------------------------------------
// Intégration de la dose
// ---------------------------------------------------------------------------------------------

// La météo horaire (interpolée par l'appelant) varie lentement : on n'interroge `weatherAt` que
// toutes les 5 min et on interpole linéairement le facteur ciel entre deux nœuds. La position
// solaire, elle, est calculée à chaque minute (coût négligeable : ~1 µs).
const WEATHER_STEP_MIN = 5;

/**
 * Grille minute par minute de l'irradiance à partir de t0Ms (n + 1 échantillons) et dose cumulée
 * (méthode des trapèzes, pas de 1 min).
 */
function buildGrid({ t0Ms, n, lat, lon, altitudeM, weatherAt, albedo }) {
  const elev = new Float64Array(n + 1);
  const uva = new Float64Array(n + 1);
  const cum = new Float64Array(n + 1);
  const alb = albedoFactor(albedo);

  let prevNodeK = -1;
  let prevNodeSky = 1;
  let nextNodeK = -1;
  let nextNodeSky = 1;
  const skyAtNode = (k) => {
    if (typeof weatherAt !== 'function') return 1;
    let w = null;
    try {
      w = weatherAt(new Date(t0Ms + k * MS_PER_MIN));
    } catch {
      w = null;
    }
    if (!w) return 1;
    return skyFactor(w.cloudCoverPct, w.uvIndex, w.uvIndexClearSky);
  };

  for (let k = 0; k <= n; k++) {
    const e = solarPosition(new Date(t0Ms + k * MS_PER_MIN), lat, lon).elevation;
    elev[k] = e;
    const clear = clearSkyUVA(e, altitudeM);
    let u = 0;
    if (clear > 0) {
      if (k > nextNodeK) {
        // avance d'un intervalle météo (les nœuds sont aux multiples de WEATHER_STEP_MIN et en n)
        const a = Math.floor(k / WEATHER_STEP_MIN) * WEATHER_STEP_MIN;
        const b = Math.min(n, a + WEATHER_STEP_MIN);
        if (a === nextNodeK) {
          prevNodeK = a;
          prevNodeSky = nextNodeSky;
        } else {
          prevNodeK = a;
          prevNodeSky = skyAtNode(a);
        }
        nextNodeK = b;
        nextNodeSky = b === a ? prevNodeSky : skyAtNode(b);
      }
      const span = nextNodeK - prevNodeK;
      const sky = span > 0 ? prevNodeSky + ((nextNodeSky - prevNodeSky) * (k - prevNodeK)) / span : prevNodeSky;
      u = clear * sky * alb;
    }
    uva[k] = u;
    if (k > 0) cum[k] = cum[k - 1] + 0.5 * (uva[k - 1] + u);
  }
  return { elev, uva, cum };
}

/**
 * Premier instant (en minutes fractionnaires depuis l'index i0) où cum atteint cum[i0] + dose,
 * en ne regardant pas au-delà de kMax. Recherche dichotomique (cum est croissante). null sinon.
 */
function findCrossing(cum, i0, dose, kMax) {
  const target = cum[i0] + dose;
  if (cum[kMax] < target) return null;
  let lo = i0;
  let hi = kMax; // invariant : cum[lo] < target <= cum[hi]
  if (dose <= 0) return 0;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] >= target) hi = mid;
    else lo = mid;
  }
  const d = cum[hi] - cum[lo];
  const frac = d > 0 ? (target - cum[lo]) / d : 1;
  return lo + frac - i0;
}

function toMs(d) {
  return d instanceof Date ? d.getTime() : +d;
}

/**
 * Temps de pose intégré à partir de `start` : accumulation minute par minute de la dose avec le
 * soleil qui se déplace et la météo qui change. L'intégration s'arrête au coucher du soleil
 * (élévation ≤ 0 et décroissante) ou à `maxMinutes`.
 * @returns {{minutes:number, end:Date|null, reachable:boolean,
 *   doseCurve:Array<{t:Date, uva:number, cumulative:number}>,
 *   limitedBy:null|'sunset'|'maxMinutes', fractionReached:number}}
 *   minutes = Infinity et end = null si la dose n'est pas atteignable. `limitedBy` et
 *   `fractionReached` (part de la dose cible atteinte) sont des informations complémentaires.
 */
export function integratedExposure({
  start,
  lat,
  lon,
  altitudeM = 0,
  settings,
  weatherAt,
  albedo = 0,
  maxMinutes = 360,
} = {}) {
  const t0Ms = toMs(start);
  const n = Math.max(1, Math.ceil(isNum(maxMinutes) ? maxMinutes : 360));
  const dose = REFERENCE_MINUTES * settingsFactor(settings);
  const { elev, uva, cum } = buildGrid({ t0Ms, n, lat, lon, altitudeM, weatherAt, albedo });

  // Coucher : premier indice où le soleil est sous l'horizon et descend encore.
  let kStop = n;
  let limitedBy = 'maxMinutes';
  for (let k = 1; k <= n; k++) {
    if (elev[k] <= 0 && elev[k] < elev[k - 1]) {
      kStop = k;
      limitedBy = 'sunset';
      break;
    }
  }

  let minutes = findCrossing(cum, 0, dose, kStop);
  if (minutes !== null && minutes > maxMinutes) minutes = null;
  const reachable = minutes !== null;

  const doseCurve = [];
  const lastK = reachable ? Math.floor(minutes) : kStop;
  for (let k = 0; k <= lastK; k++) {
    doseCurve.push({ t: new Date(t0Ms + k * MS_PER_MIN), uva: uva[k], cumulative: cum[k] / dose });
  }
  let end = null;
  if (reachable) {
    end = new Date(t0Ms + minutes * MS_PER_MIN);
    if (minutes > lastK) {
      const f = minutes - lastK;
      const u = lastK < n ? uva[lastK] + (uva[lastK + 1] - uva[lastK]) * f : uva[lastK];
      doseCurve.push({ t: end, uva: u, cumulative: 1 });
    }
  }

  return {
    minutes: reachable ? minutes : Infinity,
    end,
    reachable,
    doseCurve,
    limitedBy: reachable ? null : limitedBy,
    fractionReached: reachable ? 1 : Math.min(1, cum[kStop] / dose),
  };
}

/**
 * Courbe de la journée : pour chaque heure de départ (pas `stepMinutes`, alignés sur l'heure UTC,
 * donc sur les quarts d'heure locaux pour les fuseaux usuels) entre lever et coucher, temps de pose
 * intégré si l'on commençait à cet instant. Performance : une seule grille minute par minute pour
 * toute la journée (≈ 1000 positions solaires) puis une recherche dichotomique par départ, au lieu
 * de ré-intégrer pour chaque départ. Tableau vide en cas de nuit polaire ; journée entière centrée
 * sur le midi solaire en cas de soleil de minuit.
 * @returns {Array<{t:Date, elevation:number, uva:number, minutes:number}>} minutes = Infinity si inatteignable.
 */
export function dayProfile({
  day,
  lat,
  lon,
  altitudeM = 0,
  settings,
  weatherAt,
  albedo = 0,
  stepMinutes = 15,
  maxMinutes = 360,
} = {}) {
  const st = sunTimes(day instanceof Date ? day : new Date(toMs(day)), lat, lon);
  let fromMs;
  let toMsLimit;
  let polarDay = false;
  if (st.sunrise && st.sunset) {
    fromMs = st.sunrise.getTime();
    toMsLimit = st.sunset.getTime();
  } else if (st.maxElevation > 0) {
    polarDay = true;
    fromMs = st.solarNoon.getTime() - 12 * 60 * MS_PER_MIN;
    toMsLimit = st.solarNoon.getTime() + 12 * 60 * MS_PER_MIN;
  } else {
    return [];
  }

  const step = Math.max(1, Math.round(isNum(stepMinutes) ? stepMinutes : 15));
  const stepMs = step * MS_PER_MIN;
  const firstMs = Math.ceil(fromMs / stepMs) * stepMs;
  if (firstMs > toMsLimit) return [];
  const nStarts = Math.floor((toMsLimit - firstMs) / stepMs) + 1;
  const lastStartOffset = (nStarts - 1) * step;
  const maxM = isNum(maxMinutes) ? maxMinutes : 360;

  // Fin de grille : coucher (+2 min de marge) ou dernier départ + maxMinutes.
  const untilSunset = Math.ceil((toMsLimit - firstMs) / MS_PER_MIN) + 2;
  const untilMax = lastStartOffset + Math.ceil(maxM);
  const n = Math.max(1, polarDay ? untilMax : Math.min(untilSunset, untilMax));

  const { elev, uva, cum } = buildGrid({ t0Ms: firstMs, n, lat, lon, altitudeM, weatherAt, albedo });
  const dose = REFERENCE_MINUTES * settingsFactor(settings);

  // Indice limite pour chaque départ : coucher (premier passage sous l'horizon en descendant).
  let kSet = n;
  if (!polarDay) {
    for (let k = 1; k <= n; k++) {
      if (elev[k] <= 0 && elev[k] < elev[k - 1]) {
        kSet = k;
        break;
      }
    }
  }

  const out = new Array(nStarts);
  for (let j = 0; j < nStarts; j++) {
    const i0 = j * step;
    const kMax = Math.min(kSet, n, i0 + Math.ceil(maxM));
    let minutes = i0 >= kMax ? null : findCrossing(cum, i0, dose, kMax);
    if (minutes === null || minutes > maxM) minutes = Infinity;
    out[j] = { t: new Date(firstMs + i0 * MS_PER_MIN), elevation: elev[i0], uva: uva[i0], minutes };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lampes UV
// ---------------------------------------------------------------------------------------------

/**
 * Temps de pose (min) sous lampe UV :
 *   refMinutes · (distance / distanceRef)² · (puissanceRef / puissance) · settingsFactor.
 * L'éclairement suit la loi de l'inverse du carré de la distance, donc le TEMPS croît comme le
 * carré de la distance (½ distance → ¼ du temps). Approximation valable pour une source petite
 * devant la distance ; un banc de tubes ou un panneau LED très proche varie moins vite (~1/d).
 * Puissance/distance absentes → valeurs de référence de la source. NaN pour le soleil ou une
 * source inconnue.
 */
export function lampExposureMinutes({ sourceId, powerW, distanceCm, settings } = {}) {
  const src = getById(LIGHT_SOURCE, sourceId);
  if (!src || src.kind !== 'lamp') return NaN;
  const p = isNum(powerW) && powerW > 0 ? powerW : src.refPowerW;
  const d = isNum(distanceCm) && distanceCm > 0 ? distanceCm : src.refDistanceCm;
  return src.refMinutes * (d / src.refDistanceCm) ** 2 * (src.refPowerW / p) * settingsFactor(settings);
}

// ---------------------------------------------------------------------------------------------
// Conseils
// ---------------------------------------------------------------------------------------------

/**
 * Conseils pratiques (français) selon les conditions. Tous les champs sont facultatifs.
 * @returns {string[]}
 */
export function adviceFor({ elevationDeg, cloudCoverPct, minutes, humidityPct, temperatureC } = {}) {
  const out = [];

  if (isNum(elevationDeg)) {
    if (elevationDeg <= 0) {
      out.push(
        'Le soleil est sous l’horizon : pas d’insolation possible à la lumière du jour. Attendez le lever du soleil ou utilisez une lampe UV.'
      );
    } else if (elevationDeg < 20) {
      out.push(
        'Soleil très bas (moins de 20°) : les UV-A sont faibles et chutent vite, la pose sera très lente et irrégulière. Inclinez le châssis face au soleil, ou attendez qu’il monte.'
      );
    } else if (elevationDeg < 35) {
      out.push(
        'Soleil assez bas : incliner le châssis perpendiculairement aux rayons raccourcit nettement la pose (le calcul suppose un châssis à plat).'
      );
    }
  }

  if (isNum(cloudCoverPct)) {
    if (cloudCoverPct >= 85) {
      out.push(
        'Ciel couvert : les UV-A sont réduits de moitié environ, voire davantage sous des nuages épais. La pose est longue mais régulière ; contrôlez le virage de l’image.'
      );
    } else if (cloudCoverPct >= 25) {
      out.push(
        'Ciel variable : l’ensoleillement fluctue avec les passages nuageux. Préférez le minuteur intégré (dose cumulée) à un temps fixe, et surveillez la couleur : la pose est faite quand les ombres virent du vert-jaune au gris-bronze.'
      );
    }
  }

  if (isNum(minutes) || minutes === Infinity) {
    if (minutes === Infinity) {
      out.push(
        'Dose inatteignable avant le coucher du soleil : reportez la pose au lendemain matin ou passez sous lampe UV.'
      );
    } else if (minutes > 45) {
      out.push(
        'Pose très longue (plus de 45 min) : envisagez le New Cyanotype de Mike Ware (3 à 4 fois plus rapide), un verre extra-clair, du papier ré-humidifié ou une lampe UV.'
      );
    } else if (minutes < 3) {
      out.push(
        'Pose très courte : difficile à doser précisément. Faites une bande test et notez le temps à la seconde près.'
      );
    }
  }

  if (isNum(temperatureC) && temperatureC >= 30) {
    out.push(
      'Forte chaleur : gardez le papier sensibilisé à l’ombre jusqu’à la pose, évitez que le châssis chauffe (risque de voile et de collage du négatif) et rincez rapidement.'
    );
  }

  if (isNum(humidityPct)) {
    if (humidityPct >= 75) {
      out.push(
        'Air très humide : le papier reprend de l’humidité, la pose est un peu plus rapide mais le risque de taches et de condensation sous verre augmente.'
      );
    } else if (humidityPct <= 30) {
      out.push(
        'Air très sec : le papier sec réagit plus lentement. Une légère ré-humidification (vapeur) avant la pose accélère et densifie les bleus.'
      );
    }
  }

  if (out.length === 0) {
    out.push('Conditions favorables. Une bande test reste le meilleur moyen de confirmer le temps de pose.');
  }
  return out;
}
