// moteur-factice.js — Faux moteur pour développer et tester l'interface (agent Interface).
// Expose la même API que planificateur.js (`planifier`, `PARAMETRES_DEFAUT`) et renvoie une
// structure conforme au contrat de SPEC.md. Les calculs sont volontairement simplifiés
// (Haldane par petits pas, algorithme de paliers rudimentaire) : NE PAS UTILISER pour plonger.
// Activé dans l'interface par le paramètre d'URL ?factice=1.

const PH2O = 0.0627;
const FN2_AIR = 0.7902;
const DEMI_VIES = [4, 8, 12.5, 18.5, 27, 38.3, 54.3, 77, 109, 146, 187, 239, 305, 390, 498, 635];
const A = [1.2599, 1.0, 0.8618, 0.7562, 0.62, 0.5043, 0.441, 0.4, 0.375, 0.35, 0.3295, 0.3065, 0.2835, 0.261, 0.248, 0.2327];
const B = [0.505, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.891, 0.9092, 0.9222, 0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653];
const COMPARTIMENTS = DEMI_VIES.map((demiVie, i) => ({ n: i + 1, demiVie, a: A[i], b: B[i] }));

export const PARAMETRES_DEFAUT = Object.freeze({
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
});

const pressionAltitude = (h) => 1.01325 * Math.pow(1 - 2.25577e-5 * h, 5.25588);
const nomGaz = (o2) => (Math.abs(o2 - 0.21) < 0.005 ? 'Air' : Math.abs(o2 - 1) < 0.005 ? 'O2' : `EAN${Math.round(o2 * 100)}`);
const arr = (x) => Math.round(x * 1000) / 1000;

export function planifier(entree = {}) {
  const p = { ...PARAMETRES_DEFAUT, ...entree };
  const erreurs = [];
  if (!Array.isArray(p.niveaux) || !p.niveaux.length) erreurs.push('Indiquez au moins un niveau (profondeur et durée).');
  else p.niveaux.forEach((n, i) => {
    if (!(n.profondeur > 0 && n.profondeur <= 120)) erreurs.push(`Niveau ${i + 1} : profondeur invalide.`);
    if (!(n.duree > 0)) erreurs.push(`Niveau ${i + 1} : durée invalide.`);
  });
  if (!(p.altitude >= 0 && p.altitude <= 5000)) erreurs.push('Altitude invalide (0 à 5 000 m).');
  if (erreurs.length) return { ok: false, erreurs, alertes: [] };

  const rho = p.eau === 'douce' ? 1.0 : 1.025;
  const psurf = pressionAltitude(p.altitude);
  const pamb = (prof) => psurf + (prof * rho * 9.80665) / 100;
  const profDe = (pa) => Math.max(0, ((pa - psurf) * 100) / (rho * 9.80665));
  const eqSurf = (psurf - PH2O) * FN2_AIR;
  const alertes = [];

  // État initial (acclimatation incomplète : tissus encore chargés de l'altitude d'origine).
  let tissus = new Array(16).fill(eqSurf);
  if (p.acclimatation) {
    const p0 = (pressionAltitude(p.acclimatation.altitudeOrigine || 0) - PH2O) * FN2_AIR;
    const min = (p.acclimatation.heuresDepuisArrivee || 0) * 60;
    tissus = tissus.map((_, i) => eqSurf + (p0 - eqSurf) * Math.pow(2, -min / DEMI_VIES[i]));
    alertes.push({ niveau: 'info', message: 'Acclimatation incomplète prise en compte (moteur factice).' });
  }

  const echantillons = [];
  const tableau = [];
  const phases = [];
  const paliers = [];
  let t = 0;
  let prof = 0;
  let gfCourant = p.gfHaut / 100;
  let cns = 0;
  let otu = 0;

  const charger = (pi, dt) => {
    tissus = tissus.map((pt, i) => pt + (pi - pt) * (1 - Math.pow(2, -dt / DEMI_VIES[i])));
  };
  const plafondGF = (gf) => {
    let pmax = 0;
    tissus.forEach((pt, i) => {
      const tol = (pt - A[i] * gf) / (gf / B[i] + 1 - gf);
      if (tol > pmax) pmax = tol;
    });
    return profDe(pmax);
  };
  const etat = (phase, fo2) => {
    const pa = pamb(prof);
    const pN2 = tissus.map(arr);
    const pctMAmb = tissus.map((pt, i) => arr((pt / (A[i] + pa / B[i])) * 100));
    const pctMSurf = tissus.map((pt, i) => arr((pt / (A[i] + psurf / B[i])) * 100));
    const pctGF = tissus.map((pt, i) => arr(((pt - pa) / (A[i] + pa / B[i] - pa)) * 100));
    let directeur = 1;
    let best = -Infinity;
    pctGF.forEach((v, i) => { if (v > best) { best = v; directeur = i + 1; } });
    return {
      t: arr(t), profondeur: arr(prof), pamb: arr(pa), phase, pN2, pctMAmb, pctMSurf, pctGF,
      plafond: arr(Math.max(0, plafondGF(gfCourant))), directeur, ppo2: arr(fo2 * pa),
    };
  };
  const ligne = (libelle, phase, fo2) => {
    const e = etat(phase, fo2);
    delete e.pamb; delete e.ppo2;
    tableau.push({ ...e, libelle });
  };
  const oxygene = (fo2, dt) => {
    const ppo2 = fo2 * pamb(prof);
    if (ppo2 > 0.5) {
      otu += dt * Math.pow((ppo2 - 0.5) / 0.5, 0.83);
      cns += (dt / (ppo2 >= 1.6 ? 45 : ppo2 >= 1.4 ? 150 : ppo2 >= 1.2 ? 210 : ppo2 >= 1.0 ? 300 : 570)) * 100;
    }
  };
  // Déplacement / séjour par petits pas.
  const segment = (profCible, duree, phase, fo2, pas = 0.25) => {
    const n = Math.max(1, Math.ceil(duree / pas));
    const dt = duree / n;
    const p0 = prof;
    for (let k = 1; k <= n; k++) {
      prof = p0 + ((profCible - p0) * k) / n;
      const pi = (pamb(prof) - PH2O) * (1 - fo2);
      charger(pi, dt);
      oxygene(fo2, dt);
      t += dt;
      echantillons.push(etat(phase, fo2));
    }
  };

  const simulerPlongee = (niveaux, fo2) => {
    const debut = t;
    const vitesseD = p.vitesseDescente;
    niveaux.forEach((niv, i) => {
      const dTrans = Math.abs(niv.profondeur - prof) / (niv.profondeur > prof ? vitesseD : p.vitesseRemontee);
      const type = i === 0 ? 'descente' : 'transition';
      const d0 = t;
      const pd = prof;
      segment(niv.profondeur, dTrans, type, fo2);
      phases.push({ type, debut: arr(d0), fin: arr(t), profDebut: pd, profFin: niv.profondeur, gaz: nomGaz(fo2),
        libelle: i === 0 ? `Descente vers ${niv.profondeur} m` : `Passage à ${niv.profondeur} m` });
      if (i === 0 && debut === 0) ligne('Fin de descente', 'descente', fo2);
      const resteFond = p.dureeInclutDescente ? Math.max(0, niv.duree - dTrans) : niv.duree;
      const f0 = t;
      segment(niv.profondeur, resteFond, 'fond', fo2);
      phases.push({ type: 'fond', debut: arr(f0), fin: arr(t), profDebut: niv.profondeur, profFin: niv.profondeur,
        gaz: nomGaz(fo2), libelle: `Fond à ${niv.profondeur} m` });
      if (debut === 0) ligne(`Fin du niveau ${niv.profondeur} m`, 'fond', fo2);
    });
  };

  // Plongée précédente (t négatifs) puis intervalle de surface.
  if (p.plongeePrecedente && Array.isArray(p.plongeePrecedente.niveaux) && p.plongeePrecedente.niveaux.length) {
    const prec = p.plongeePrecedente;
    const fo2p = prec.gaz?.o2 ?? 0.21;
    const dureePrec = prec.niveaux.reduce((s, n) => s + n.duree, 0) + prec.niveaux[prec.niveaux.length - 1].profondeur / p.vitesseRemontee + 3;
    t = -(dureePrec + (prec.intervalle || 0));
    const tDebutPrec = t;
    const bak = { echantillons: echantillons.length };
    simulerPlongee(prec.niveaux, fo2p);
    segment(0, prof / p.vitesseRemontee, 'remontee', fo2p);
    phases.push({ type: 'surface', debut: arr(tDebutPrec), fin: arr(t), profDebut: 0, profFin: 0, gaz: nomGaz(fo2p), libelle: 'Plongée précédente' });
    const interv = Math.max(0, -t);
    segment(0, interv, 'surface', 0.21, Math.max(1, interv / 60));
    phases.push({ type: 'surface', debut: arr(t - interv), fin: 0, profDebut: 0, profFin: 0, gaz: 'Air', libelle: 'Intervalle de surface' });
    t = 0;
    void bak;
    alertes.push({ niveau: 'info', message: 'Plongée successive : azote résiduel de la plongée précédente pris en compte.' });
  }
  ligne('Début (état initial)', 'surface', p.gaz.o2);

  // Plongée courante.
  const fo2 = p.gaz.o2;
  const tFinTemps = p.niveaux.reduce((s, n) => s + n.duree, 0);
  simulerPlongee(p.niveaux, fo2);
  const tFinFond = t;
  const profMax = Math.max(...p.niveaux.map((n) => n.profondeur));
  const ndl = (() => {
    // Estimation grossière : charge du compartiment directeur extrapolée.
    const c = plafondGF(p.gfHaut / 100);
    return c > 0 ? null : Math.max(0, Math.round(60 * (1 - (profMax - 10) / 40)) - 5);
  })();

  // Remontée avec paliers (GF interpolé entre premier palier et surface).
  const inc = p.stopIncrement;
  const gfB = p.gfBas / 100;
  const gfH = p.gfHaut / 100;
  const premierPlafond = plafondGF(gfB);
  let premierPalier = premierPlafond > 0 ? Math.max(p.lastStopDepth, Math.ceil(premierPlafond / inc) * inc) : 0;
  const gfA = (z) => (premierPalier > 0 ? gfH + ((gfB - gfH) * z) / premierPalier : gfH);
  const gazA = (z) => {
    let best = fo2;
    (p.gazDeco || []).forEach((g) => { if (z <= g.profondeurBascule && g.o2 > best) best = g.o2; });
    return best;
  };
  const r0 = t;
  if (premierPalier > 0) {
    segment(premierPalier, (prof - premierPalier) / p.vitesseRemontee, 'remontee', fo2);
    phases.push({ type: 'remontee', debut: arr(r0), fin: arr(t), profDebut: profMax, profFin: premierPalier, gaz: nomGaz(fo2), libelle: `Remontée vers ${premierPalier} m` });
    ligne(`Arrivée au palier de ${premierPalier} m`, 'remontee', fo2);
    let z = premierPalier;
    while (z > 0) {
      const suivant = z - inc < p.lastStopDepth ? 0 : z - inc;
      const g = gazA(z);
      gfCourant = gfA(suivant);
      let duree = 0;
      const d0 = t;
      while (plafondGF(gfCourant) > suivant + 1e-6 && duree < 600) {
        segment(z, 1, 'palier', g);
        duree += 1;
      }
      if (duree > 0) {
        paliers.push({ profondeur: z, duree, debut: arr(d0), gaz: nomGaz(g), securite: false });
        phases.push({ type: 'palier', debut: arr(d0), fin: arr(t), profDebut: z, profFin: z, gaz: nomGaz(g), libelle: `Palier ${z} m` });
        tableau.push({ ...etat('palier', g), libelle: `Début palier ${z} m` });
        tableau[tableau.length - 1].t = arr(d0);
        ligne(`Fin palier ${z} m`, 'palier', g);
      }
      const m0 = t;
      segment(suivant, (z - suivant) / p.vitesseRemontee, 'remontee', g);
      phases.push({ type: 'remontee', debut: arr(m0), fin: arr(t), profDebut: z, profFin: suivant, gaz: nomGaz(g), libelle: suivant ? `Remontée vers ${suivant} m` : 'Remontée vers la surface' });
      z = suivant;
    }
  } else if (p.safetyStop?.actif) {
    const s = p.safetyStop;
    segment(s.profondeur, (prof - s.profondeur) / p.vitesseRemontee, 'remontee', fo2);
    phases.push({ type: 'remontee', debut: arr(r0), fin: arr(t), profDebut: profMax, profFin: s.profondeur, gaz: nomGaz(fo2), libelle: `Remontée vers ${s.profondeur} m` });
    const d0 = t;
    segment(s.profondeur, s.duree, 'palier', fo2);
    paliers.push({ profondeur: s.profondeur, duree: s.duree, debut: arr(d0), gaz: nomGaz(fo2), securite: true });
    phases.push({ type: 'palier', debut: arr(d0), fin: arr(t), profDebut: s.profondeur, profFin: s.profondeur, gaz: nomGaz(fo2), libelle: 'Palier de sécurité' });
    ligne(`Fin palier de sécurité ${s.profondeur} m`, 'palier', fo2);
    const m0 = t;
    segment(0, s.profondeur / p.vitesseRemontee, 'remontee', fo2);
    phases.push({ type: 'remontee', debut: arr(m0), fin: arr(t), profDebut: s.profondeur, profFin: 0, gaz: nomGaz(fo2), libelle: 'Remontée vers la surface' });
  } else {
    segment(0, prof / p.vitesseRemontee, 'remontee', fo2);
    phases.push({ type: 'remontee', debut: arr(r0), fin: arr(t), profDebut: profMax, profFin: 0, gaz: nomGaz(fo2), libelle: 'Remontée vers la surface' });
  }
  gfCourant = gfH;
  const tSortie = t;
  ligne('Sortie', 'surface', 0.21);

  // Surface : jusqu'à désaturation (pas adaptatif), lignes à +10 min … +48 h.
  const reperes = [10, 30, 60, 120, 240, 360, 720, 1440, 2880];
  let iRep = 0;
  let avion = null;
  const desatOk = () => tissus.every((pt) => pt - eqSurf <= p.desatThreshold * eqSurf);
  while (!desatOk() && t - tSortie < 96 * 60) {
    const ecoule = t - tSortie;
    const pas = ecoule < 30 ? 1 : ecoule < 240 ? 3 : 10;
    const cible = iRep < reperes.length ? tSortie + reperes[iRep] : Infinity;
    const dt = Math.min(pas, cible - t);
    charger((psurf - PH2O) * FN2_AIR, dt);
    t += dt;
    echantillons.push(etat('surface', 0.21));
    if (avion === null) {
      let tol = 0;
      tissus.forEach((pt, i) => { tol = Math.max(tol, (pt - A[i] * gfH) / (gfH / B[i] + 1 - gfH)); });
      if (tol <= 0.75) avion = Math.ceil(t - tSortie);
    }
    if (Math.abs(t - cible) < 1e-9) {
      const r = reperes[iRep];
      ligne(`Surface +${r < 60 ? `${r} min` : `${r / 60} h`}`, 'surface', 0.21);
      iRep++;
    }
  }
  const desaturation = Math.ceil(t - tSortie);
  ligne('Désaturation complète', 'surface', 0.21);
  phases.push({ type: 'surface', debut: arr(tSortie), fin: arr(t), profDebut: 0, profFin: 0, gaz: 'Air', libelle: 'Surface' });

  // Réduction à ≤ 2 000 échantillons.
  let ech = echantillons;
  if (ech.length > 2000) {
    const k = Math.ceil(ech.length / 2000);
    ech = ech.filter((_, i) => i % k === 0 || i === ech.length - 1);
  }
  tableau.sort((x, y) => x.t - y.t);

  const dureeTotale = Math.round(tSortie);
  const dtr = Math.round(tSortie - tFinFond);
  const mod = arr(profDe(p.ppo2Max / fo2));
  if (profMax > mod) alertes.push({ niveau: 'danger', message: `PpO2 au fond supérieure à ${p.ppo2Max} bar : profondeur maximale d'utilisation du gaz dépassée (MOD ${Math.floor(mod)} m).` });
  if (paliers.some((s) => !s.securite)) alertes.push({ niveau: 'attention', message: 'Plongée avec paliers obligatoires (moteur factice).' });
  if (p.altitude > 300) alertes.push({ niveau: 'info', message: `Plongée en altitude : pression de surface ${psurf.toFixed(3)} bar.` });
  if (profMax > 40) alertes.push({ niveau: 'danger', message: 'Profondeur supérieure à 40 m : au-delà des limites de la plongée loisir à l’air.' });

  let consommation = null;
  if (p.consommation) {
    const c = p.consommation;
    const parType = {};
    for (let i = 1; i < echantillons.length; i++) {
      const e = echantillons[i];
      if (e.t <= 0 || e.t > tSortie) continue;
      const dt = e.t - echantillons[i - 1].t;
      parType[e.phase] = (parType[e.phase] || 0) + c.sac * e.pamb * dt;
    }
    const litres = Object.values(parType).reduce((s, v) => s + v, 0);
    const pressionRestante = c.pression - litres / c.volume;
    const reserveEntamee = pressionRestante < c.reserve;
    if (reserveEntamee) alertes.push({ niveau: pressionRestante < 0 ? 'danger' : 'attention', message: `Réserve entamée : il resterait ${Math.round(pressionRestante)} bar (réserve ${c.reserve} bar).` });
    consommation = {
      litres: Math.round(litres), pressionRestante: Math.round(pressionRestante), reserveEntamee,
      parPhase: Object.entries(parType).map(([type, l]) => ({ type, litres: Math.round(l) })),
    };
  }
  void tFinTemps;

  return {
    ok: true,
    erreurs: [],
    alertes,
    psurf: arr(psurf),
    compartiments: COMPARTIMENTS.map((c) => ({ ...c })),
    phases,
    paliers,
    echantillons: ech,
    tableau,
    resume: {
      dureeTotale, dtr, profondeurMax: profMax,
      tempsFond: p.niveaux.reduce((s, n) => s + n.duree, 0),
      ndl, paliersObligatoires: paliers.some((s) => !s.securite),
      desaturation, avion: avion ?? desaturation,
      cns: Math.round(cns * 10) / 10, otu: Math.round(otu), mod, consommation,
    },
  };
}
