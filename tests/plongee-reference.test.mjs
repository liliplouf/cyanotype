// Vérification croisée du moteur « Désatyves » contre une implémentation de référence
// indépendante, écrite ici sans réutiliser le code du moteur :
// - intégration numérique par pas de 1 s (Haldane à pression inspirée constante prise au milieu
//   du pas) au lieu de l'équation de Schreiner analytique ;
// - coefficients ZHL-16C recopiés de la table publiée (Bühlmann 2002, firmware OSTC ; identiques
//   à Subsurface core/deco.cpp pour les compartiments 2 à 16) ;
// - pression d'altitude recalculée depuis l'atmosphère standard (L, T0, g, M, R) ;
// - même convention de remontée que le moteur (méthode de Baker : 1er palier trouvé par une
//   remontée projetée au GF bas, GF interpolé linéairement du 1er palier à la surface, paliers
//   de 3 m en minutes entières, au moins 1 min au 1er palier, remontée directe vérifiée au GF
//   haut à chaque profondeur de la grille).
// Les valeurs attendues ont aussi été relevées une fois pour toutes (non-régression).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planifier, recommandationAvion, REGLES_AVION } from '../plongee/js/planificateur.js';

// ───────────────────────────── référence indépendante ─────────────────────────────

const HT = [4, 8, 12.5, 18.5, 27, 38.3, 54.3, 77, 109, 146, 187, 239, 305, 390, 498, 635];
const A = [1.2599, 1.0, 0.8618, 0.7562, 0.62, 0.5043, 0.441, 0.4, 0.375, 0.35, 0.3295, 0.3065, 0.2835, 0.261, 0.248, 0.2327];
const B = [0.505, 0.6514, 0.7222, 0.7825, 0.8126, 0.8434, 0.8693, 0.891, 0.9092, 0.9222, 0.9319, 0.9403, 0.9477, 0.9544, 0.9602, 0.9653];
const WV = 0.0627;
const DT = 1 / 60;

function psurfISA(h) {
  const L = 0.0065, T0 = 288.15, g = 9.80665, M = 0.0289644, R = 8.3144598;
  return 1.01325 * Math.pow(1 - (L * h) / T0, (g * M) / (R * L));
}
const NOAA = [[0.6, 720], [0.7, 570], [0.8, 450], [0.9, 360], [1.0, 300], [1.1, 240], [1.2, 210], [1.3, 180], [1.4, 150], [1.5, 120], [1.6, 45]];
function cnsParMin(p) {
  if (p <= 0.5) return 0;
  if (p < 0.6) return ((p - 0.5) / 0.1) * (100 / 720);
  if (p >= 1.6) return 100 / (45 * Math.pow(0.5, (p - 1.6) / 0.1));
  for (let i = 1; i < NOAA.length; i++) if (p <= NOAA[i][0]) {
    const [p0, t0] = NOAA[i - 1];
    const [p1, t1] = NOAA[i];
    return 100 / (t0 + ((t1 - t0) * (p - p0)) / (p1 - p0));
  }
  return 0;
}
const otuParMin = (p) => (p <= 0.5 ? 0 : ((p - 0.5) / 0.5) ** (5 / 6));
const fN2 = (o2) => (Math.round(o2 * 100) === 21 ? 0.7902 : 1 - o2);

class Plongeur {
  constructor(env, o2, T) {
    this.env = env;
    this.o2 = o2;
    this.T = T ? T.slice() : new Array(16).fill((env.ps - WV) * 0.7902);
    this.d = 0;
    this.t = 0;
    this.cns = 0;
    this.otu = 0;
  }
  copie() {
    const c = new Plongeur(this.env, this.o2, this.T);
    Object.assign(c, { d: this.d, t: this.t, cns: this.cns, otu: this.otu });
    return c;
  }
  aller(d1, duree) {
    const n = Math.max(1, Math.round(duree / DT));
    const h = duree / n;
    const d0 = this.d;
    if (duree > 0) {
      for (let j = 0; j < n; j++) {
        const p = this.env.P(d0 + ((d1 - d0) * (j + 0.5)) / n);
        const pi = (p - WV) * fN2(this.o2);
        for (let i = 0; i < 16; i++) this.T[i] = pi + (this.T[i] - pi) * Math.exp((-Math.LN2 * h) / HT[i]);
        this.cns += cnsParMin(p * this.o2) * h;
        this.otu += otuParMin(p * this.o2) * h;
      }
      this.t += duree;
    }
    this.d = d1;
  }
  plafond(gf) {
    let m = -Infinity;
    for (let i = 0; i < 16; i++) m = Math.max(m, (this.T[i] - gf * A[i]) / (1 - gf + gf / B[i]));
    return m;
  }
}

const suivante = (d) => { const n = (Math.ceil(d / 3 - 1e-9) - 1) * 3; return n < 3 - 1e-9 ? 0 : n; };

function directPossible(s, gf, vR) {
  const q = s.copie();
  while (q.d > 0) {
    const n = suivante(q.d);
    q.aller(n, (q.d - n) / vR);
    if (q.plafond(gf) > q.env.P(n) + 1e-9) return false;
  }
  return true;
}

function reference({ niveaux, o2 = 0.21, gfBas = 40, gfHaut = 85, altitude = 0, eau = 'mer', gazDeco = [], T0 }) {
  const ps = psurfISA(altitude);
  const bpm = ((eau === 'douce' ? 1000 : 1025) * 9.80665) / 1e5;
  const env = { ps, P: (d) => ps + d * bpm };
  const s = new Plongeur(env, o2, T0);
  const vD = 20, vR = 10, gL = gfBas / 100, gH = gfHaut / 100;
  let ndl = null;
  let profMax = 0;
  niveaux.forEach(([D, duree], k) => {
    const trajet = Math.abs(D - s.d) / (D > s.d ? vD : vR);
    s.aller(D, trajet);
    profMax = Math.max(profMax, D);
    if (k === niveaux.length - 1) {
      if (directPossible(s, gH, vR)) {
        ndl = 0;
        const q = s.copie();
        for (;;) { q.aller(D, 1); if (!directPossible(q, gH, vR) || ndl >= 999) break; ndl++; }
      }
    }
    s.aller(D, duree - trajet);
  });
  const finFond = s.t;
  const paliers = [];
  let premier = null;
  if (directPossible(s, gH, vR)) {
    if (profMax > 5) { s.aller(5, (s.d - 5) / vR); s.aller(5, 3); paliers.push([5, 3]); }
    s.aller(0, s.d / vR);
  } else {
    const p = s.copie();
    for (;;) {
      const n = suivante(p.d);
      const q = p.copie();
      q.aller(n, (p.d - n) / vR);
      if (q.plafond(gL) > env.P(n) + 1e-9) break;
      p.aller(n, (p.d - n) / vR);
      if (n === 0) break;
    }
    premier = p.d;
    const gf = (x) => (x >= premier ? gL : gH + ((gL - gH) * x) / premier);
    while (s.d > 0) {
      const n = suivante(s.d);
      let k = 0;
      for (;;) {
        if (!(k === 0 && Math.abs(s.d - premier) < 1e-9)) {
          const q = s.copie();
          q.aller(n, (s.d - n) / vR);
          if (q.plafond(gf(n)) <= env.P(n) + 1e-9) break;
        }
        s.aller(s.d, 1);
        k++;
      }
      if (k) paliers.push([s.d, k]);
      s.aller(n, (s.d - n) / vR);
      for (const g of gazDeco) if (s.d > 0 && s.d <= g[1] + 1e-9 && g[0] > s.o2 && g[0] * env.P(s.d) <= 1.62) s.o2 = g[0];
    }
  }
  const eq = (ps - WV) * 0.7902;
  let desat = 0;
  for (let i = 0; i < 16; i++) {
    const ex = s.T[i] - eq;
    if (ex > 0.02 * eq) desat = Math.max(desat, (HT[i] / Math.LN2) * Math.log(ex / (0.02 * eq)));
  }
  let avion = 0;
  for (; avion < 6000; avion += 0.05) {
    let ok = true;
    for (let i = 0; i < 16 && ok; i++) {
      const p = eq + (s.T[i] - eq) * Math.exp((-Math.LN2 * avion) / HT[i]);
      if ((p - gH * A[i]) / (1 - gH + gH / B[i]) > 0.75 + 1e-12) ok = false;
    }
    if (ok) break;
  }
  return { ps, paliers, premier, ndl, dtr: s.t - finFond, T: s.T, desat, avion, cns: s.cns, otu: s.otu, env };
}

// ───────────────────────────── cas comparés ─────────────────────────────

// Valeurs attendues (paliers « min@m », s = sécurité) relevées sur la référence ci-dessus.
const CAS = [
  { nom: 'Air 18 m 50 min, GF 100/100', niveaux: [[18, 50]], gfBas: 100, gfHaut: 100, paliers: '3@5s', ndl: 61, dtr: 4.8 },
  { nom: 'Air 30 m 25 min, GF 40/85', niveaux: [[30, 25]], paliers: '1@12 2@6 5@3', ndl: 13, dtr: 11 },
  { nom: 'Air 30 m 30 min, GF 30/70', niveaux: [[30, 30]], gfBas: 30, gfHaut: 70, paliers: '2@12 3@9 6@6 17@3', ndl: 9, dtr: 31 },
  { nom: 'Air 40 m 25 min, GF 40/85', niveaux: [[40, 25]], paliers: '1@15 2@12 3@9 7@6 16@3', ndl: 7, dtr: 33 },
  { nom: 'Nx32 30 m 40 min', niveaux: [[30, 40]], o2: 0.32, paliers: '1@9 2@6 8@3', ndl: 22, dtr: 14 },
  { nom: 'Air 45 m 30 min + Nx50 à 21 m, GF 30/70', niveaux: [[45, 30]], gfBas: 30, gfHaut: 70, gazDeco: [[0.5, 21]], paliers: '1@21 2@18 2@15 3@12 5@9 10@6 19@3', ndl: 3, dtr: 46.5 },
  { nom: 'Air 60 m 15 min + Nx50 + O2, GF 30/70', niveaux: [[60, 15]], gfBas: 30, gfHaut: 70, gazDeco: [[0.5, 21], [1, 6]], paliers: '1@24 1@18 1@15 3@12 3@9 3@6 7@3', ndl: 0, dtr: 25 },
  { nom: '30 m 25 min, 1 000 m, eau douce', niveaux: [[30, 25]], altitude: 1000, eau: 'douce', paliers: '1@12 2@6 6@3', ndl: 12, dtr: 12 },
  { nom: '25 m 30 min, 2 500 m, eau douce', niveaux: [[25, 30]], altitude: 2500, eau: 'douce', paliers: '1@9 2@6 6@3', ndl: 16, dtr: 11.5 },
  { nom: 'Multiniveaux 35/20/10 m', niveaux: [[35, 15], [20, 15], [10, 15]], paliers: '1@6', ndl: null, dtr: 2 },
  { nom: 'Air 30 m 10 min, GF 100/100', niveaux: [[30, 10]], gfBas: 100, gfHaut: 100, paliers: '3@5s', ndl: 18, dtr: 6 },
];

const enParams = (c) => ({
  niveaux: c.niveaux.map(([profondeur, duree]) => ({ profondeur, duree })),
  gaz: { o2: c.o2 ?? 0.21 },
  gfBas: c.gfBas ?? 40,
  gfHaut: c.gfHaut ?? 85,
  altitude: c.altitude ?? 0,
  eau: c.eau ?? 'mer',
  gazDeco: (c.gazDeco ?? []).map(([o2, profondeurBascule]) => ({ o2, profondeurBascule })),
});

function comparer(c, r, ref) {
  const R = r.resume;
  const txt = r.paliers.map((p) => `${p.duree}@${p.profondeur}${p.securite ? 's' : ''}`).join(' ');
  const txtRef = ref.paliers.map(([d, t]) => `${t}@${d}${ref.premier === null ? 's' : ''}`).join(' ');
  assert.equal(txt, txtRef, `${c.nom} : paliers moteur ≠ référence`);
  assert.equal(txt, c.paliers, `${c.nom} : paliers ≠ valeurs relevées`);
  assert.equal(R.premierPalier, ref.premier, `${c.nom} : 1er palier`);
  assert.equal(R.ndl, ref.ndl, `${c.nom} : NDL`);
  assert.equal(R.ndl, c.ndl, `${c.nom} : NDL relevée`);
  assert.ok(Math.abs(R.dtr - ref.dtr) < 0.06 && Math.abs(R.dtr - c.dtr) < 0.06, `${c.nom} : DTR ${R.dtr} / ${ref.dtr}`);
  assert.ok(Math.abs(r.psurf - ref.ps) < 1e-4, `${c.nom} : psurf ${r.psurf} / ${ref.ps}`);
  const sortie = r.tableau.find((l) => l.libelle === 'Sortie');
  sortie.pN2.forEach((p, i) => assert.ok(Math.abs(p - ref.T[i]) < 2e-4, `${c.nom} : pN2 C${i + 1} ${p} / ${ref.T[i]}`));
  assert.ok(Math.abs(R.desaturation - ref.desat) <= 1.01, `${c.nom} : désaturation ${R.desaturation} / ${ref.desat}`);
  assert.ok(Math.abs(R.avion - ref.avion) <= 1.01, `${c.nom} : avion ${R.avion} / ${ref.avion}`);
  assert.ok(Math.abs(R.cns - ref.cns) <= 0.1, `${c.nom} : CNS ${R.cns} / ${ref.cns}`);
  assert.ok(Math.abs(R.otu - ref.otu) <= 1, `${c.nom} : OTU ${R.otu} / ${ref.otu}`);
}

for (const c of CAS) {
  test(`référence indépendante : ${c.nom}`, () => {
    const r = planifier(enParams(c));
    assert.equal(r.ok, true, r.erreurs.join(' | '));
    comparer(c, r, reference({ ...c, o2: c.o2 ?? 0.21 }));
  });
}

test('référence indépendante : plongée successive (30 m 25 min, intervalle 90 min, puis 25 m 30 min)', () => {
  const p1 = reference({ niveaux: [[30, 25]] });
  const eq = (p1.ps - WV) * 0.7902;
  const T0 = p1.T.map((p, i) => eq + (p - eq) * Math.exp((-Math.LN2 * 90) / HT[i]));
  const ref = reference({ niveaux: [[25, 30]], T0 });
  const r = planifier({
    niveaux: [{ profondeur: 25, duree: 30 }],
    plongeePrecedente: { niveaux: [{ profondeur: 30, duree: 25 }], gaz: { o2: 0.21 }, intervalle: 90 },
  });
  // CNS et OTU du résumé cumulent les deux plongées (SPEC) : on compare la référence cumulée.
  ref.cns += p1.cns * 0.5 ** (90 / 90);
  ref.otu += p1.otu;
  comparer({ nom: 'successive', paliers: '1@9 6@3', ndl: 20, dtr: 9.5 }, r, ref);
  assert.equal(r.tableau[0].libelle, 'Plongée précédente — début');
  const immersion = r.tableau.find((l) => /^Début de la plongée/.test(l.libelle));
  immersion.pN2.forEach((p, i) => assert.ok(Math.abs(p - T0[i]) < 2e-4, `C${i + 1}`));
});

// ───────────────────────────── non-régression ─────────────────────────────

test('NDL calculée sur le seul gaz fond : un gaz de déco ne la rallonge pas', () => {
  // Avant correction, la remontée « directe » testée pour la NDL basculait sur le Nx50 à 21 m,
  // ce qui donnait 4 min au lieu de 3 à 45 m (GF 30/70) : NDL dépendante d'un gaz qui peut manquer.
  for (const [D, gb, gh] of [[45, 30, 70], [60, 30, 70], [40, 40, 85]]) {
    const base = { niveaux: [{ profondeur: D, duree: D / 20 + 1 }], gfBas: gb, gfHaut: gh };
    const sans = planifier(base).resume.ndl;
    const avec = planifier({ ...base, gazDeco: [{ o2: 0.5, profondeurBascule: 21 }, { o2: 1, profondeurBascule: 6 }] }).resume.ndl;
    assert.equal(avec, sans, `${D} m : NDL ${avec} avec gaz de déco, ${sans} sans`);
  }
});

test('paliers obligatoires jugés sur le seul gaz fond, comme la NDL', () => {
  // Avant correction, une plongée multiniveaux finissant à 10 m passait pour « sans palier
  // obligatoire » parce que la remontée testée basculait sur le Nx50 à 9 m, alors que la NDL
  // affichait « dépassée » et qu'à l'air seul un palier est nécessaire.
  const niveaux = [{ profondeur: 35, duree: 15 }, { profondeur: 20, duree: 15 }, { profondeur: 10, duree: 15 }];
  const sans = planifier({ niveaux });
  const avec = planifier({ niveaux, gazDeco: [{ o2: 0.5, profondeurBascule: 21 }] });
  assert.equal(sans.resume.paliersObligatoires, true);
  assert.equal(avec.resume.paliersObligatoires, true);
  assert.equal(avec.resume.ndl, null);
  assert.ok(avec.paliers.some((p) => !p.securite));
  assert.equal(avec.resume.avionRecommande, 1440);
  // Une plongée vraiment sans palier le reste avec un gaz de déco déclaré.
  const facile = planifier({ niveaux: [{ profondeur: 20, duree: 20 }], gazDeco: [{ o2: 0.5, profondeurBascule: 21 }] });
  assert.equal(facile.resume.paliersObligatoires, false);
});

test('délai avion : recommandation = max(règle usuelle, modèle), jamais la seule valeur du modèle', () => {
  assert.deepEqual(REGLES_AVION, { simple: 720, multiples: 1080, paliers: 1440 });
  assert.equal(recommandationAvion(14).recommande, 720);
  assert.equal(recommandationAvion(14, { plongeesMultiples: true }).recommande, 1080);
  assert.equal(recommandationAvion(14, { paliersObligatoires: true, plongeesMultiples: true }).recommande, 1440);
  assert.equal(recommandationAvion(1500.2, { paliersObligatoires: true }).recommande, 1501);
  assert.equal(recommandationAvion(NaN).recommande, 720);

  // Plongée unique sans palier : 12 h ; le modèle donnerait quelques minutes.
  const simple = planifier({ niveaux: [{ profondeur: 18, duree: 40 }] }).resume;
  assert.equal(simple.paliersObligatoires, false);
  assert.ok(simple.avion < 60);
  assert.equal(simple.avionRegle, 720);
  assert.equal(simple.avionRecommande, 720);
  assert.match(simple.avionMotif, /12 h/);
  // Avec paliers : 24 h.
  const deco = planifier({ niveaux: [{ profondeur: 30, duree: 25 }] });
  assert.equal(deco.resume.avionRecommande, 1440);
  assert.ok(deco.alertes.some((a) => /attendre au moins 24 h/.test(a.message) && /Le modèle seul donnerait 23 min/.test(a.message)));
  // Plongée successive sans palier : 18 h ; si la précédente avait des paliers : 24 h.
  const succ = planifier({ niveaux: [{ profondeur: 12, duree: 30 }], plongeePrecedente: { niveaux: [{ profondeur: 15, duree: 30 }], intervalle: 120 } });
  assert.equal(succ.resume.paliersObligatoires, false);
  assert.equal(succ.resume.avionRecommande, 1080);
  const succDeco = planifier({ niveaux: [{ profondeur: 12, duree: 30 }], plongeePrecedente: { niveaux: [{ profondeur: 35, duree: 30 }], intervalle: 120 } });
  assert.equal(succDeco.resume.avionRecommande, 1440);
  // Le modèle l'emporte s'il est plus long (plongée très longue).
  const longue = planifier({ niveaux: [{ profondeur: 100, duree: 60 }] }).resume;
  assert.ok(longue.avion > 0 && longue.avionRecommande === Math.max(1440, longue.avion));
});
