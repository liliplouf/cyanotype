// formulaire.js — État brut du formulaire ↔ paramètres du moteur, validation en français.
// Fonctions pures, sans DOM : l'état brut est un objet de chaînes / booléens (tel que mémorisé
// en localStorage), `construireParams` le convertit en `params` pour planifier() et renvoie
// les erreurs de saisie rattachées à leur champ.

export const PRESETS_GF = [
  { id: '100/100', bas: 100, haut: 100, libelle: '100/100 — Bühlmann pur' },
  { id: '50/80', bas: 50, haut: 80, libelle: '50/80' },
  { id: '40/85', bas: 40, haut: 85, libelle: '40/85 — usuel' },
  { id: '35/75', bas: 35, haut: 75, libelle: '35/75' },
  { id: '30/70', bas: 30, haut: 70, libelle: '30/70 — prudent' },
  { id: '20/60', bas: 20, haut: 60, libelle: '20/60 — très prudent' },
];

/** État brut par défaut (valeurs affichées dans les champs). */
export const ETAT_DEFAUT = Object.freeze({
  niveaux: [{ profondeur: '30', duree: '20' }],
  gazType: 'air',
  o2: '32',
  altitude: '0',
  eau: 'mer',
  conso: { volume: '', pression: '', reserve: '50', sac: '' },
  gfPreset: '40/85',
  gfBas: '40',
  gfHaut: '85',
  vitesseDescente: '20',
  vitesseRemontee: '10',
  securiteActif: true,
  securiteProfondeur: '5',
  securiteDuree: '3',
  lastStopDepth: '3',
  dureeInclutDescente: true,
  gazDeco: [],
  ppo2Max: '1.4',
  ppo2MaxDeco: '1.6',
  successive: false,
  precProfondeur: '20',
  precDuree: '30',
  precO2: '21',
  intervalle: '120',
  acclim: false,
  altitudeOrigine: '0',
  heuresDepuisArrivee: '2',
  desatSeuil: '2',
});

/** Copie profonde de l'état par défaut. */
export function etatDefaut() {
  return JSON.parse(JSON.stringify(ETAT_DEFAUT));
}

/**
 * Fusionne un état mémorisé (peut-être ancien ou corrompu) avec l'état par défaut :
 * seules les clés connues, du bon type, sont reprises.
 */
export function fusionnerEtat(sauve) {
  const e = etatDefaut();
  if (!sauve || typeof sauve !== 'object' || Array.isArray(sauve)) return e;
  for (const [k, def] of Object.entries(e)) {
    const v = sauve[k];
    if (v === undefined || v === null) continue;
    if (k === 'niveaux' || k === 'gazDeco') {
      if (!Array.isArray(v)) continue;
      const lignes = v
        .filter((l) => l && typeof l === 'object')
        .slice(0, k === 'niveaux' ? 8 : 3)
        .map((l) => (k === 'niveaux'
          ? { profondeur: String(l.profondeur ?? ''), duree: String(l.duree ?? '') }
          : { o2: String(l.o2 ?? ''), profondeur: String(l.profondeur ?? '') }));
      if (k === 'gazDeco' || lignes.length) e[k] = lignes;
    } else if (k === 'conso') {
      if (typeof v !== 'object') continue;
      for (const c of Object.keys(def)) if (v[c] !== undefined && v[c] !== null) e.conso[c] = String(v[c]);
    } else if (typeof def === 'boolean') {
      if (typeof v === 'boolean') e[k] = v;
    } else if (typeof v === 'string' || typeof v === 'number') {
      e[k] = String(v);
    }
  }
  return e;
}

/**
 * Lit un nombre saisi en français (virgule ou point décimal, espaces tolérés).
 * @returns {number|null} null si vide, NaN si illisible
 */
export function lireNombre(s) {
  if (typeof s === 'number') return Number.isFinite(s) ? s : NaN;
  if (s === undefined || s === null) return null;
  const t = String(s).replace(/[\s  ]/g, '').replace(',', '.');
  if (t === '') return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

/** Préréglage GF correspondant à un couple bas/haut, ou 'perso'. */
export function presetPourGF(bas, haut) {
  const p = PRESETS_GF.find((x) => x.bas === Number(bas) && x.haut === Number(haut));
  return p ? p.id : 'perso';
}

/**
 * Profondeur maximale d'utilisation (m, eau de mer, au niveau de la mer par défaut),
 * arrondie au multiple de `pas` inférieur : utile pour proposer une profondeur de bascule.
 */
export function profondeurMOD(o2, ppo2, { psurf = 1.01325, eau = 'mer', pas = 3 } = {}) {
  if (!(o2 > 0) || !(ppo2 > 0)) return null;
  const rho = eau === 'douce' ? 1.0 : 1.025;
  const prof = ((ppo2 / o2 - psurf) * 100) / (rho * 9.80665);
  if (prof <= 0) return 0;
  return pas ? Math.floor(prof / pas + 1e-9) * pas : prof;
}

/**
 * Convertit l'état brut en paramètres moteur et valide.
 * @param {object} etat état brut (voir ETAT_DEFAUT)
 * @returns {{ params: object|null, erreurs: { champ: string, message: string }[] }}
 */
export function construireParams(etat) {
  const e = fusionnerEtat(etat);
  const erreurs = [];
  const err = (champ, message) => erreurs.push({ champ, message });

  /** Lit et contrôle un nombre ; renvoie la valeur ou null (vide) / undefined (erreur). */
  const nombre = (champ, brut, { min, max, requis = true, entier = false, nom }) => {
    const v = lireNombre(brut);
    if (v === null) {
      if (requis) err(champ, `${nom} : valeur obligatoire.`);
      return requis ? undefined : null;
    }
    if (Number.isNaN(v)) { err(champ, `${nom} : nombre attendu (ex. 12 ou 12,5).`); return undefined; }
    if (entier && !Number.isInteger(v)) { err(champ, `${nom} : nombre entier attendu.`); return undefined; }
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      err(champ, `${nom} : entre ${String(min).replace('.', ',')} et ${String(max).replace('.', ',')}.`);
      return undefined;
    }
    return v;
  };

  // Niveaux
  const niveaux = [];
  if (!e.niveaux.length) err('niveaux', 'Ajoutez au moins un niveau.');
  e.niveaux.forEach((l, i) => {
    const profondeur = nombre(`niveaux.${i}.profondeur`, l.profondeur, { min: 1, max: 100, nom: `Niveau ${i + 1}, profondeur (m)` });
    const duree = nombre(`niveaux.${i}.duree`, l.duree, { min: 1, max: 300, nom: `Niveau ${i + 1}, durée (min)` });
    if (profondeur !== undefined && duree !== undefined) niveaux.push({ profondeur, duree });
  });

  // Gaz fond
  let o2 = 0.21;
  if (e.gazType === 'nitrox') {
    const pct = nombre('o2', e.o2, { min: 22, max: 100, nom: 'Oxygène du nitrox (%)' });
    if (pct !== undefined) o2 = pct / 100;
  }

  const altitude = nombre('altitude', e.altitude, { min: 0, max: 5000, nom: 'Altitude (m)' });

  // Consommation (facultative : bloc entier ou rien)
  let consommation = null;
  const c = e.conso;
  const remplis = ['volume', 'pression', 'sac'].filter((k) => lireNombre(c[k]) !== null);
  if (remplis.length) {
    const volume = nombre('conso.volume', c.volume, { min: 1, max: 50, nom: 'Volume de la bouteille (L)' });
    const pression = nombre('conso.pression', c.pression, { min: 50, max: 350, nom: 'Pression de gonflage (bar)' });
    const sac = nombre('conso.sac', c.sac, { min: 5, max: 60, nom: 'Consommation (L/min)' });
    const reserve = nombre('conso.reserve', c.reserve, { min: 0, max: 200, requis: false, nom: 'Réserve (bar)' });
    if (pression !== undefined && reserve !== undefined && reserve !== null && reserve >= pression) {
      err('conso.reserve', 'Réserve (bar) : doit être inférieure à la pression de gonflage.');
    } else if ([volume, pression, sac, reserve].every((v) => v !== undefined)) {
      consommation = { sac, volume, pression, reserve: reserve ?? 50 };
    }
  }

  // Facteurs de gradient
  const gfBas = nombre('gfBas', e.gfBas, { min: 5, max: 100, entier: true, nom: 'GF bas (%)' });
  const gfHaut = nombre('gfHaut', e.gfHaut, { min: 10, max: 100, entier: true, nom: 'GF haut (%)' });
  if (gfBas !== undefined && gfHaut !== undefined && gfBas > gfHaut) err('gfBas', 'GF bas (%) : doit être inférieur ou égal au GF haut.');

  const vitesseDescente = nombre('vitesseDescente', e.vitesseDescente, { min: 5, max: 40, nom: 'Vitesse de descente (m/min)' });
  const vitesseRemontee = nombre('vitesseRemontee', e.vitesseRemontee, { min: 3, max: 18, nom: 'Vitesse de remontée (m/min)' });

  let safetyStop = { actif: false, profondeur: 5, duree: 3 };
  if (e.securiteActif) {
    const profondeur = nombre('securiteProfondeur', e.securiteProfondeur, { min: 3, max: 6, nom: 'Palier de sécurité, profondeur (m)' });
    const duree = nombre('securiteDuree', e.securiteDuree, { min: 1, max: 10, nom: 'Palier de sécurité, durée (min)' });
    safetyStop = { actif: true, profondeur: profondeur ?? 5, duree: duree ?? 3 };
  }

  const lastStopDepth = e.lastStopDepth === '6' ? 6 : 3;
  const ppo2Max = nombre('ppo2Max', e.ppo2Max, { min: 1.0, max: 1.6, nom: 'PpO2 max au fond (bar)' });
  const ppo2MaxDeco = nombre('ppo2MaxDeco', e.ppo2MaxDeco, { min: 1.0, max: 1.6, nom: 'PpO2 max aux paliers (bar)' });

  const gazDeco = [];
  e.gazDeco.forEach((g, i) => {
    const pct = nombre(`gazDeco.${i}.o2`, g.o2, { min: 22, max: 100, nom: `Gaz de déco ${i + 1}, oxygène (%)` });
    const prof = nombre(`gazDeco.${i}.profondeur`, g.profondeur, { min: 3, max: 60, nom: `Gaz de déco ${i + 1}, profondeur de bascule (m)` });
    if (pct !== undefined && prof !== undefined) gazDeco.push({ o2: pct / 100, profondeurBascule: prof });
  });

  let plongeePrecedente = null;
  if (e.successive) {
    const profondeur = nombre('precProfondeur', e.precProfondeur, { min: 1, max: 100, nom: 'Plongée précédente, profondeur (m)' });
    const duree = nombre('precDuree', e.precDuree, { min: 1, max: 300, nom: 'Plongée précédente, durée (min)' });
    const pct = nombre('precO2', e.precO2, { min: 21, max: 100, nom: 'Plongée précédente, oxygène (%)' });
    const intervalle = nombre('intervalle', e.intervalle, { min: 1, max: 2880, nom: 'Intervalle de surface (min)' });
    if ([profondeur, duree, pct, intervalle].every((v) => v !== undefined)) {
      plongeePrecedente = { niveaux: [{ profondeur, duree }], gaz: { o2: pct / 100 }, intervalle };
    }
  }

  let acclimatation = null;
  if (e.acclim) {
    const altitudeOrigine = nombre('altitudeOrigine', e.altitudeOrigine, { min: 0, max: 5000, nom: 'Altitude d’origine (m)' });
    const heuresDepuisArrivee = nombre('heuresDepuisArrivee', e.heuresDepuisArrivee, { min: 0, max: 96, nom: 'Heures depuis l’arrivée' });
    if (altitudeOrigine !== undefined && heuresDepuisArrivee !== undefined) acclimatation = { altitudeOrigine, heuresDepuisArrivee };
  }

  const seuil = nombre('desatSeuil', e.desatSeuil, { min: 0.5, max: 10, nom: 'Seuil de désaturation (%)' });

  if (erreurs.length) return { params: null, erreurs };
  return {
    erreurs,
    params: {
      niveaux,
      dureeInclutDescente: !!e.dureeInclutDescente,
      gaz: { o2 },
      gazDeco,
      altitude,
      eau: e.eau === 'douce' ? 'douce' : 'mer',
      vitesseDescente,
      vitesseRemontee,
      gfBas,
      gfHaut,
      stopIncrement: 3,
      lastStopDepth,
      safetyStop,
      ppo2Max,
      ppo2MaxDeco,
      desatThreshold: seuil / 100,
      plongeePrecedente,
      acclimatation,
      consommation,
    },
  };
}
