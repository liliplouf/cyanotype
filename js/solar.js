// Position solaire — algorithme NOAA (Solar Calculator / feuille de calcul NOAA ESRL,
// d'après Jean Meeus, « Astronomical Algorithms », 1991). Précision ≈ 0,01° pour l'élévation
// entre 1800 et 2100, largement suffisante ici (contrat : < 0,1°).
// Module ES pur : aucun accès au DOM, importable dans Node et le navigateur.

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const MS_PER_DAY = 86400000;
const MS_PER_MIN = 60000;

/** Jour julien d'un instant (Date en UTC). */
function julianDay(ms) {
  return ms / MS_PER_DAY + 2440587.5;
}

function mod360(x) {
  x %= 360;
  return x < 0 ? x + 360 : x;
}

/**
 * Paramètres solaires pour un siècle julien T (depuis J2000.0) :
 * déclinaison (°) et équation du temps (min).
 */
function sunParams(T) {
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032)); // longitude moyenne
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T); // anomalie moyenne
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T); // excentricité
  const Mr = M * RAD;
  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * Mr) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * Mr) * 0.000289; // équation du centre
  const trueLong = L0 + C;
  const omega = (125.04 - 1934.136 * T) * RAD;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega); // longitude apparente
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * RAD; // obliquité corrigée
  const decl = Math.asin(Math.sin(eps) * Math.sin(appLong * RAD)); // radians

  const y = Math.tan(eps / 2) ** 2;
  const L0r = L0 * RAD;
  const eqTime =
    4 *
    DEG *
    (y * Math.sin(2 * L0r) -
      2 * e * Math.sin(Mr) +
      4 * e * y * Math.sin(Mr) * Math.cos(2 * L0r) -
      0.5 * y * y * Math.sin(4 * L0r) -
      1.25 * e * e * Math.sin(2 * Mr)); // minutes

  return { decl, eqTime };
}

function paramsAt(ms) {
  return sunParams((julianDay(ms) - 2451545) / 36525);
}

/** Réfraction atmosphérique (°) selon la formule NOAA, en fonction de l'élévation géométrique. */
function refraction(elev) {
  if (elev > 85) return 0;
  const te = Math.tan(elev * RAD);
  let arcsec;
  if (elev > 5) arcsec = 58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5;
  else if (elev > -0.575)
    arcsec = 1735 + elev * (-518.2 + elev * (103.4 + elev * (-12.79 + elev * 0.711)));
  else arcsec = -20.774 / te;
  return arcsec / 3600;
}

/**
 * Position du soleil vue depuis (lat, lon) à l'instant `date`.
 * @param {Date} date instant (UTC)
 * @param {number} lat latitude (°, nord positif)
 * @param {number} lon longitude (°, est positif)
 * @returns {{elevation:number, azimuth:number, zenith:number}} degrés ; élévation réfraction incluse,
 *   azimut compté depuis le nord dans le sens horaire, zénith = 90 − élévation (apparent).
 */
export function solarPosition(date, lat, lon) {
  const ms = date instanceof Date ? date.getTime() : +date;
  const { decl, eqTime } = paramsAt(ms);

  const utcMin = (((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_MIN;
  let tst = (utcMin + eqTime + 4 * lon) % 1440; // temps solaire vrai (min)
  if (tst < 0) tst += 1440;
  let ha = tst / 4 - 180; // angle horaire (°)
  if (ha < -180) ha += 360;

  const latR = lat * RAD;
  const sinLat = Math.sin(latR);
  const cosLat = Math.cos(latR);
  const sinDec = Math.sin(decl);
  let cosZen = sinLat * sinDec + cosLat * Math.cos(decl) * Math.cos(ha * RAD);
  cosZen = Math.max(-1, Math.min(1, cosZen));
  const zenGeomR = Math.acos(cosZen);
  const zenGeom = zenGeomR * DEG;

  const elevGeom = 90 - zenGeom;
  const elevation = elevGeom + refraction(elevGeom);

  let azimuth;
  const azDenom = cosLat * Math.sin(zenGeomR);
  if (Math.abs(azDenom) > 0.001) {
    let azRad = (sinLat * cosZen - sinDec) / azDenom;
    azRad = Math.max(-1, Math.min(1, azRad));
    azimuth = 180 - Math.acos(azRad) * DEG;
    if (ha > 0) azimuth = -azimuth;
  } else {
    azimuth = lat > 0 ? 180 : 0;
  }
  azimuth = mod360(azimuth);

  return { elevation, azimuth, zenith: 90 - elevation };
}

// Angle horaire (°) du lever/coucher : centre du soleil à 90,833° du zénith
// (réfraction standard 34' + demi-diamètre 16'). NaN si le soleil ne se lève/couche pas.
function sunriseHourAngle(latR, decl) {
  const cosH =
    Math.cos(90.833 * RAD) / (Math.cos(latR) * Math.cos(decl)) - Math.tan(latR) * Math.tan(decl);
  if (cosH > 1 || cosH < -1) return NaN;
  return Math.acos(cosH) * DEG;
}

/**
 * Lever, coucher, midi solaire et élévation maximale pour le jour solaire local contenant `date`
 * (le « jour » est déterminé par l'heure solaire moyenne du lieu, ≈ UTC + lon/15 h, ce qui évite
 * toute dépendance au fuseau horaire du navigateur).
 * @returns {{sunrise: Date|null, sunset: Date|null, solarNoon: Date, maxElevation: number}}
 *   sunrise/sunset valent null en cas de soleil de minuit ou de nuit polaire.
 */
export function sunTimes(date, lat, lon) {
  const ms = date instanceof Date ? date.getTime() : +date;
  const local = new Date(ms + (lon / 15) * 3600000);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const latR = lat * RAD;

  // Midi solaire : 720 − 4·lon − EqT (minutes UTC), itéré pour recalculer EqT au bon instant.
  let noon = midnight + (720 - 4 * lon) * MS_PER_MIN;
  for (let i = 0; i < 2; i++) {
    const { eqTime } = paramsAt(noon);
    noon = midnight + (720 - 4 * lon - eqTime) * MS_PER_MIN;
  }

  // Lever (sign = -1) / coucher (+1) : itération pour utiliser la déclinaison à l'instant même.
  const event = (sign) => {
    let t = noon;
    for (let i = 0; i < 3; i++) {
      const { decl, eqTime } = paramsAt(t);
      const H = sunriseHourAngle(latR, decl);
      if (Number.isNaN(H)) return null;
      t = midnight + (720 - 4 * (lon - sign * H) - eqTime) * MS_PER_MIN;
    }
    return new Date(t);
  };

  const solarNoon = new Date(noon);
  return {
    sunrise: event(-1),
    sunset: event(1),
    solarNoon,
    maxElevation: solarPosition(solarNoon, lat, lon).elevation,
  };
}
