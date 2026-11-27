// format.js — Formatage français des nombres, durées et paliers (fonctions pures, sans DOM).

const ESPACE_FINE = ' '; // espace fine insécable (séparateur de milliers, avant unité)

/**
 * Nombre au format français : virgule décimale, espace fine pour les milliers.
 * @param {number} x
 * @param {number} [decimales=0]
 * @returns {string} '—' si x n'est pas un nombre fini
 */
export function formatNombre(x, decimales = 0) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '—';
  const facteur = 10 ** decimales;
  let v = Math.round(x * facteur) / facteur;
  if (Object.is(v, -0)) v = 0;
  const [entier, frac] = Math.abs(v).toFixed(decimales).split('.');
  const groupe = entier.length > 4 ? entier.replace(/\B(?=(\d{3})+(?!\d))/g, ESPACE_FINE) : entier;
  return (v < 0 ? '−' : '') + groupe + (frac ? `,${frac}` : '');
}

/** Nombre pour un tableur (CSV Excel français) : virgule décimale, pas de séparateur de milliers. */
export function nombreCSV(x, decimales = 3) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '';
  const facteur = 10 ** decimales;
  let v = Math.round(x * facteur) / facteur;
  if (Object.is(v, -0)) v = 0;
  return String(v).replace('.', ',');
}

/**
 * Durée lisible à partir de minutes.
 * < 1 min : « < 1 min » ; < 60 min : « 42 min » ; < 10 h : « 2 h 05 » ; sinon « 47 h ».
 * @param {number} minutes
 * @param {{ arrondi?: 'proche'|'haut' }} [opts]
 */
export function formatDuree(minutes, { arrondi = 'proche' } = {}) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
  if (minutes < 0) return `−${formatDuree(-minutes, { arrondi })}`;
  const arr = arrondi === 'haut' ? Math.ceil : Math.round;
  if (minutes > 0 && minutes < 1) return '< 1 min';
  const m = arr(minutes);
  if (m < 60) return `${m}${ESPACE_FINE}min`;
  if (m < 600) {
    const h = Math.floor(m / 60);
    const r = m % 60;
    return r ? `${h}${ESPACE_FINE}h${ESPACE_FINE}${String(r).padStart(2, '0')}` : `${h}${ESPACE_FINE}h`;
  }
  return `${arr(m / 60)}${ESPACE_FINE}h`;
}

/**
 * Instant d'un échantillon pour l'axe ou le tableau (minutes depuis l'immersion).
 * Les minutes gardent une décimale sous 10 min (« 1,5 »), au-delà une durée lisible.
 */
export function formatInstant(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '—';
  const a = Math.abs(t);
  if (a < 60) {
    const dec = Math.abs(a - Math.round(a)) < 0.05 ? 0 : 1;
    return `${formatNombre(t, dec)}${ESPACE_FINE}min`;
  }
  return formatDuree(t);
}

/**
 * Liste de paliers en clair : « 3 min à 6 m, 7 min à 3 m ».
 * @param {{ profondeur:number, duree:number, gaz?:string, securite?:boolean }[]} paliers
 * @param {{ gazFond?: string }} [opts] le gaz est précisé s'il diffère du gaz fond
 */
export function formatPaliers(paliers, { gazFond } = {}) {
  if (!Array.isArray(paliers) || !paliers.length) return '';
  return paliers
    .map((p) => {
      let s = `${formatNombre(p.duree)}${ESPACE_FINE}min à ${formatNombre(p.profondeur)}${ESPACE_FINE}m`;
      if (p.gaz && gazFond && p.gaz !== gazFond) s += ` (${p.gaz})`;
      if (p.securite) s += ' (sécurité)';
      return s;
    })
    .join(', ');
}

/** Nom lisible d'un mélange à partir de la fraction d'O2. */
export function nomGaz(o2) {
  if (typeof o2 !== 'number' || !Number.isFinite(o2)) return '—';
  const pct = Math.round(o2 * 100);
  if (pct === 21) return 'Air';
  if (pct === 100) return 'Oxygène pur';
  return `Nitrox ${pct}`;
}
