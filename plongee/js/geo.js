// geo.js — Altitude du lieu de plongée : géolocalisation du navigateur + élévation Open-Meteo.
// Utilise l'altitude GPS si l'appareil la fournit avec une précision suffisante, sinon l'API
// d'élévation (modèle numérique de terrain, Copernicus DEM 90 m, données Open-Meteo CC BY 4.0).
// navigator / fetch ne sont lus qu'à l'appel (module importable sous Node pour les tests).

export const URL_ELEVATION = 'https://api.open-meteo.com/v1/elevation';
/** Précision verticale GPS (m) en dessous de laquelle on fait confiance à coords.altitude. */
export const PRECISION_ALTITUDE_MAX = 30;

const MESSAGES = {
  indisponible: "La géolocalisation n'est pas disponible dans ce navigateur. Saisissez l'altitude à la main.",
  nonSecurise: "La géolocalisation exige une connexion sécurisée (https). Saisissez l'altitude à la main.",
  1: "Accès à la position refusé. Vous pouvez l'autoriser dans les réglages du navigateur, ou saisir l'altitude à la main.",
  2: 'Position indisponible pour le moment (pas de signal). Réessayez ou saisissez l’altitude à la main.',
  3: 'Délai dépassé pour obtenir la position. Réessayez ou saisissez l’altitude à la main.',
  sansReponse: "Pas de réponse à la demande de position. Acceptez la demande du navigateur ou saisissez l'altitude à la main.",
  horsLigne: "Pas de connexion : impossible d'interroger le service d'altitude. Saisissez l'altitude à la main.",
  service: "Le service d'altitude n'a pas répondu correctement. Saisissez l'altitude à la main.",
  inconnu: "Impossible de déterminer l'altitude. Saisissez-la à la main.",
};

export function erreurGeo(cle, cause) {
  const e = new Error(MESSAGES[cle] || MESSAGES.inconnu);
  e.code = { 1: 'refus', 2: 'indisponible', 3: 'delai' }[cle] || String(cle);
  if (cause !== undefined) e.cause = cause;
  return e;
}

/** URL de l'API d'élévation Open-Meteo pour un point. */
export function urlElevation(lat, lon) {
  const f = (x) => String(Math.round(x * 1e4) / 1e4);
  return `${URL_ELEVATION}?latitude=${encodeURIComponent(f(lat))}&longitude=${encodeURIComponent(f(lon))}`;
}

/**
 * Extrait l'altitude (m) d'une réponse Open-Meteo `{ elevation: [123.0] }`.
 * @returns {number|null}
 */
export function lireReponseElevation(json) {
  const v = json && Array.isArray(json.elevation) ? Number(json.elevation[0]) : NaN;
  return Number.isFinite(v) ? v : null;
}

/**
 * Altitude utilisable pour la plongée (≥ 0, arrondie au mètre) : un plan d'eau sous le niveau
 * de la mer (mer Morte…) est ramené à 0 par prudence et signalé.
 * @param {{ altitudeM:number|null, altitudePrecisionM:number|null }} position
 * @param {number|null} elevationApi
 * @returns {{ altitude:number, source:'gps'|'api', note:string }|null}
 */
export function choisirAltitude(position, elevationApi) {
  const gpsFiable = position
    && Number.isFinite(position.altitudeM)
    && Number.isFinite(position.altitudePrecisionM)
    && position.altitudePrecisionM <= PRECISION_ALTITUDE_MAX;
  let altitude;
  let source;
  if (gpsFiable) { altitude = position.altitudeM; source = 'gps'; }
  else if (Number.isFinite(elevationApi)) { altitude = elevationApi; source = 'api'; }
  else if (position && Number.isFinite(position.altitudeM)) { altitude = position.altitudeM; source = 'gps'; }
  else return null;
  let note = source === 'gps'
    ? `Altitude GPS de l'appareil${Number.isFinite(position.altitudePrecisionM) ? ` (± ${Math.round(position.altitudePrecisionM)} m)` : ' (précision inconnue)'}.`
    : 'Altitude du terrain (Open-Meteo, modèle de terrain ~90 m) : vérifiez-la pour un lac de montagne.';
  if (altitude < 0) { note += ' Altitude négative ramenée à 0 m.'; altitude = 0; }
  return { altitude: Math.round(altitude), source, note };
}

/**
 * Position actuelle de l'appareil.
 * @returns {Promise<{ lat:number, lon:number, precisionM:number|null, altitudeM:number|null, altitudePrecisionM:number|null }>}
 */
export function obtenirPosition({ delaiMs = 15000, geolocation } = {}) {
  return new Promise((resolve, reject) => {
    let geo = geolocation;
    if (!geo) {
      try { geo = globalThis.navigator && globalThis.navigator.geolocation; } catch { geo = null; }
    }
    if (!geo || typeof geo.getCurrentPosition !== 'function') {
      let nonSecurise = false;
      try { nonSecurise = globalThis.isSecureContext === false; } catch { /* ignore */ }
      reject(erreurGeo(nonSecurise ? 'nonSecurise' : 'indisponible'));
      return;
    }
    let fini = false;
    // Le délai natif ne court qu'après l'autorisation : garde-fou si la demande est ignorée.
    const garde = setTimeout(() => {
      if (fini) return;
      fini = true;
      reject(erreurGeo('sansReponse'));
    }, Math.max(delaiMs * 3, 30000));
    const une = (fn) => (arg) => {
      if (fini) return;
      fini = true;
      clearTimeout(garde);
      fn(arg);
    };
    const num = (x) => (x === null || x === undefined ? null : Number.isFinite(Number(x)) ? Number(x) : null);
    try {
      geo.getCurrentPosition(
        une((pos) => {
          const c = pos && pos.coords;
          const lat = c ? Number(c.latitude) : NaN;
          const lon = c ? Number(c.longitude) : NaN;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) { reject(erreurGeo('inconnu')); return; }
          resolve({ lat, lon, precisionM: num(c.accuracy), altitudeM: num(c.altitude), altitudePrecisionM: num(c.altitudeAccuracy) });
        }),
        une((e) => {
          const code = e && e.code;
          reject(erreurGeo(code === 1 || code === 2 || code === 3 ? code : 'inconnu', e));
        }),
        { enableHighAccuracy: true, timeout: delaiMs, maximumAge: 5 * 60 * 1000 },
      );
    } catch (e) {
      une(() => reject(erreurGeo('inconnu', e)))();
    }
  });
}

/** Altitude du terrain via Open-Meteo. Rejette avec un message français. */
export async function elevationOpenMeteo(lat, lon, { fetchFn, delaiMs = 10000 } = {}) {
  const f = fetchFn || globalThis.fetch;
  try {
    if (globalThis.navigator && globalThis.navigator.onLine === false) throw erreurGeo('horsLigne');
  } catch (e) {
    if (e.code) throw e;
  }
  if (typeof f !== 'function') throw erreurGeo('service');
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const minuteur = ctrl ? setTimeout(() => ctrl.abort(), delaiMs) : null;
  let rep;
  try {
    rep = await f(urlElevation(lat, lon), ctrl ? { signal: ctrl.signal } : undefined);
  } catch (e) {
    throw erreurGeo('horsLigne', e);
  } finally {
    if (minuteur) clearTimeout(minuteur);
  }
  if (!rep || !rep.ok) throw erreurGeo('service');
  let json;
  try { json = await rep.json(); } catch (e) { throw erreurGeo('service', e); }
  const v = lireReponseElevation(json);
  if (v === null) throw erreurGeo('service');
  return v;
}

/**
 * Chaîne complète pour le bouton « Ma position ».
 * @returns {Promise<{ altitude:number, source:'gps'|'api', note:string, lat:number, lon:number }>}
 */
export async function altitudeIci({ geolocation, fetchFn } = {}) {
  const pos = await obtenirPosition({ geolocation });
  const gpsFiable = Number.isFinite(pos.altitudeM) && Number.isFinite(pos.altitudePrecisionM)
    && pos.altitudePrecisionM <= PRECISION_ALTITUDE_MAX;
  let api = null;
  let erreurApi = null;
  if (!gpsFiable) {
    try { api = await elevationOpenMeteo(pos.lat, pos.lon, { fetchFn }); } catch (e) { erreurApi = e; }
  }
  const choix = choisirAltitude(pos, api);
  if (!choix) throw erreurApi || erreurGeo('inconnu');
  return { ...choix, lat: pos.lat, lon: pos.lon };
}
