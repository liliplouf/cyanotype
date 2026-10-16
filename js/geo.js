// geo.js — Géolocalisation du navigateur (agent Données).
// Module ES pur : navigator n'est lu qu'à l'appel de la fonction.

const MESSAGES = {
  unsupported: "La géolocalisation n'est pas disponible dans ce navigateur. Recherchez une ville ou saisissez les coordonnées.",
  insecure: "La géolocalisation exige une connexion sécurisée (https ou localhost). Recherchez une ville ou saisissez les coordonnées.",
  1: "Autorisation de localisation refusée. Autorisez l'accès à la position dans le navigateur, ou recherchez une ville.",
  2: 'Position indisponible pour le moment (signal GPS/réseau absent). Réessayez ou recherchez une ville.',
  3: "Délai dépassé pour obtenir la position. Réessayez ou recherchez une ville.",
  noAnswer: "Aucune réponse à la demande de localisation. Acceptez la demande d'autorisation du navigateur, ou recherchez une ville.",
  unknown: 'Impossible de déterminer la position. Recherchez une ville ou saisissez les coordonnées.',
};

function geoError(key, cause) {
  const err = new Error(MESSAGES[key] || MESSAGES.unknown);
  err.code = { 1: 'permission', 2: 'unavailable', 3: 'timeout' }[key] || String(key);
  if (cause !== undefined) err.cause = cause;
  return err;
}

/**
 * Position actuelle de l'appareil.
 * @param {{ timeoutMs?: number, highAccuracy?: boolean, maximumAgeMs?: number, geolocation?: Geolocation }} opts
 *   `geolocation` permet d'injecter une implémentation (tests).
 * @returns {Promise<{ lat: number, lon: number, accuracyM: number|null, altitudeM: number|null }>}
 */
export function getBrowserPosition({ timeoutMs = 10000, highAccuracy = false, maximumAgeMs = 5 * 60 * 1000, geolocation } = {}) {
  return new Promise((resolve, reject) => {
    let geo = geolocation;
    if (!geo) {
      try { geo = globalThis.navigator && globalThis.navigator.geolocation; } catch { geo = null; }
    }
    if (!geo || typeof geo.getCurrentPosition !== 'function') {
      let insecure = false;
      try { insecure = globalThis.isSecureContext === false; } catch { /* ignore */ }
      reject(geoError(insecure ? 'insecure' : 'unsupported'));
      return;
    }

    let settled = false;
    // Le timeout natif ne court qu'après l'autorisation : garde-fou si l'utilisateur ignore la demande.
    const guard = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(geoError('noAnswer'));
    }, Math.max(timeoutMs * 3, 30000));

    const done = (fn) => (arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      fn(arg);
    };

    try {
      geo.getCurrentPosition(
        done((pos) => {
          const c = pos && pos.coords;
          const lat = c ? Number(c.latitude) : NaN;
          const lon = c ? Number(c.longitude) : NaN;
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
            reject(geoError('unknown'));
            return;
          }
          const acc = Number(c.accuracy);
          const alt = c.altitude === null || c.altitude === undefined ? NaN : Number(c.altitude);
          resolve({
            lat,
            lon,
            accuracyM: Number.isFinite(acc) ? acc : null,
            altitudeM: Number.isFinite(alt) ? alt : null,
          });
        }),
        done((err) => {
          const code = err && err.code;
          reject(geoError(code === 1 || code === 2 || code === 3 ? code : 'unknown', err));
        }),
        { enableHighAccuracy: highAccuracy, timeout: timeoutMs, maximumAge: maximumAgeMs },
      );
    } catch (e) {
      done(() => reject(geoError('unknown', e)))();
    }
  });
}
