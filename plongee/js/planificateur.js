// Planificateur de plongée : Bühlmann ZHL-16C + facteurs de gradient.
// Fonction pure, synchrone, sans DOM : planifier(params) → résultat (voir SPEC.md).
//
// Principes :
// - Simulation par segments exacts (Schreiner si la profondeur varie, Haldane sinon) ;
//   les échantillons sont recalculés depuis le début de chaque segment (aucune erreur cumulée).
// - Remontée sur une grille de profondeurs (multiples de stopIncrement) : on ne quitte une
//   profondeur que si, après la remontée jusqu'à la suivante, le plafond (avec le GF de la
//   profondeur d'arrivée) reste au-dessus de celle-ci ; sinon on attend par minutes entières.
// - Déco obligatoire si une remontée directe vérifiée avec le GF haut est impossible
//   (même convention que la NDL, comme la plupart des ordinateurs). Dans ce cas, méthode de
//   Baker : remontée projetée avec le GF bas pour trouver le 1er palier, puis GF interpolé
//   linéairement entre ce 1er palier (GF bas) et la surface (GF haut).
// - En surface : formule exacte de Haldane (désaturation, délai avion, échantillons espacés
//   de façon logarithmique).

import {
  pressionAltitude,
  barParMetre,
  pressionInspiree,
  equilibreN2,
  fractionN2,
  nomGaz,
  estAir,
  profondeurMOD,
  FO2_AIR,
  FN2_AIR,
} from './physique.js';
import {
  COMPARTIMENTS_ZHL16C,
  haldaneTous,
  schreinerTous,
  plafondGlobal,
  gfInterpole,
  pourcentages,
  constanteTemps,
} from './buhlmann.js';
import { expositionOxygene, decroissanceCNS } from './oxygene.js';
import { bilanConsommation } from './consommation.js';

/** Valeurs par défaut de tous les paramètres (voir SPEC.md). */
export const PARAMETRES_DEFAUT = {
  niveaux: [{ profondeur: 30, duree: 20 }],
  dureeInclutDescente: true,
  gaz: { o2: 0.21 },
  gazDeco: [],
  altitude: 0,
  eau: 'mer',
  vitesseDescente: 20,
  vitesseRemontee: 10,
  gfBas: 40,
  gfHaut: 85,
  stopIncrement: 3,
  lastStopDepth: 3,
  safetyStop: { actif: true, profondeur: 5, duree: 3 },
  ppo2Max: 1.4,
  ppo2MaxDeco: 1.6,
  desatThreshold: 0.02,
  plongeePrecedente: null,
  acclimatation: null,
  consommation: null,
};

const NB = COMPARTIMENTS_ZHL16C.length;
/** NDL maximale calculée (min) : au-delà, la NDL est considérée comme illimitée. */
export const NDL_MAX = 999;
/** Durée maximale de la simulation en surface (min). */
export const DESAT_MAX = 96 * 60;
/** Pression de cabine d'avion (bar). */
export const PRESSION_CABINE = 0.75;
const MAX_ECHANTILLONS = 2000;
const MAX_MINUTES_PALIERS = 1500;
const PROFONDEUR_LIMITE = 120;
/**
 * Tolérance (bar) sur la PpO2 maximale aux paliers pour la bascule de gaz : l'O2 pur à 6 m
 * en eau de mer donne 1,616 bar ; l'usage courant (O2 à 6 m, Nx50 à 21 m) reste ainsi possible.
 */
const TOLERANCE_BASCULE = 0.02;
const HEURES_SURFACE = [10, 30, 60, 120, 240, 360, 720, 1440, 2880];
const AIR = Object.freeze({ o2: FO2_AIR, fN2: FN2_AIR, nom: 'Air', indexDeco: -1 });

class ErreurPlan extends Error {}

// ───────────────────────────── utilitaires ─────────────────────────────

const arr = (x, d) => {
  const f = 10 ** d;
  return Math.round(x * f) / f;
};
/** Nombre au format français (virgule décimale). */
const fmt = (x, d = 1) => String(arr(x, d)).replace('.', ',');
/** Durée lisible : « 45 min », « 3 h 20 », « 2 j 4 h ». */
function fmtDuree(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h < 48) return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
  return `${Math.floor(h / 24)} j ${h % 24} h`;
}
const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const val = (v, def) => (v === null || v === undefined || v === '' ? def : v);
const fini = (x) => Number.isFinite(x);

// ───────────────────────────── paramètres ─────────────────────────────

function normaliserNiveaux(v) {
  return Array.isArray(v) ? v.map((n) => ({ profondeur: num(n?.profondeur), duree: num(n?.duree) })) : [];
}

function normaliser(params) {
  const p = params && typeof params === 'object' ? params : {};
  const d = PARAMETRES_DEFAUT;
  const s = p.safetyStop ?? {};
  const pp = p.plongeePrecedente;
  const ac = p.acclimatation;
  const co = p.consommation;
  return {
    niveaux: normaliserNiveaux(p.niveaux ?? d.niveaux),
    dureeInclutDescente: Boolean(val(p.dureeInclutDescente, d.dureeInclutDescente)),
    gaz: { o2: num(val(p.gaz?.o2, d.gaz.o2)) },
    gazDeco: Array.isArray(p.gazDeco)
      ? p.gazDeco.map((g) => ({
          o2: num(g?.o2),
          profondeurBascule: num(g?.profondeurBascule),
          volume: num(g?.volume),
          pression: num(g?.pression),
          reserve: num(val(g?.reserve, 0)),
        }))
      : [],
    altitude: num(val(p.altitude, d.altitude)),
    eau: val(p.eau, d.eau),
    vitesseDescente: num(val(p.vitesseDescente, d.vitesseDescente)),
    vitesseRemontee: num(val(p.vitesseRemontee, d.vitesseRemontee)),
    gfBas: num(val(p.gfBas, d.gfBas)),
    gfHaut: num(val(p.gfHaut, d.gfHaut)),
    stopIncrement: num(val(p.stopIncrement, d.stopIncrement)),
    lastStopDepth: num(val(p.lastStopDepth, d.lastStopDepth)),
    safetyStop: {
      actif: Boolean(val(s.actif, d.safetyStop.actif)),
      profondeur: num(val(s.profondeur, d.safetyStop.profondeur)),
      duree: num(val(s.duree, d.safetyStop.duree)),
    },
    ppo2Max: num(val(p.ppo2Max, d.ppo2Max)),
    ppo2MaxDeco: num(val(p.ppo2MaxDeco, d.ppo2MaxDeco)),
    desatThreshold: num(val(p.desatThreshold, d.desatThreshold)),
    plongeePrecedente: pp
      ? {
          niveaux: normaliserNiveaux(pp.niveaux),
          gaz: { o2: num(val(pp.gaz?.o2, FO2_AIR)) },
          intervalle: num(pp.intervalle),
        }
      : null,
    acclimatation: ac
      ? { altitudeOrigine: num(val(ac.altitudeOrigine, 0)), heuresDepuisArrivee: num(ac.heuresDepuisArrivee) }
      : null,
    consommation: co
      ? { sac: num(co.sac), volume: num(co.volume), pression: num(co.pression), reserve: num(val(co.reserve, 0)) }
      : null,
  };
}

function validerO2(o2, libelle, erreurs) {
  if (!fini(o2) || o2 <= 0 || o2 > 1) {
    erreurs.push(`${libelle} : la fraction d'oxygène doit être comprise entre 0,18 et 1 (ex. 0,32 pour du Nx32).`);
  } else if (o2 < 0.18) {
    erreurs.push(`${libelle} : mélange hypoxique en surface (O2 < 18 %), non pris en charge.`);
  }
}

function validerNiveaux(niveaux, prefixe, p, erreurs) {
  if (!niveaux.length) {
    erreurs.push(`${prefixe}ajoutez au moins un niveau (profondeur et durée).`);
    return;
  }
  const vitessesOk = p.vitesseDescente > 0 && p.vitesseRemontee > 0;
  let prec = 0;
  niveaux.forEach((n, i) => {
    const lib = `${prefixe}niveau ${i + 1}`;
    let profOk = false;
    if (!fini(n.profondeur)) erreurs.push(`${majuscule(lib)} : profondeur manquante ou invalide.`);
    else if (n.profondeur <= 0) erreurs.push(`${majuscule(lib)} : la profondeur doit être positive (reçu ${fmt(n.profondeur)} m).`);
    else if (n.profondeur > PROFONDEUR_LIMITE)
      erreurs.push(`${majuscule(lib)} : profondeur supérieure à ${PROFONDEUR_LIMITE} m, hors du domaine de ce calculateur.`);
    else profOk = true;
    let dureeOk = false;
    if (!fini(n.duree)) erreurs.push(`${majuscule(lib)} : durée manquante ou invalide.`);
    else if (n.duree <= 0) erreurs.push(`${majuscule(lib)} : la durée doit être strictement positive.`);
    else if (n.duree > 600) erreurs.push(`${majuscule(lib)} : durée supérieure à 600 min, hors du domaine de ce calculateur.`);
    else dureeOk = true;
    if (profOk && dureeOk && vitessesOk && p.dureeInclutDescente) {
      const transit = Math.abs(n.profondeur - prec) / (n.profondeur > prec ? p.vitesseDescente : p.vitesseRemontee);
      if (n.duree + 1e-9 < transit) {
        erreurs.push(
          `${majuscule(lib)} : la durée (${fmt(n.duree)} min) est plus courte que le trajet pour atteindre ` +
            `${fmt(n.profondeur)} m (${fmt(transit)} min) ; la durée est comptée depuis ${i === 0 ? "l'immersion" : 'la fin du niveau précédent'}.`,
        );
      }
    }
    if (profOk) prec = n.profondeur;
  });
}

/** « de l'air », « de l'O2 », « du Nx32 ». */
const duGaz = (nom) => (nom === 'Air' ? "de l'air" : nom === 'O2' ? "de l'O2" : `du ${nom}`);
const majuscule = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function valider(p) {
  const e = [];
  validerNiveaux(p.niveaux, '', p, e);
  validerO2(p.gaz.o2, 'Gaz', e);
  p.gazDeco.forEach((g, i) => {
    validerO2(g.o2, `Gaz de déco ${i + 1}`, e);
    if (!fini(g.profondeurBascule) || g.profondeurBascule < 0)
      e.push(`Gaz de déco ${i + 1} : profondeur de bascule manquante ou négative.`);
    if (fini(g.volume) && g.volume <= 0) e.push(`Gaz de déco ${i + 1} : le volume de la bouteille doit être positif.`);
  });
  if (!fini(p.altitude) || p.altitude < -450 || p.altitude > 6000)
    e.push("Altitude invalide : elle doit être comprise entre −450 m et 6 000 m.");
  if (p.eau !== 'mer' && p.eau !== 'douce') e.push("Type d'eau invalide : « mer » ou « douce ».");
  if (!fini(p.vitesseDescente) || p.vitesseDescente <= 0 || p.vitesseDescente > 100)
    e.push('Vitesse de descente invalide : elle doit être comprise entre 0 et 100 m/min.');
  if (!fini(p.vitesseRemontee) || p.vitesseRemontee <= 0 || p.vitesseRemontee > 30)
    e.push('Vitesse de remontée invalide : elle doit être comprise entre 0 et 30 m/min.');
  if (!fini(p.gfBas) || p.gfBas < 5 || p.gfBas > 100) e.push('GF bas invalide : il doit être compris entre 5 et 100 %.');
  if (!fini(p.gfHaut) || p.gfHaut < 5 || p.gfHaut > 100) e.push('GF haut invalide : il doit être compris entre 5 et 100 %.');
  if (fini(p.gfBas) && fini(p.gfHaut) && p.gfBas > p.gfHaut) e.push('Le GF bas ne peut pas dépasser le GF haut.');
  if (!fini(p.stopIncrement) || p.stopIncrement <= 0 || p.stopIncrement > 10)
    e.push('Écart entre paliers invalide : il doit être compris entre 0 et 10 m.');
  if (!fini(p.lastStopDepth) || p.lastStopDepth <= 0 || p.lastStopDepth > 10)
    e.push('Profondeur du dernier palier invalide (3 ou 6 m en général).');
  if (p.safetyStop.actif) {
    if (!fini(p.safetyStop.profondeur) || p.safetyStop.profondeur <= 0 || p.safetyStop.profondeur > 10)
      e.push('Palier de sécurité : la profondeur doit être comprise entre 0 et 10 m.');
    if (!fini(p.safetyStop.duree) || p.safetyStop.duree < 0 || p.safetyStop.duree > 30)
      e.push('Palier de sécurité : la durée doit être comprise entre 0 et 30 min.');
  }
  if (!fini(p.ppo2Max) || p.ppo2Max < 0.5 || p.ppo2Max > 2) e.push('PpO2 maximale invalide : entre 0,5 et 2 bar.');
  if (!fini(p.ppo2MaxDeco) || p.ppo2MaxDeco < 0.5 || p.ppo2MaxDeco > 2)
    e.push('PpO2 maximale aux paliers invalide : entre 0,5 et 2 bar.');
  if (!fini(p.desatThreshold) || p.desatThreshold <= 0 || p.desatThreshold >= 1)
    e.push('Seuil de désaturation invalide : il doit être compris entre 0 et 1 (0,02 = 2 %).');
  if (p.plongeePrecedente) {
    const pp = p.plongeePrecedente;
    validerNiveaux(pp.niveaux, 'plongée précédente, ', p, e);
    validerO2(pp.gaz.o2, 'Plongée précédente, gaz', e);
    if (!fini(pp.intervalle) || pp.intervalle < 0)
      e.push("Plongée précédente : l'intervalle de surface doit être positif ou nul (en minutes).");
  }
  if (p.acclimatation) {
    const a = p.acclimatation;
    if (!fini(a.altitudeOrigine) || a.altitudeOrigine < -450 || a.altitudeOrigine > 6000)
      e.push("Acclimatation : altitude d'origine invalide (entre −450 m et 6 000 m).");
    if (!fini(a.heuresDepuisArrivee) || a.heuresDepuisArrivee < 0)
      e.push("Acclimatation : le nombre d'heures depuis l'arrivée doit être positif ou nul.");
  }
  if (p.consommation) {
    const c = p.consommation;
    if (!fini(c.sac) || c.sac <= 0 || c.sac > 100) e.push('Consommation : le SAC doit être compris entre 0 et 100 L/min.');
    if (!fini(c.volume) || c.volume <= 0) e.push('Consommation : le volume de la bouteille doit être positif.');
    if (!fini(c.pression) || c.pression <= 0) e.push('Consommation : la pression de gonflage doit être positive.');
    if (!fini(c.reserve) || c.reserve < 0) e.push('Consommation : la réserve doit être positive ou nulle.');
    else if (fini(c.pression) && c.reserve >= c.pression)
      e.push('Consommation : la réserve doit être inférieure à la pression de gonflage.');
  }
  return e;
}

// ───────────────────────────── contexte de calcul ─────────────────────────────

function gazDe(o2, indexDeco = -1, bascule = null) {
  return Object.freeze({ o2, fN2: fractionN2(o2), nom: nomGaz(o2), indexDeco, bascule });
}

function contexte(p) {
  const psurf = pressionAltitude(p.altitude);
  const bpm = barParMetre(p.eau);
  return {
    psurf,
    eau: p.eau,
    pamb: (d) => psurf + d * bpm,
    prof: (P) => (P - psurf) / bpm,
    eqN2: equilibreN2(psurf),
    vD: p.vitesseDescente,
    vR: p.vitesseRemontee,
    gfBas: p.gfBas / 100,
    gfHaut: p.gfHaut / 100,
    inc: p.stopIncrement,
    last: p.lastStopDepth,
    secu: p.safetyStop,
    inclut: p.dureeInclutDescente,
    ppo2Max: p.ppo2Max,
    ppo2MaxDeco: p.ppo2MaxDeco,
    seuil: p.desatThreshold,
    gazDeco: p.gazDeco.map((g, i) => gazDe(g.o2, i, g.profondeurBascule)),
  };
}

/** Tissus après un segment de `duree` min où la profondeur passe linéairement de d0 à d1. */
function avancer(T, d0, d1, duree, g, ctx) {
  if (!(duree > 0)) return T.slice();
  const pi0 = pressionInspiree(ctx.pamb(d0), g.fN2);
  const pi1 = pressionInspiree(ctx.pamb(d1), g.fN2);
  return schreinerTous(T, pi0, (pi1 - pi0) / duree, duree);
}

/** Meilleur gaz respirable à la profondeur d (O2 le plus riche autorisé), sinon le gaz actuel. */
function choisirGaz(d, g, ctx) {
  let meilleur = g;
  for (const c of ctx.gazDeco) {
    if (c.bascule + 1e-9 >= d && c.o2 * ctx.pamb(d) <= ctx.ppo2MaxDeco + TOLERANCE_BASCULE && c.o2 > meilleur.o2 + 1e-9) meilleur = c;
  }
  return meilleur;
}

/** Profondeur suivante sur la grille des paliers (0 = surface). */
function prochaine(d, ctx, profSecu) {
  let n = Math.ceil(d / ctx.inc - 1e-6) * ctx.inc - ctx.inc;
  if (n < ctx.last - 1e-9) n = 0;
  if (profSecu != null && d > profSecu + 1e-9 && n < profSecu - 1e-9) n = profSecu;
  return Math.max(0, n);
}

/**
 * Remontée depuis la profondeur d sur la grille des paliers.
 * @param {object} o
 * @param {(n:number)=>number} o.gfFn GF (fraction) exigé à l'arrivée à la profondeur n
 * @param {boolean} [o.arreterSiEchec] renvoyer dès qu'un palier serait nécessaire
 * @param {{profondeur:number,duree:number}|null} [o.securite] palier de sécurité à insérer
 * @param {number|null} [o.premierPalier] profondeur où un palier d'au moins 1 min est imposé
 */
function remontee(T, d, g, ctx, { gfFn, arreterSiEchec = false, securite = null, premierPalier = null }) {
  const segs = [];
  let tissus = T;
  let gaz = g;
  let secuFaite = !securite;
  let premierFait = premierPalier == null;
  let minutes = 0;
  while (d > 1e-9) {
    const n = prochaine(d, ctx, secuFaite ? null : securite.profondeur);
    const dur = (d - n) / ctx.vR;
    const gf = gfFn(n);
    const pn = ctx.pamb(n);
    const piPalier = pressionInspiree(ctx.pamb(d), gaz.fN2);
    const forcer = !premierFait && Math.abs(d - premierPalier) < 1e-6;
    let k = 0;
    for (;;) {
      if (!(forcer && k === 0)) {
        const essai = avancer(tissus, d, n, dur, gaz, ctx);
        if (plafondGlobal(essai, gf).pression <= pn + 1e-9) break;
        if (arreterSiEchec) return { echec: true, profEchec: d, segs, tissus, gaz };
      }
      tissus = haldaneTous(tissus, piPalier, 1);
      k++;
      if (++minutes > MAX_MINUTES_PALIERS)
        throw new ErreurPlan('Décompression trop longue (plus de 25 h de paliers) : profil hors du domaine de ce calculateur.');
    }
    if (forcer) premierFait = true;
    if (k > 0) segs.push({ type: 'palier', d0: d, d1: d, duree: k, gaz, securite: false });
    tissus = avancer(tissus, d, n, dur, gaz, ctx);
    segs.push({ type: 'remontee', d0: d, d1: n, duree: dur, gaz });
    d = n;
    if (d > 1e-9) {
      gaz = choisirGaz(d, gaz, ctx);
      if (!secuFaite && Math.abs(d - securite.profondeur) < 1e-9) {
        if (securite.duree > 0) {
          tissus = haldaneTous(tissus, pressionInspiree(ctx.pamb(d), gaz.fN2), securite.duree);
          segs.push({ type: 'palier', d0: d, d1: d, duree: securite.duree, gaz, securite: true });
        }
        secuFaite = true;
      }
    }
  }
  return { echec: false, segs, tissus, gaz };
}

/** Plan de remontée complet depuis le fond : sans palier obligatoire, ou méthode GF de Baker. */
function planRemontee(T, d, g, ctx, profMax) {
  const gfHaut = () => ctx.gfHaut;
  const direct = remontee(T, d, g, ctx, { gfFn: gfHaut, arreterSiEchec: true });
  if (!direct.echec) {
    const s = ctx.secu;
    const secu = s.actif && s.duree > 0 && profMax > s.profondeur ? s : null;
    const r = secu ? remontee(T, d, g, ctx, { gfFn: gfHaut, securite: secu }) : direct;
    return { deco: false, F: 0, segs: r.segs };
  }
  // Remontée projetée avec le GF bas : le premier arrêt nécessaire est le 1er palier.
  const proj = remontee(T, d, g, ctx, { gfFn: () => ctx.gfBas, arreterSiEchec: true });
  const F = proj.echec ? proj.profEchec : ctx.last;
  const r = remontee(T, d, g, ctx, {
    gfFn: (n) => gfInterpole(n, F, ctx.gfBas, ctx.gfHaut),
    premierPalier: F,
  });
  return { deco: true, F, segs: r.segs };
}

/** Temps (min) restant à la profondeur D avant qu'une remontée sans palier devienne impossible. */
function calculerNdl(T0, D, g, ctx) {
  const pi = pressionInspiree(ctx.pamb(D), g.fN2);
  const ok = (x) => !remontee(haldaneTous(T0, pi, x), D, g, ctx, { gfFn: () => ctx.gfHaut, arreterSiEchec: true }).echec;
  if (!ok(0)) return { ndl: null, illimite: false };
  if (ok(NDL_MAX)) return { ndl: NDL_MAX, illimite: true };
  let lo = 0;
  let hi = NDL_MAX;
  while (hi - lo > 0.005) {
    const m = (lo + hi) / 2;
    if (ok(m)) lo = m;
    else hi = m;
  }
  return { ndl: Math.floor(lo + 1e-6), illimite: false };
}

/**
 * Temps (min) en surface jusqu'à ce que chaque compartiment ait un excès d'azote
 * ≤ seuil × tension d'équilibre (Haldane exact). Non plafonné.
 */
export function tempsDesaturation(T, psurf, seuil) {
  const eq = equilibreN2(psurf);
  let t = 0;
  for (let i = 0; i < NB; i++) {
    const exces = T[i] - eq;
    if (exces > seuil * eq) t = Math.max(t, Math.log(exces / (seuil * eq)) / constanteTemps(i));
  }
  return t;
}

/**
 * Temps (min) en surface avant que le plafond (GF haut) soit compatible avec une pression
 * de cabine `pcab` (0,75 bar par défaut).
 */
export function tempsAvion(T, psurf, gf, pcab = PRESSION_CABINE) {
  const eq = equilibreN2(psurf);
  let t = 0;
  for (let i = 0; i < NB; i++) {
    const { a, b } = COMPARTIMENTS_ZHL16C[i];
    const limite = pcab * (gf / b + 1 - gf) + a * gf; // tension maximale pour plafond ≤ pcab
    if (T[i] > limite && limite > eq) t = Math.max(t, Math.log((T[i] - eq) / (limite - eq)) / constanteTemps(i));
  }
  return t;
}

// ───────────────────────────── simulation d'une plongée ─────────────────────────────

function libellePalier(d, securite) {
  return securite ? `palier de sécurité (${fmt(d)} m)` : `palier à ${fmt(d)} m`;
}

function simulerPlongee(Tinit, niveaux, gazFond, ctx, avecNdl) {
  const segs = [];
  const evts = [];
  let t = 0;
  let d = 0;
  let T = Tinit.slice();
  let g = gazFond;
  const ajouter = (type, d1, duree, extra = {}) => {
    if (!(duree > 1e-12)) return;
    const seg = { type, t0: t, t1: t + duree, d0: d, d1, gaz: g, tissus0: T, ...extra };
    T = avancer(T, d, d1, duree, g, ctx);
    t = seg.t1;
    d = d1;
    segs.push(seg);
  };
  const evt = (libelle, phase) => evts.push({ t, libelle, profondeur: d, phase, tissus: T, gaz: g });

  evt('Début de la plongée (état initial)', 'descente');
  let profMax = 0;
  let ndl = null;
  let ndlIllimite = false;
  const N = niveaux.length;
  niveaux.forEach((niv, i) => {
    const D = niv.profondeur;
    profMax = Math.max(profMax, D);
    let transit = 0;
    if (Math.abs(D - d) > 1e-9) {
      transit = Math.abs(D - d) / (D > d ? ctx.vD : ctx.vR);
      const type = i === 0 ? 'descente' : 'transition';
      ajouter(type, D, transit);
      evt(i === 0 ? 'Fin de descente' : `Arrivée au niveau ${i + 1} (${fmt(D)} m)`, type);
    }
    const auNiveau = Math.max(0, ctx.inclut ? niv.duree - transit : niv.duree);
    if (avecNdl && i === N - 1) ({ ndl, illimite: ndlIllimite } = calculerNdl(T, D, g, ctx));
    ajouter('fond', D, auNiveau, { niveau: i + 1, multi: N > 1 });
    const fin = N > 1 ? `Fin du niveau ${i + 1} (${fmt(D)} m)` : 'Fin du fond';
    evt(i === N - 1 ? `${fin} — début de la remontée` : fin, 'fond');
  });

  const tDebutRemontee = t;
  const plan = planRemontee(T, d, g, ctx, profMax);
  const paliers = [];
  let tArriveeF = null;
  for (const s of plan.segs) {
    if (s.gaz !== g) {
      g = s.gaz;
      evt(`Bascule sur ${g.nom} à ${fmt(d)} m`, s.type);
    }
    if (s.type === 'palier') {
      const premier = !s.securite && tArriveeF === null;
      if (premier) tArriveeF = t;
      const lib = libellePalier(d, s.securite);
      evt(premier ? `Arrivée au 1er palier — début du ${lib}` : `Début du ${lib}`, 'palier');
      paliers.push({ profondeur: d, duree: s.duree, debut: t, gaz: g.nom, securite: s.securite });
      ajouter('palier', d, s.duree, { securite: s.securite });
      evt(`Fin du ${lib}`, 'palier');
    } else {
      ajouter('remontee', s.d1, s.duree);
    }
  }
  evt('Sortie', 'surface');
  return {
    segs,
    evts,
    tissus: T,
    t0: 0,
    tSortie: t,
    tDebutRemontee,
    profMax,
    paliers,
    deco: plan.deco,
    F: plan.F,
    tArriveeF,
    ndl,
    ndlIllimite,
  };
}

function decaler(sim, dt) {
  for (const s of sim.segs) {
    s.t0 += dt;
    s.t1 += dt;
  }
  for (const e of sim.evts) e.t += dt;
  for (const p of sim.paliers) p.debut += dt;
  sim.t0 += dt;
  sim.tSortie += dt;
  sim.tDebutRemontee += dt;
  if (sim.tArriveeF !== null) sim.tArriveeF += dt;
}

function oxygeneSegments(segs, ctx) {
  let cns = 0;
  let otu = 0;
  for (const s of segs) {
    const ex = expositionOxygene(ctx.pamb(s.d0) * s.gaz.o2, ctx.pamb(s.d1) * s.gaz.o2, s.t1 - s.t0);
    cns += ex.cns;
    otu += ex.otu;
  }
  return { cns, otu };
}

function libellePhase(s) {
  switch (s.type) {
    case 'descente':
      return `Descente vers ${fmt(s.d1)} m`;
    case 'transition':
      return `Transition vers ${fmt(s.d1)} m`;
    case 'fond':
      return s.multi ? `Niveau ${s.niveau} à ${fmt(s.d0)} m` : `Fond à ${fmt(s.d0)} m`;
    case 'remontee':
      return s.d1 > 1e-9 ? `Remontée vers ${fmt(s.d1)} m` : 'Remontée vers la surface';
    case 'palier':
      return majuscule(libellePalier(s.d0, s.securite));
    default:
      return 'Surface';
  }
}

function construirePhases(segs) {
  const out = [];
  for (const s of segs) {
    const der = out[out.length - 1];
    if (der && s.type === 'remontee' && der.type === 'remontee' && der.gaz === s.gaz.nom) {
      der.fin = arr(s.t1, 3);
      der.profFin = arr(s.d1, 2);
      der.libelle = libellePhase(s);
      continue;
    }
    const ph = {
      type: s.type,
      debut: arr(s.t0, 3),
      fin: arr(s.t1, 3),
      profDebut: arr(s.d0, 2),
      profFin: arr(s.d1, 2),
      gaz: s.gaz.nom,
      libelle: libellePhase(s),
    };
    if (s.type === 'palier') ph.securite = Boolean(s.securite);
    out.push(ph);
  }
  return out;
}

/** Instants (min, exclus 0) espacés logarithmiquement sur [0, duree] : τ = c (e^u − 1). */
function instantsSurface(duree, n, avecFin) {
  const c = 10;
  const umax = Math.log(1 + duree / c);
  const res = [];
  const jmax = avecFin ? n : n - 1;
  for (let j = 1; j <= jmax; j++) res.push(c * (Math.exp((umax * j) / n) - 1));
  if (avecFin && res.length) res[res.length - 1] = duree;
  return res;
}

// ───────────────────────────── calcul complet ─────────────────────────────

function calculer(p) {
  const ctx = contexte(p);
  const alertes = [];
  const alerte = (niveau, message) => alertes.push({ niveau, message });
  const gazFond = gazDe(p.gaz.o2);

  // État initial des tissus (équilibre à l'altitude, ou acclimatation incomplète).
  let T = new Array(NB).fill(ctx.eqN2);
  if (p.acclimatation) {
    const a = p.acclimatation;
    const pOrig = pressionAltitude(a.altitudeOrigine);
    const T0 = new Array(NB).fill(equilibreN2(pOrig));
    const minutes = a.heuresDepuisArrivee * 60;
    T = haldaneTous(T0, ctx.eqN2, minutes);
    if (pOrig > ctx.psurf + 1e-6) {
      const besoin = tempsDesaturation(T0, ctx.psurf, ctx.seuil);
      if (minutes < besoin) {
        alerte(
          'attention',
          `Acclimatation incomplète : arrivée depuis ${fmtDuree(minutes)}, il faudrait environ ${fmtDuree(besoin)} ` +
            `pour que les tissus soient à l'équilibre à cette altitude. L'azote excédentaire est pris en compte ; ` +
            `beaucoup d'organismes recommandent d'attendre 12 à 24 h avant de plonger en altitude.`,
        );
      } else {
        alerte('info', "Acclimatation : les tissus sont considérés à l'équilibre à l'altitude de plongée.");
      }
    } else {
      alerte('info', "Acclimatation : lieu d'origine plus élevé que le site de plongée, pas d'azote excédentaire.");
    }
  }

  const segments = [];
  const evenements = [];
  const plongees = [];
  let cnsResiduel = 0;
  let otuPrecedente = 0;
  let precedente = null;
  if (p.plongeePrecedente) {
    const pp = p.plongeePrecedente;
    const simP = simulerPlongee(T, pp.niveaux, gazDe(pp.gaz.o2), ctx, false);
    decaler(simP, -(simP.tSortie + pp.intervalle));
    segments.push(...simP.segs);
    const debutP = simP.evts[0];
    const sortieP = simP.evts[simP.evts.length - 1];
    evenements.push(
      { ...debutP, libelle: 'Plongée précédente — début' },
      { ...sortieP, libelle: 'Plongée précédente — sortie' },
    );
    plongees.push(simP);
    const ox = oxygeneSegments(simP.segs, ctx);
    cnsResiduel = decroissanceCNS(ox.cns, pp.intervalle);
    otuPrecedente = ox.otu;
    if (pp.intervalle > 0) {
      segments.push({ type: 'surface', t0: simP.tSortie, t1: 0, d0: 0, d1: 0, gaz: AIR, tissus0: simP.tissus, intervalle: true });
    }
    T = haldaneTous(simP.tissus, ctx.eqN2, pp.intervalle);
    precedente = {
      debut: arr(simP.t0, 3),
      sortie: arr(simP.tSortie, 3),
      intervalle: pp.intervalle,
      profondeurMax: simP.profMax,
      paliersObligatoires: simP.deco,
      paliers: simP.paliers.map((x) => ({ ...x, debut: arr(x.debut, 3) })),
      phases: construirePhases(simP.segs),
      cns: arr(ox.cns, 1),
      otu: Math.round(ox.otu),
    };
    const reste = tempsDesaturation(T, ctx.psurf, ctx.seuil);
    if (reste > 0) {
      alerte(
        'info',
        `Plongée successive : azote résiduel de la plongée précédente (désaturation incomplète, encore ${fmtDuree(reste)} ` +
          `nécessaires au moment de l'immersion) ; il est pris en compte.`,
      );
    }
    if (pp.intervalle < 10)
      alerte('attention', "Intervalle de surface inférieur à 10 min : beaucoup de procédures le traitent comme une seule plongée.");
  }

  // Plongée courante.
  const sim = simulerPlongee(T, p.niveaux, gazFond, ctx, true);
  segments.push(...sim.segs);
  evenements.push(...sim.evts);
  plongees.push(sim);

  // Surface après la sortie (Haldane exact).
  const desatBrute = tempsDesaturation(sim.tissus, ctx.psurf, ctx.seuil);
  const desatPlafonnee = desatBrute > DESAT_MAX;
  const desat = Math.min(desatBrute, DESAT_MAX);
  const avion = tempsAvion(sim.tissus, ctx.psurf, ctx.gfHaut);
  const dureeSurface = Math.min(DESAT_MAX, Math.max(desat, 60));
  segments.push({
    type: 'surface',
    t0: sim.tSortie,
    t1: sim.tSortie + dureeSurface,
    d0: 0,
    d1: 0,
    gaz: AIR,
    tissus0: sim.tissus,
    finale: true,
  });

  // GF « courant » : GF haut hors déco ; GF bas jusqu'au 1er palier puis interpolé en déco.
  const gfCourant = (t, d) => {
    for (const pl of plongees) {
      if (t >= pl.t0 - 1e-9 && t <= pl.tSortie + 1e-9) {
        if (!pl.deco) return ctx.gfHaut;
        if (pl.tArriveeF === null || t < pl.tArriveeF - 1e-9) return ctx.gfBas;
        return gfInterpole(d, pl.F, ctx.gfBas, ctx.gfHaut);
      }
    }
    return ctx.gfHaut;
  };

  const point = (t, d, tissus, g, phase) => {
    const pamb = ctx.pamb(d);
    const gf = gfCourant(t, d);
    const { pctMAmb, pctMSurf, pctGF } = pourcentages(tissus, pamb, ctx.psurf);
    const { pression, directeur } = plafondGlobal(tissus, gf);
    return {
      t: arr(t, 3),
      profondeur: arr(d, 2),
      pamb: arr(pamb, 4),
      phase,
      pN2: tissus.map((x) => arr(x, 4)),
      pctMAmb: pctMAmb.map((x) => arr(x, 1)),
      pctMSurf: pctMSurf.map((x) => arr(x, 1)),
      pctGF: pctGF.map((x) => arr(x, 1)),
      plafond: arr(Math.max(0, ctx.prof(pression)), 2),
      directeur,
      ppo2: arr(pamb * g.o2, 3),
      gaz: g.nom,
      gf: Math.round(gf * 100),
    };
  };

  const etat = (s, t) => {
    const dt = Math.max(0, t - s.t0);
    if (s.type === 'surface') return { d: 0, tissus: haldaneTous(s.tissus0, ctx.eqN2, dt) };
    const dur = s.t1 - s.t0;
    const d = s.d0 + (s.d1 - s.d0) * (dur > 0 ? dt / dur : 0);
    return { d, tissus: dt > 0 ? avancer(s.tissus0, s.d0, d, dt, s.gaz, ctx) : s.tissus0 };
  };

  // Échantillons : pas fixe sous l'eau (≤ 0,25 min si le budget le permet), logarithmique en surface.
  const sousEau = segments.filter((s) => s.type !== 'surface');
  const dureeSousEau = sousEau.reduce((a, s) => a + (s.t1 - s.t0), 0);
  const nbSurf = 300;
  const nbIntervalle = 150;
  const budget = MAX_ECHANTILLONS - nbSurf - (p.plongeePrecedente ? nbIntervalle : 0) - sousEau.length - 40;
  const pas = Math.max(0.25, dureeSousEau / budget);
  const clesSurface = [...HEURES_SURFACE, desat, avion].filter((x) => x > 0 && x < dureeSurface);
  const echantillons = [];
  for (const s of segments) {
    const dur = s.t1 - s.t0;
    let instants;
    if (s.type === 'surface') {
      const base = [0, ...instantsSurface(dur, s.finale ? nbSurf : nbIntervalle, Boolean(s.finale))];
      if (s.finale) base.push(...clesSurface);
      base.sort((a, b) => a - b);
      instants = base.filter((x, i) => i === 0 || x - base[i - 1] > 1e-6).map((x) => s.t0 + x);
    } else {
      const n = Math.max(1, Math.ceil(dur / pas - 1e-9));
      instants = Array.from({ length: n }, (_, j) => s.t0 + (dur * j) / n);
    }
    for (const t of instants) {
      const { d, tissus } = etat(s, t);
      echantillons.push(point(t, d, tissus, s.gaz, s.type));
    }
  }
  if (echantillons.length > MAX_ECHANTILLONS) {
    // Garde-fou (ne devrait pas arriver) : décimation régulière.
    const r = echantillons.length / MAX_ECHANTILLONS;
    const garde = Array.from({ length: MAX_ECHANTILLONS }, (_, i) => echantillons[Math.min(echantillons.length - 1, Math.round(i * r))]);
    garde[garde.length - 1] = echantillons[echantillons.length - 1];
    echantillons.length = 0;
    echantillons.push(...garde);
  }

  // Tableau des instants clés.
  const tableau = evenements.map((e) => ({ libelle: e.libelle, ...point(e.t, e.profondeur, e.tissus, e.gaz, e.phase) }));
  const surfaceA = (tau, libelle) => {
    const tissus = haldaneTous(sim.tissus, ctx.eqN2, tau);
    tableau.push({ libelle, ...point(sim.tSortie + tau, 0, tissus, AIR, 'surface') });
  };
  for (const h of HEURES_SURFACE) {
    if (h < desat - 1e-9) surfaceA(h, `Surface +${h < 60 ? `${h} min` : `${h / 60} h`}`);
  }
  if (desatPlafonnee) surfaceA(DESAT_MAX, 'Fin de simulation à 96 h (désaturation incomplète)');
  else surfaceA(desat, desat > 0 ? `Désaturation complète (+${fmtDuree(desat)})` : 'Désaturation complète (dès la sortie)');
  tableau.sort((a, b) => a.t - b.t);

  // Oxygène.
  const ox = oxygeneSegments(sim.segs, ctx);
  const cns = ox.cns + cnsResiduel;
  const otu = ox.otu + otuPrecedente;

  // Consommation.
  let consommation = null;
  if (p.consommation) {
    const b = bilanConsommation(
      sim.segs.map((s) => ({
        type: s.type,
        pambDebut: ctx.pamb(s.d0),
        pambFin: ctx.pamb(s.d1),
        duree: s.t1 - s.t0,
        gaz: s.gaz,
      })),
      p.consommation,
      p.gazDeco,
    );
    consommation = {
      litres: Math.round(b.litres),
      litresFond: Math.round(b.litresFond),
      pressionRestante: Math.round(b.pressionRestante),
      reserveEntamee: b.reserveEntamee,
      parPhase: b.parPhase.map((x) => ({ type: x.type, litres: Math.round(x.litres) })),
      parGaz: b.parGaz.map((x) => ({
        ...x,
        litres: Math.round(x.litres),
        pressionRestante: x.pressionRestante === null ? null : Math.round(x.pressionRestante),
      })),
    };
    if (b.pressionRestante < 0)
      alerte('danger', `Consommation : la bouteille serait vide avant la sortie (il manque ${fmt(-b.pressionRestante, 0)} bar).`);
    else if (b.reserveEntamee)
      alerte(
        'danger',
        `Consommation : réserve entamée (pression restante estimée ${fmt(b.pressionRestante, 0)} bar < réserve de ${fmt(p.consommation.reserve, 0)} bar).`,
      );
    for (const g of b.parGaz) {
      if (g.indexDeco >= 0 && g.reserveEntamee)
        alerte('attention', `Consommation : réserve du ${g.gaz} entamée (${fmt(g.pressionRestante, 0)} bar restants).`);
    }
  }

  // Alertes de sécurité.
  const mod = profondeurMOD(p.gaz.o2, p.ppo2Max, ctx.psurf, ctx.eau);
  const ppMax = (types) => {
    let m = 0;
    let ou = null;
    for (const s of sim.segs) {
      if (!types.includes(s.type)) continue;
      for (const d of [s.d0, s.d1]) {
        const v = ctx.pamb(d) * s.gaz.o2;
        if (v > m) {
          m = v;
          ou = { d, gaz: s.gaz.nom };
        }
      }
    }
    return { m, ou };
  };
  const fond = ppMax(['descente', 'fond', 'transition']);
  if (fond.m > p.ppo2Max + 1e-9) {
    alerte(
      'danger',
      `PpO2 de ${fmt(fond.m, 2)} bar au fond (${fond.ou.gaz} à ${fmt(fond.ou.d)} m), au-delà de la limite de ${fmt(p.ppo2Max, 2)} bar : ` +
        `profondeur supérieure à la MOD ${duGaz(gazFond.nom)} (${fmt(mod)} m).`,
    );
  }
  const deco = ppMax(['remontee', 'palier']);
  if (deco.m > p.ppo2MaxDeco + TOLERANCE_BASCULE + 1e-9 && deco.m > fond.m + 1e-9) {
    alerte('danger', `PpO2 de ${fmt(deco.m, 2)} bar pendant la remontée (${deco.ou.gaz} à ${fmt(deco.ou.d)} m), au-delà de ${fmt(p.ppo2MaxDeco, 2)} bar.`);
  }
  // PpO2 basse : seulement pour un mélange autre que l'air (respirer de l'air en altitude est normal).
  let ppMin = Infinity;
  for (const s of sim.segs) {
    if (estAir(s.gaz.o2)) continue;
    for (const d of [s.d0, s.d1]) ppMin = Math.min(ppMin, ctx.pamb(d) * s.gaz.o2);
  }
  if (ppMin < 0.18 - 1e-9) {
    alerte('attention', `PpO2 inférieure à 0,18 bar près de la surface (${fmt(ppMin, 2)} bar) : risque d'hypoxie.`);
  }
  if (sim.profMax > 60) {
    alerte('danger', `Profondeur de ${fmt(sim.profMax)} m : au-delà de 60 m, hors des limites de la plongée à l'air ou au nitrox.`);
  } else if (sim.profMax > 40 && estAir(p.gaz.o2)) {
    alerte('attention', `Profondeur de ${fmt(sim.profMax)} m à l'air : au-delà de 40 m (limite usuelle de la plongée loisir, narcose marquée).`);
  }
  if (p.vitesseRemontee > 10) {
    alerte('attention', `Vitesse de remontée de ${fmt(p.vitesseRemontee)} m/min : au-delà des 10 m/min usuels (hors normes).`);
  }
  p.gazDeco.forEach((g, i) => {
    const nom = nomGaz(g.o2);
    if (g.o2 <= p.gaz.o2 + 1e-9) {
      alerte('info', `Gaz de déco ${i + 1} (${nom}) pas plus riche en oxygène que le gaz fond : il ne sera pas utilisé.`);
      return;
    }
    const modDeco = profondeurMOD(g.o2, p.ppo2MaxDeco, ctx.psurf, ctx.eau);
    const modTolere = profondeurMOD(g.o2, p.ppo2MaxDeco + TOLERANCE_BASCULE, ctx.psurf, ctx.eau);
    if (g.profondeurBascule > modTolere + 1e-9) {
      alerte(
        'attention',
        `Gaz de déco ${i + 1} (${nom}) : bascule prévue à ${fmt(g.profondeurBascule)} m, au-delà de sa MOD ` +
          `(${fmt(modDeco)} m à ${fmt(p.ppo2MaxDeco, 2)} bar) ; la bascule est retardée.`,
      );
    }
  });
  if (sim.deco) {
    alerte('info', `Plongée avec paliers obligatoires (1er palier à ${fmt(sim.F)} m).`);
  }
  if (p.altitude > 300) {
    alerte(
      'info',
      `Plongée en altitude (${fmt(p.altitude, 0)} m) : pression de surface ${fmt(ctx.psurf, 3)} bar, ` +
        `paliers calculés pour cette pression.`,
    );
  }
  // Plafond franchi pendant le fond (multiniveaux remontant trop vite, par exemple).
  const viol = echantillons.find(
    (e) => e.t >= 0 && ['descente', 'fond', 'transition'].includes(e.phase) && e.plafond > e.profondeur + 0.1,
  );
  if (viol) {
    alerte('danger', `Plafond de décompression franchi pendant la plongée (à ${fmt(viol.t)} min, plafond ${fmt(viol.plafond)} m pour ${fmt(viol.profondeur)} m).`);
  }
  if (cns > 100) alerte('danger', `Toxicité de l'oxygène : CNS de ${fmt(cns, 0)} % (> 100 %).`);
  else if (cns > 80) alerte('attention', `Toxicité de l'oxygène : CNS de ${fmt(cns, 0)} % (> 80 %).`);
  if (otu > 300) alerte('attention', `Toxicité pulmonaire : ${fmt(otu, 0)} OTU (> 300 par jour).`);
  if (desatPlafonnee) alerte('attention', 'Désaturation incomplète après 96 h de simulation.');
  alerte(
    'info',
    `Avion / montée en altitude : délai calculé ${fmtDuree(avion)} (cabine ${fmt(PRESSION_CABINE, 2)} bar), indicatif. ` +
      'Règle usuelle : 12 h après une plongée unique sans palier, 24 h après des plongées successives ou avec paliers.',
  );

  return {
    ok: true,
    erreurs: [],
    alertes,
    psurf: arr(ctx.psurf, 4),
    compartiments: COMPARTIMENTS_ZHL16C.map((c) => ({ ...c })),
    phases: [
      ...construirePhases(sim.segs),
      {
        type: 'surface',
        debut: arr(sim.tSortie, 3),
        fin: arr(sim.tSortie + desat, 3),
        profDebut: 0,
        profFin: 0,
        gaz: 'Air',
        libelle: 'Surface — désaturation',
      },
    ],
    paliers: sim.paliers.map((x) => ({ ...x, debut: arr(x.debut, 3) })),
    echantillons,
    tableau,
    resume: {
      dureeTotale: arr(sim.tSortie, 1),
      dtr: arr(sim.tSortie - sim.tDebutRemontee, 1),
      profondeurMax: sim.profMax,
      tempsFond: arr(sim.tDebutRemontee, 1),
      ndl: sim.ndl,
      ndlIllimite: sim.ndlIllimite,
      paliersObligatoires: sim.deco,
      premierPalier: sim.deco ? sim.F : null,
      desaturation: Math.ceil(desat - 1e-9),
      desaturationPlafonnee: desatPlafonnee,
      avion: Math.ceil(avion - 1e-9),
      cns: arr(cns, 1),
      cnsResiduel: arr(cnsResiduel, 1),
      otu: Math.round(otu),
      mod: arr(mod, 1),
      gaz: gazFond.nom,
      consommation,
    },
    plongeePrecedente: precedente,
  };
}

/**
 * Planifie une plongée (voir SPEC.md pour le contrat complet).
 * @param {object} params paramètres (les champs absents prennent la valeur de PARAMETRES_DEFAUT)
 * @returns {object} résultat ; `ok: false` et `erreurs` non vide si les paramètres sont invalides
 */
export function planifier(params) {
  const p = normaliser(params);
  const erreurs = valider(p);
  const psurf = fini(p.altitude) ? arr(pressionAltitude(p.altitude), 4) : null;
  const echec = (msgs) => ({
    ok: false,
    erreurs: msgs,
    alertes: [],
    psurf,
    compartiments: COMPARTIMENTS_ZHL16C.map((c) => ({ ...c })),
    phases: [],
    paliers: [],
    echantillons: [],
    tableau: [],
    resume: null,
    plongeePrecedente: null,
  });
  if (erreurs.length) return echec(erreurs);
  try {
    return calculer(p);
  } catch (e) {
    if (e instanceof ErreurPlan) return echec([e.message]);
    throw e;
  }
}
