import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planifier, PARAMETRES_DEFAUT } from '../plongee/js/planificateur.js';
import { COMPARTIMENTS_ZHL16C } from '../plongee/js/buhlmann.js';
import { equilibreN2 } from '../plongee/js/physique.js';

const plan = (p) => {
  const r = planifier(p);
  assert.equal(r.ok, true, `plan refusé : ${r.erreurs?.join(' | ')}`);
  return r;
};
/** Minutes de paliers obligatoires (hors palier de sécurité). */
const deco = (r) => r.paliers.filter((p) => !p.securite).reduce((a, p) => a + p.duree, 0);
const seul = (profondeur, duree, extra = {}) => ({ niveaux: [{ profondeur, duree }], ...extra });

test('PARAMETRES_DEFAUT conformes au contrat et plan par défaut complet', () => {
  for (const cle of ['niveaux', 'gaz', 'gazDeco', 'altitude', 'eau', 'gfBas', 'gfHaut', 'safetyStop', 'consommation']) {
    assert.ok(cle in PARAMETRES_DEFAUT, cle);
  }
  const r = plan(PARAMETRES_DEFAUT);
  for (const cle of ['ok', 'erreurs', 'alertes', 'psurf', 'compartiments', 'phases', 'paliers', 'echantillons', 'tableau', 'resume']) {
    assert.ok(cle in r, cle);
  }
  assert.equal(r.compartiments.length, 16);
  const e = r.echantillons[10];
  for (const cle of ['t', 'profondeur', 'pamb', 'phase', 'plafond', 'directeur', 'ppo2']) assert.ok(cle in e, cle);
  for (const cle of ['pN2', 'pctMAmb', 'pctMSurf', 'pctGF']) assert.equal(e[cle].length, 16, cle);
  for (const cle of ['dureeTotale', 'dtr', 'profondeurMax', 'tempsFond', 'ndl', 'paliersObligatoires', 'desaturation', 'avion', 'cns', 'otu', 'mod']) {
    assert.ok(cle in r.resume, cle);
  }
  assert.equal(r.resume.consommation, null);
  assert.equal(r.resume.tempsFond, 20);
  assert.equal(r.resume.profondeurMax, 30);
  // planifier() sans argument = paramètres par défaut, et ne modifie pas l'objet par défaut
  assert.deepEqual(planifier().resume, r.resume);
  assert.deepEqual(PARAMETRES_DEFAUT.niveaux, [{ profondeur: 30, duree: 20 }]);
});

test('plongée courte et peu profonde : plafond toujours nul, pas de palier obligatoire, palier de sécurité', () => {
  const r = plan(seul(12, 20));
  assert.ok(r.echantillons.every((e) => e.plafond === 0));
  assert.equal(r.resume.paliersObligatoires, false);
  assert.deepEqual(
    r.paliers.map((p) => [p.profondeur, p.duree, p.securite]),
    [[5, 3, true]],
  );
  assert.ok(r.resume.ndl > 100);
  const sans = plan(seul(12, 20, { safetyStop: { actif: false } }));
  assert.equal(sans.paliers.length, 0);
});

test('NDL à 30 m, air, niveau de la mer, GF 100/100 : ≈ 16–20 min (références ZHL-16C)', () => {
  // Références : avec une descente instantanée et la définition « classique » (tension du
  // compartiment directeur = M-value de surface, sans compter la désaturation pendant la
  // remontée), ZHL-16C donne ≈ 16,3 min à 30 m (compartiment 2), valeur proche des tables
  // Bühlmann (≈ 17 min) ; les ordinateurs qui créditent la remontée affichent 17–20 min.
  // Le moteur crédite la remontée (10 m/min) et compte la NDL à partir de l'arrivée au fond
  // (descente de 1,5 min à 20 m/min) : on attend environ 18 + 1,5 ≈ 19,5 min depuis l'immersion.
  const r = plan(seul(30, 10, { gfBas: 100, gfHaut: 100 }));
  const total = r.resume.ndl + 30 / 20;
  assert.ok(total >= 16 && total <= 20, `NDL totale ${total}`);
  // Vérification croisée : rester ndl min passe sans palier, ndl + 2 min impose des paliers.
  const limite = 1.5 + r.resume.ndl;
  assert.equal(plan(seul(30, limite, { gfBas: 100, gfHaut: 100, safetyStop: { actif: false } })).resume.paliersObligatoires, false);
  assert.equal(plan(seul(30, limite + 2, { gfBas: 100, gfHaut: 100 })).resume.paliersObligatoires, true);
  // Cohérence avec la définition classique calculée ici à la main (compartiment 2, descente instantanée).
  const c = COMPARTIMENTS_ZHL16C[1];
  const psurf = 1.01325;
  const pi = (psurf + 30 * 0.100522 - 0.0627) * 0.7902;
  const p0 = equilibreN2(psurf);
  const M0 = c.a + psurf / c.b;
  const classique = (-Math.log((M0 - pi) / (p0 - pi)) * c.demiVie) / Math.LN2;
  assert.ok(Math.abs(classique - 16.3) < 0.2, `${classique}`);
  assert.ok(total > classique);
  // Une NDL plus courte avec GF haut 85 %
  assert.ok(plan(seul(30, 10)).resume.ndl < r.resume.ndl);
});

test("l'altitude augmente la déco et réduit la NDL", () => {
  const mer = plan(seul(30, 25));
  const alt = plan(seul(30, 25, { altitude: 2000 }));
  assert.ok(deco(alt) > deco(mer), `${deco(alt)} vs ${deco(mer)}`);
  assert.ok(alt.resume.ndl < mer.resume.ndl);
  assert.ok(alt.psurf < 0.8 && alt.psurf > 0.79);
  // la remontée vise Psurf : à la sortie, échantillon de surface à Psurf
  const sortie = alt.tableau.find((l) => l.libelle === 'Sortie');
  assert.equal(sortie.pamb, alt.psurf);
});

test('le nitrox réduit la déco ; des GF plus conservateurs la rallongent', () => {
  const air = plan(seul(30, 30));
  const nx = plan(seul(30, 30, { gaz: { o2: 0.32 } }));
  assert.ok(deco(nx) < deco(air), `${deco(nx)} vs ${deco(air)}`);
  assert.ok(nx.resume.ndl > air.resume.ndl);
  const gf8585 = plan(seul(40, 25, { gfBas: 85, gfHaut: 85 }));
  const gf4085 = plan(seul(40, 25, { gfBas: 40, gfHaut: 85 }));
  const gf3070 = plan(seul(40, 25, { gfBas: 30, gfHaut: 70 }));
  assert.ok(deco(gf4085) > deco(gf8585));
  assert.ok(deco(gf3070) > deco(gf4085));
  assert.ok(gf3070.paliers[0].profondeur >= gf4085.paliers[0].profondeur);
  assert.ok(gf4085.paliers[0].profondeur > gf8585.paliers[0].profondeur);
});

test('paliers : multiples de 3 m, minutes entières, ordre décroissant, dernier palier 3 ou 6 m', () => {
  const r = plan(seul(40, 30));
  assert.ok(r.paliers.length >= 3);
  for (const p of r.paliers) {
    assert.equal(p.profondeur % 3, 0);
    assert.ok(Number.isInteger(p.duree) && p.duree >= 1);
    assert.equal(p.securite, false);
  }
  for (let i = 1; i < r.paliers.length; i++) assert.ok(r.paliers[i].profondeur < r.paliers[i - 1].profondeur);
  assert.equal(r.paliers.at(-1).profondeur, 3);
  assert.equal(r.resume.premierPalier, r.paliers[0].profondeur);
  const six = plan(seul(40, 30, { lastStopDepth: 6 }));
  assert.equal(six.paliers.at(-1).profondeur, 6);
  assert.ok(six.paliers.every((p) => p.profondeur >= 6));
  // DTR = durée totale − temps fond
  assert.ok(Math.abs(r.resume.dtr - (r.resume.dureeTotale - r.resume.tempsFond)) < 0.11);
});

test('après la remontée planifiée, aucun compartiment ne dépasse sa M-value pondérée par le GF', () => {
  const cas = [
    {},
    seul(45, 30),
    seul(30, 25, { altitude: 3000 }),
    seul(40, 30, { lastStopDepth: 6 }),
    seul(50, 25, { gfBas: 20, gfHaut: 70 }),
    seul(45, 30, { gazDeco: [{ o2: 0.5, profondeurBascule: 21 }, { o2: 1, profondeurBascule: 6 }] }),
    seul(30, 25, { eau: 'douce', altitude: 1500 }),
    { niveaux: [{ profondeur: 35, duree: 15 }, { profondeur: 20, duree: 20 }, { profondeur: 9, duree: 20 }] },
  ];
  for (const p of cas) {
    const r = plan(p);
    for (const e of r.echantillons) {
      if (e.t < 0) continue;
      assert.ok(e.plafond <= e.profondeur + 0.3, `plafond ${e.plafond} > ${e.profondeur} à t=${e.t} (${JSON.stringify(p)})`);
      // gradient relatif au GF courant : pctGF ≤ GF (sous l'eau, après le fond)
      if (['remontee', 'palier'].includes(e.phase)) {
        assert.ok(Math.max(...e.pctGF) <= e.gf + 1.5, `pctGF ${Math.max(...e.pctGF)} > GF ${e.gf} à t=${e.t}`);
      }
    }
    // à la sortie, tous les compartiments sont sous la M-value de surface pondérée par le GF haut
    const sortie = r.tableau.find((l) => l.libelle === 'Sortie');
    assert.ok(Math.max(...sortie.pctGF) <= (p.gfHaut ?? 85) + 0.1);
  }
});

test('gaz de déco : bascule au bon palier, déco raccourcie, O2 à 6 m accepté', () => {
  const sans = plan(seul(45, 30));
  const avec = plan(seul(45, 30, { gazDeco: [{ o2: 0.5, profondeurBascule: 21 }, { o2: 1, profondeurBascule: 6 }] }));
  assert.ok(deco(avec) < deco(sans));
  for (const p of avec.paliers) {
    if (p.profondeur > 21) assert.equal(p.gaz, 'Air');
    else if (p.profondeur > 6) assert.equal(p.gaz, 'Nx50');
    else assert.equal(p.gaz, 'O2');
  }
  assert.ok(avec.tableau.some((l) => l.libelle.startsWith('Bascule sur Nx50 à 21 m')));
  assert.ok(avec.echantillons.filter((e) => e.gaz === 'O2' && e.t > 0).every((e) => e.ppo2 <= 1.62));
});

test('désaturation monotone et terminée ; délai avion avant la désaturation', () => {
  const r = plan(seul(30, 25));
  const sortie = r.resume.dureeTotale;
  const surf = r.echantillons.filter((e) => e.phase === 'surface' && e.t >= sortie - 0.06);
  assert.ok(surf.length > 50);
  for (let i = 1; i < surf.length; i++) {
    assert.ok(surf[i].t > surf[i - 1].t);
    for (let c = 0; c < 16; c++) assert.ok(surf[i].pN2[c] <= surf[i - 1].pN2[c] + 1e-4, `compartiment ${c + 1}`);
  }
  const eq = equilibreN2(r.psurf);
  const fin = surf.at(-1);
  assert.ok(Math.abs(fin.t - sortie - r.resume.desaturation) < 1.1);
  for (const p of fin.pN2) assert.ok(p - eq <= 0.02 * eq + 2e-4, `${p} vs ${eq}`);
  assert.ok(r.resume.desaturation > 600 && r.resume.desaturation < 3000);
  assert.ok(r.resume.avion >= 0 && r.resume.avion < r.resume.desaturation);
  assert.equal(r.resume.desaturationPlafonnee, false);
  const derniere = r.tableau.at(-1);
  assert.match(derniere.libelle, /Désaturation complète/);
});

test('plongée successive plus pénalisante que la première ; t négatifs pour la plongée précédente', () => {
  const premiere = plan(seul(30, 25));
  const succ = plan(seul(30, 25, { plongeePrecedente: { niveaux: [{ profondeur: 30, duree: 25 }], gaz: { o2: 0.21 }, intervalle: 60 } }));
  assert.ok(deco(succ) > deco(premiere));
  assert.ok(succ.resume.dtr > premiere.resume.dtr);
  assert.ok(succ.resume.desaturation > premiere.resume.desaturation);
  assert.ok(succ.resume.cns > premiere.resume.cns);
  assert.ok(succ.resume.otu > premiere.resume.otu);
  const negatifs = succ.echantillons.filter((e) => e.t < 0);
  assert.ok(negatifs.length > 50);
  assert.ok(negatifs.some((e) => e.profondeur === 30));
  // la plongée précédente commence à −(durée précédente + intervalle)
  assert.ok(Math.abs(succ.plongeePrecedente.sortie + 60) < 1e-6);
  assert.equal(succ.echantillons[0].t, succ.plongeePrecedente.debut);
  assert.ok(Math.abs(succ.plongeePrecedente.debut + 60 + premiere.resume.dureeTotale) < 0.01);
  assert.ok(succ.alertes.some((a) => /successive/i.test(a.message)));
  // avec un intervalle très long, on retrouve la première plongée
  const loin = plan(seul(30, 25, { plongeePrecedente: { niveaux: [{ profondeur: 30, duree: 25 }], intervalle: 4 * 24 * 60 } }));
  assert.deepEqual(loin.paliers, premiere.paliers);
});

test('acclimatation : arrivée récente en altitude plus pénalisante, acclimatation longue sans effet', () => {
  const base = plan(seul(30, 25, { altitude: 2000 }));
  const recente = plan(seul(30, 25, { altitude: 2000, acclimatation: { altitudeOrigine: 0, heuresDepuisArrivee: 1 } }));
  const ancienne = plan(seul(30, 25, { altitude: 2000, acclimatation: { altitudeOrigine: 0, heuresDepuisArrivee: 200 } }));
  assert.ok(deco(recente) > deco(base) || recente.resume.desaturation > base.resume.desaturation);
  assert.ok(recente.tableau[0].pN2[15] > base.tableau[0].pN2[15]);
  assert.ok(recente.alertes.some((a) => /Acclimatation incomplète/.test(a.message)));
  assert.deepEqual(ancienne.paliers, base.paliers);
});

test('consommation cohérente avec un calcul à la main (30 m, 20 min, SAC 20 L/min, 15 L à 200 bar)', () => {
  const r = plan({ consommation: { sac: 20, volume: 15, pression: 200, reserve: 50 } });
  const c = r.resume.consommation;
  // À la main, phase par phase : descente 1,5 min (Pamb moyenne (1,01325 + 4,0289)/2), fond
  // 18,5 min à 4,0289 bar, puis remontée et paliers d'après la liste des phases.
  const bpm = 1.025 * 9.80665 / 100;
  let attendu = 0;
  for (const ph of r.phases.filter((x) => x.type !== 'surface')) {
    const pm = 1.01325 + ((ph.profDebut + ph.profFin) / 2) * bpm;
    attendu += 20 * pm * (ph.fin - ph.debut);
  }
  assert.ok(Math.abs(c.litres - attendu) < 2, `${c.litres} vs ${attendu}`);
  const fond = 20 * (1.01325 + 30 * bpm) * 18.5;
  assert.ok(Math.abs(r.resume.consommation.parPhase.find((x) => x.type === 'fond').litres - fond) < 1);
  assert.ok(Math.abs(c.pressionRestante - (200 - attendu / 15)) < 1);
  assert.equal(c.reserveEntamee, false);
  // avec 12 L : 2 400 L disponibles, ≈ 1 835 L consommés → ≈ 47 bar < 50 bar de réserve
  const petite = plan({ consommation: { sac: 20, volume: 12, pression: 200, reserve: 50 } });
  assert.equal(petite.resume.consommation.reserveEntamee, true);
  const longue = plan(seul(40, 40, { consommation: { sac: 20, volume: 12, pression: 200, reserve: 50 } }));
  assert.equal(longue.resume.consommation.reserveEntamee, true);
  assert.ok(longue.alertes.some((a) => a.niveau === 'danger' && /Consommation/.test(a.message)));
});

test('CNS / OTU sur un cas connu : Nx32 à 33 m (PpO2 ≈ 1,386 bar) pendant 30 min', () => {
  // 28,35 min au fond à 1,386 bar → ≈ 28,35 / 154,3 ≈ 18,4 % ; + descente et remontée (≈ 1 %).
  const r = plan(seul(33, 30, { gaz: { o2: 0.32 } }));
  const pp = (1.01325 + 33 * 0.100522) * 0.32;
  assert.ok(Math.abs(pp - 1.3858) < 1e-3);
  const limite = 180 + ((150 - 180) * (pp - 1.3)) / 0.1;
  const fond = (100 * (30 - 33 / 20)) / limite;
  assert.ok(r.resume.cns > fond && r.resume.cns < fond + 2.5, `${r.resume.cns} vs ${fond}`);
  const otuFond = (30 - 33 / 20) * Math.pow((pp - 0.5) / 0.5, 5 / 6);
  assert.ok(r.resume.otu >= Math.floor(otuFond) && r.resume.otu < otuFond + 8, `${r.resume.otu} vs ${otuFond}`);
  // Air, 30 m / 20 min : CNS ≈ 5 %
  const air = plan({});
  assert.ok(air.resume.cns > 4.3 && air.resume.cns < 5.5);
});

test('alertes : PpO2 au-delà de la MOD, profondeur > 40 m à l’air, > 60 m, vitesse de remontée', () => {
  const nx = plan(seul(40, 15, { gaz: { o2: 0.32 } }));
  assert.ok(nx.alertes.some((a) => a.niveau === 'danger' && /MOD/.test(a.message)));
  const air45 = plan(seul(45, 10));
  assert.ok(air45.alertes.some((a) => a.niveau === 'attention' && /40 m/.test(a.message)));
  const p65 = plan(seul(65, 10));
  assert.ok(p65.alertes.some((a) => a.niveau === 'danger' && /60 m/.test(a.message)));
  const vite = plan({ vitesseRemontee: 18 });
  assert.ok(vite.alertes.some((a) => /hors normes/.test(a.message)));
  const calme = plan(seul(12, 20));
  assert.ok(calme.alertes.every((a) => a.niveau === 'info'));
});

test('erreurs de validation en français', () => {
  const cas = [
    [seul(-5, 20), /profondeur doit être positive/],
    [seul(20, 0), /durée doit être strictement positive/],
    [seul(30, 1), /plus courte que le trajet/],
    [{ gaz: { o2: 1.3 } }, /fraction d'oxygène/],
    [{ gaz: { o2: 0.12 } }, /hypoxique/],
    [{ niveaux: [] }, /au moins un niveau/],
    [{ gfBas: 90, gfHaut: 70 }, /GF bas ne peut pas dépasser/],
    [{ altitude: 9000 }, /Altitude invalide/],
    [{ eau: 'lac' }, /Type d'eau/],
    [{ vitesseRemontee: 0 }, /Vitesse de remontée/],
    [{ gazDeco: [{ o2: 0.5 }] }, /profondeur de bascule/],
    [{ consommation: { sac: 20, volume: 12, pression: 200, reserve: 250 } }, /réserve/],
    [{ plongeePrecedente: { niveaux: [{ profondeur: 20, duree: 30 }], intervalle: -5 } }, /intervalle/],
    [{ niveaux: [{ profondeur: 'abc', duree: 20 }] }, /profondeur manquante ou invalide/],
  ];
  for (const [p, re] of cas) {
    const r = planifier(p);
    assert.equal(r.ok, false, JSON.stringify(p));
    assert.ok(r.erreurs.some((m) => re.test(m)), `${JSON.stringify(p)} → ${r.erreurs.join(' | ')}`);
    assert.deepEqual(r.echantillons, []);
    assert.equal(r.resume, null);
  }
  // valeurs numériques passées en chaînes (champs de formulaire) acceptées
  assert.equal(planifier({ niveaux: [{ profondeur: '20', duree: '30' }], altitude: '' }).ok, true);
});

test('échantillons : ≤ 2 000 points, chronologiques, pas ≤ 0,25 min sous l’eau pour une plongée typique', () => {
  const cas = [
    {},
    seul(60, 40),
    seul(90, 40, { plongeePrecedente: { niveaux: [{ profondeur: 70, duree: 40 }], intervalle: 30 } }),
    { niveaux: [{ profondeur: 40, duree: 20 }, { profondeur: 25, duree: 30 }, { profondeur: 12, duree: 60 }] },
  ];
  for (const p of cas) {
    const r = plan(p);
    assert.ok(r.echantillons.length <= 2000, `${r.echantillons.length}`);
    for (let i = 1; i < r.echantillons.length; i++) assert.ok(r.echantillons[i].t > r.echantillons[i - 1].t);
  }
  const r = plan({});
  const sousEau = r.echantillons.filter((e) => e.t >= 0 && e.t <= r.resume.dureeTotale);
  for (let i = 1; i < sousEau.length; i++) assert.ok(sousEau[i].t - sousEau[i - 1].t <= 0.2501);
  assert.equal(r.echantillons[0].t, 0);
  assert.equal(r.echantillons[0].profondeur, 0);
  assert.ok(r.echantillons.some((e) => e.profondeur === 30 && e.phase === 'fond'));
});

test('tableau : instants clés dans l’ordre chronologique', () => {
  const r = plan({});
  const lib = r.tableau.map((l) => l.libelle);
  for (let i = 1; i < r.tableau.length; i++) assert.ok(r.tableau[i].t >= r.tableau[i - 1].t);
  const attendus = [
    /^Début de la plongée/,
    /^Fin de descente/,
    /^Fin du fond/,
    /^Arrivée au 1er palier/,
    /^Fin du palier à 9 m/,
    /^Début du palier à 3 m/,
    /^Sortie/,
    /^Surface \+10 min/,
    /^Surface \+30 min/,
    /^Surface \+1 h/,
    /^Surface \+12 h/,
    /^Désaturation complète/,
  ];
  let pos = -1;
  for (const re of attendus) {
    const i = lib.findIndex((l, j) => j > pos && re.test(l));
    assert.ok(i > pos, `${re} absent ou mal placé dans ${lib.join(' / ')}`);
    pos = i;
  }
  const fin = r.tableau.find((l) => l.libelle === 'Fin de descente');
  assert.equal(fin.t, 1.5);
  assert.equal(fin.profondeur, 30);
  assert.equal(fin.pN2.length, 16);
  assert.ok(fin.directeur >= 1 && fin.directeur <= 16);
  // phases contiguës et cohérentes avec les paliers
  for (let i = 1; i < r.phases.length; i++) assert.ok(Math.abs(r.phases[i].debut - r.phases[i - 1].fin) < 1e-3);
  assert.equal(r.phases.filter((ph) => ph.type === 'palier').length, r.paliers.length);
  assert.equal(r.phases.at(-1).type, 'surface');
});

test('multiniveaux : transitions comptées dans la durée du niveau d’arrivée', () => {
  const r = plan({ niveaux: [{ profondeur: 30, duree: 15 }, { profondeur: 20, duree: 15 }, { profondeur: 10, duree: 20 }] });
  assert.equal(r.resume.tempsFond, 50);
  assert.ok(r.phases.some((ph) => ph.type === 'transition' && ph.profFin === 20));
  const n2 = r.phases.find((ph) => ph.type === 'fond' && ph.profDebut === 20);
  assert.ok(Math.abs(n2.fin - n2.debut - 14) < 1e-6); // 15 min − 1 min de transition à 10 m/min
  const sansInclure = plan({ niveaux: [{ profondeur: 30, duree: 15 }, { profondeur: 20, duree: 15 }], dureeInclutDescente: false });
  assert.ok(Math.abs(sansInclure.resume.tempsFond - (1.5 + 15 + 1 + 15)) < 0.01);
});

test('rapidité : une plongée typique avec désaturation est calculée en moins de 50 ms', () => {
  planifier({});
  const t0 = performance.now();
  const n = 10;
  for (let i = 0; i < n; i++) planifier(seul(40, 30, { gazDeco: [{ o2: 0.5, profondeurBascule: 21 }] }));
  const moyenne = (performance.now() - t0) / n;
  assert.ok(moyenne < 50, `${moyenne.toFixed(1)} ms`);
});
