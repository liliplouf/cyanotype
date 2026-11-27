// Toxicité de l'oxygène : PpO2, % CNS (limites NOAA) et OTU (unités de tolérance pulmonaire).

/**
 * Limites NOAA d'exposition unique : [PpO2 (bar), durée maximale (min)].
 * Source : NOAA Diving Manual, table « Oxygen Partial Pressure Limits ».
 */
export const LIMITES_CNS_NOAA = Object.freeze([
  [0.6, 720],
  [0.7, 570],
  [0.8, 450],
  [0.9, 360],
  [1.0, 300],
  [1.1, 240],
  [1.2, 210],
  [1.3, 180],
  [1.4, 150],
  [1.5, 120],
  [1.6, 45],
]);

/** Demi-vie usuelle d'élimination du % CNS en surface (min). */
export const DEMI_VIE_CNS = 90;

/**
 * Pression partielle d'oxygène (bar).
 * @param {number} pamb pression ambiante (bar)
 * @param {number} o2 fraction d'oxygène
 */
export function ppO2(pamb, o2) {
  return pamb * o2;
}

/**
 * Vitesse d'accumulation du CNS (% par minute) à une PpO2 donnée.
 * Nulle sous 0,5 bar ; entre 0,5 et 0,6 bar, interpolation linéaire du taux de 0 à 1/720 ;
 * de 0,6 à 1,6 bar, interpolation linéaire des durées limites NOAA ; au-delà de 1,6 bar
 * (hors table), durée limite divisée par 2 tous les 0,1 bar (extrapolation prudente).
 * @param {number} ppo2 bar
 */
export function tauxCNS(ppo2) {
  if (!(ppo2 > 0.5)) return 0;
  const T = LIMITES_CNS_NOAA;
  if (ppo2 < T[0][0]) return ((ppo2 - 0.5) / (T[0][0] - 0.5)) * (100 / T[0][1]);
  const dernier = T[T.length - 1];
  if (ppo2 >= dernier[0]) return 100 / (dernier[1] * Math.pow(2, -(ppo2 - dernier[0]) / 0.1));
  for (let i = 1; i < T.length; i++) {
    if (ppo2 <= T[i][0]) {
      const [p0, l0] = T[i - 1];
      const [p1, l1] = T[i];
      const limite = l0 + ((l1 - l0) * (ppo2 - p0)) / (p1 - p0);
      return 100 / limite;
    }
  }
  return 0;
}

/**
 * OTU par minute : ((PpO2 − 0,5) / 0,5)^(5/6), nul sous 0,5 bar (Lambertsen / Hamilton).
 * @param {number} ppo2 bar
 */
export function tauxOTU(ppo2) {
  if (!(ppo2 > 0.5)) return 0;
  return Math.pow((ppo2 - 0.5) / 0.5, 5 / 6);
}

/**
 * Exposition à l'oxygène sur un segment où la PpO2 varie linéairement (méthode du point milieu).
 * @param {number} ppo2Debut bar
 * @param {number} ppo2Fin bar
 * @param {number} duree minutes
 * @returns {{ cns: number, otu: number }} cns en %, otu en unités
 */
export function expositionOxygene(ppo2Debut, ppo2Fin, duree) {
  if (!(duree > 0)) return { cns: 0, otu: 0 };
  if (Math.abs(ppo2Fin - ppo2Debut) < 1e-12) {
    return { cns: tauxCNS(ppo2Debut) * duree, otu: tauxOTU(ppo2Debut) * duree };
  }
  const n = Math.min(4000, Math.max(4, Math.ceil(duree / 0.02)));
  const h = duree / n;
  let cns = 0;
  let otu = 0;
  for (let j = 0; j < n; j++) {
    const p = ppo2Debut + ((ppo2Fin - ppo2Debut) * (j + 0.5)) / n;
    cns += tauxCNS(p) * h;
    otu += tauxOTU(p) * h;
  }
  return { cns, otu };
}

/**
 * Décroissance du % CNS en surface (demi-vie 90 min).
 * @param {number} cns %
 * @param {number} minutes
 */
export function decroissanceCNS(cns, minutes) {
  return cns * Math.pow(0.5, minutes / DEMI_VIE_CNS);
}
