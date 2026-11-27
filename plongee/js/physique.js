// Physique de base de la plongée : pressions, altitude, gaz.
// Unités : bar, mètres, minutes, fractions (0–1) pour les gaz.

/** Pression atmosphérique standard au niveau de la mer (bar). */
export const P0 = 1.01325;
/** Pression partielle de vapeur d'eau alvéolaire (bar), convention Bühlmann. */
export const PH2O = 0.0627;
/** Fraction d'azote de l'air (argon compté avec l'azote, convention Bühlmann). */
export const FN2_AIR = 0.7902;
/** Fraction d'oxygène de l'air. */
export const FO2_AIR = 0.21;
/** Accélération de la pesanteur (m/s²). */
export const G = 9.80665;
/** Masses volumiques de l'eau (kg/L). */
export const MASSES_VOLUMIQUES = Object.freeze({ mer: 1.025, douce: 1.0 });

/**
 * Variation de pression par mètre d'eau (bar/m).
 * @param {'mer'|'douce'} [eau='mer']
 */
export function barParMetre(eau = 'mer') {
  const rho = MASSES_VOLUMIQUES[eau] ?? MASSES_VOLUMIQUES.mer;
  return (rho * G) / 100;
}

/**
 * Pression atmosphérique (bar) à l'altitude h (m), atmosphère standard ISA.
 * @param {number} h altitude en mètres
 */
export function pressionAltitude(h) {
  return P0 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
}

/**
 * Pression ambiante absolue (bar) à une profondeur donnée.
 * @param {number} prof profondeur (m)
 * @param {number} psurf pression de surface (bar)
 * @param {'mer'|'douce'} [eau='mer']
 */
export function pressionAmbiante(prof, psurf, eau = 'mer') {
  return psurf + prof * barParMetre(eau);
}

/**
 * Profondeur (m) correspondant à une pression absolue (peut être négative si p < psurf).
 * @param {number} p pression absolue (bar)
 * @param {number} psurf pression de surface (bar)
 * @param {'mer'|'douce'} [eau='mer']
 */
export function profondeurDepuisPression(p, psurf, eau = 'mer') {
  return (p - psurf) / barParMetre(eau);
}

/** Vrai si la fraction d'O2 correspond à de l'air (21 %). */
export function estAir(o2) {
  return Math.round(o2 * 100) === 21;
}

/**
 * Fraction d'azote d'un mélange O2/N2 : 0,7902 pour l'air (convention Bühlmann), 1 − O2 sinon.
 * @param {number} o2 fraction d'oxygène
 */
export function fractionN2(o2) {
  return estAir(o2) ? FN2_AIR : Math.max(0, 1 - o2);
}

/**
 * Nom usuel d'un mélange : « Air », « Nx32 », « O2 ».
 * @param {number} o2 fraction d'oxygène
 */
export function nomGaz(o2) {
  const pct = Math.round(o2 * 100);
  if (pct === 21) return 'Air';
  if (pct >= 100) return 'O2';
  return `Nx${pct}`;
}

/**
 * Pression partielle d'azote inspirée (bar), vapeur d'eau déduite.
 * @param {number} pamb pression ambiante (bar)
 * @param {number} fN2 fraction d'azote
 */
export function pressionInspiree(pamb, fN2) {
  return Math.max(0, pamb - PH2O) * fN2;
}

/**
 * Tension d'azote des tissus à l'équilibre en surface (air), à la pression psurf.
 * @param {number} psurf pression de surface (bar)
 */
export function equilibreN2(psurf) {
  return pressionInspiree(psurf, FN2_AIR);
}

/**
 * Profondeur maximale d'utilisation (MOD, m) d'un mélange pour une PpO2 maximale.
 * @param {number} o2 fraction d'oxygène
 * @param {number} ppo2Max PpO2 maximale (bar)
 * @param {number} psurf pression de surface (bar)
 * @param {'mer'|'douce'} [eau='mer']
 */
export function profondeurMOD(o2, ppo2Max, psurf, eau = 'mer') {
  return profondeurDepuisPression(ppo2Max / o2, psurf, eau);
}
