// Modèle de Bühlmann ZHL-16C (azote seul) et facteurs de gradient (Baker).
//
// Coefficients ZHL-16C pour l'azote : A. A. Bühlmann, E. B. Völlm, P. Nussberger,
// « Tauchmedizin », 5e éd., Springer, 2002 (table ZHL-16C). Le compartiment 1 utilisé ici
// est le 1 « classique » (demi-vie 4 min, a = 1,2599, b = 0,5050) ; la variante 1b
// (5 min, a = 1,1696, b = 0,5578) est celle retenue par certains logiciels (Subsurface,
// core/deco.cpp, qui donne les mêmes valeurs que ci-dessous pour les compartiments 2 à 16 —
// vérifié). Ces deux sources concordent sur les compartiments 2–16.
//
// M-value (bar) : M(pamb) = a + pamb / b.
// Facteurs de gradient : la tension tolérée est pamb + GF × (M(pamb) − pamb).

import { profondeurDepuisPression } from './physique.js';

const LN2 = Math.LN2;

/** Les 16 compartiments ZHL-16C (azote) : n, demi-vie (min), a (bar), b. */
export const COMPARTIMENTS_ZHL16C = Object.freeze(
  [
    [1, 4.0, 1.2599, 0.505],
    [2, 8.0, 1.0, 0.6514],
    [3, 12.5, 0.8618, 0.7222],
    [4, 18.5, 0.7562, 0.7825],
    [5, 27.0, 0.62, 0.8126],
    [6, 38.3, 0.5043, 0.8434],
    [7, 54.3, 0.441, 0.8693],
    [8, 77.0, 0.4, 0.891],
    [9, 109.0, 0.375, 0.9092],
    [10, 146.0, 0.35, 0.9222],
    [11, 187.0, 0.3295, 0.9319],
    [12, 239.0, 0.3065, 0.9403],
    [13, 305.0, 0.2835, 0.9477],
    [14, 390.0, 0.261, 0.9544],
    [15, 498.0, 0.248, 0.9602],
    [16, 635.0, 0.2327, 0.9653],
  ].map(([n, demiVie, a, b]) => Object.freeze({ n, demiVie, a, b })),
);

const NB = COMPARTIMENTS_ZHL16C.length;
const K = COMPARTIMENTS_ZHL16C.map((c) => LN2 / c.demiVie);

/**
 * Équation de Haldane : tension après `duree` minutes à pression inspirée constante.
 * @param {number} p0 tension initiale (bar)
 * @param {number} pi pression inspirée (bar)
 * @param {number} duree minutes
 * @param {number} demiVie minutes
 */
export function haldane(p0, pi, duree, demiVie) {
  return pi + (p0 - pi) * Math.exp((-LN2 / demiVie) * duree);
}

/**
 * Équation de Schreiner : pression inspirée variant linéairement (pi(t) = pi0 + r·t).
 * @param {number} p0 tension initiale (bar)
 * @param {number} pi0 pression inspirée au début (bar)
 * @param {number} r vitesse de variation de la pression inspirée (bar/min)
 * @param {number} duree minutes
 * @param {number} demiVie minutes
 */
export function schreiner(p0, pi0, r, duree, demiVie) {
  const k = LN2 / demiVie;
  return pi0 + r * (duree - 1 / k) - (pi0 - p0 - r / k) * Math.exp(-k * duree);
}

/**
 * M-value (tension maximale tolérée, bar) à la pression ambiante pamb.
 * @param {number} a
 * @param {number} b
 * @param {number} pamb bar
 */
export function mValue(a, b, pamb) {
  return a + pamb / b;
}

/**
 * Pression ambiante minimale tolérée (bar) par un compartiment, avec un facteur de gradient.
 * C'est le « plafond » exprimé en pression ; convertir en profondeur avec
 * profondeurDepuisPression.
 * @param {number} pN2 tension d'azote (bar)
 * @param {number} a
 * @param {number} b
 * @param {number} gf facteur de gradient en fraction (0,85 pour 85 %)
 */
export function plafondCompartiment(pN2, a, b, gf) {
  return (pN2 - a * gf) / (gf / b + 1 - gf);
}

/**
 * Facteur de gradient (fraction) à une profondeur : GF bas au premier palier, GF haut à la
 * surface, interpolation linéaire entre les deux ; GF bas au-delà du premier palier.
 * @param {number} prof m
 * @param {number} premierPalier m (0 ⇒ GF haut partout)
 * @param {number} gfBas fraction
 * @param {number} gfHaut fraction
 */
export function gfInterpole(prof, premierPalier, gfBas, gfHaut) {
  if (!(premierPalier > 0)) return gfHaut;
  if (prof >= premierPalier) return gfBas;
  if (prof <= 0) return gfHaut;
  return gfHaut + ((gfBas - gfHaut) * prof) / premierPalier;
}

/**
 * Plafond global : pression tolérée la plus élevée parmi les 16 compartiments.
 * @param {number[]} tissus tensions d'azote (bar)
 * @param {number} gf fraction
 * @returns {{ pression: number, directeur: number }} directeur numéroté de 1 à 16
 */
export function plafondGlobal(tissus, gf) {
  let pression = -Infinity;
  let directeur = 1;
  for (let i = 0; i < NB; i++) {
    const c = COMPARTIMENTS_ZHL16C[i];
    const p = plafondCompartiment(tissus[i], c.a, c.b, gf);
    if (p > pression) {
      pression = p;
      directeur = i + 1;
    }
  }
  return { pression, directeur };
}

/**
 * Plafond global en profondeur (m, 0 si aucun).
 * @param {number[]} tissus
 * @param {number} gf fraction
 * @param {number} psurf bar
 * @param {'mer'|'douce'} eau
 */
export function plafondProfondeur(tissus, gf, psurf, eau) {
  const { pression, directeur } = plafondGlobal(tissus, gf);
  return { plafond: Math.max(0, profondeurDepuisPression(pression, psurf, eau)), directeur };
}

/** Haldane appliqué aux 16 compartiments. */
export function haldaneTous(tissus, pi, duree) {
  const r = new Array(NB);
  for (let i = 0; i < NB; i++) r[i] = pi + (tissus[i] - pi) * Math.exp(-K[i] * duree);
  return r;
}

/** Schreiner appliqué aux 16 compartiments. */
export function schreinerTous(tissus, pi0, rate, duree) {
  const r = new Array(NB);
  for (let i = 0; i < NB; i++) {
    const k = K[i];
    r[i] = pi0 + rate * (duree - 1 / k) - (pi0 - tissus[i] - rate / k) * Math.exp(-k * duree);
  }
  return r;
}

/**
 * Pourcentages de charge : de la M-value ambiante, de la M-value de surface et du gradient.
 * @param {number[]} tissus
 * @param {number} pamb bar
 * @param {number} psurf bar
 */
export function pourcentages(tissus, pamb, psurf) {
  const pctMAmb = new Array(NB);
  const pctMSurf = new Array(NB);
  const pctGF = new Array(NB);
  for (let i = 0; i < NB; i++) {
    const { a, b } = COMPARTIMENTS_ZHL16C[i];
    const mAmb = mValue(a, b, pamb);
    pctMAmb[i] = (tissus[i] / mAmb) * 100;
    pctMSurf[i] = (tissus[i] / mValue(a, b, psurf)) * 100;
    pctGF[i] = ((tissus[i] - pamb) / (mAmb - pamb)) * 100;
  }
  return { pctMAmb, pctMSurf, pctGF };
}

/** Constante de temps k = ln 2 / demi-vie du compartiment i (0–15). */
export function constanteTemps(i) {
  return K[i];
}
