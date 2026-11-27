// Tests des fonctions pures de l'interface « Paliers » (formatage, formulaire, échelles,
// couleurs, CSV, stockage, géolocalisation) et conformité du moteur factice au contrat.
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { formatNombre, nombreCSV, formatDuree, formatInstant, formatPaliers, nomGaz } from '../plongee/js/format.js';
import {
  construireParams, etatDefaut, fusionnerEtat, lireNombre, presetPourGF, profondeurMOD, PRESETS_GF,
} from '../plongee/js/formulaire.js';
import {
  echelleLineaire, echelleTemps, graduationsLineaires, graduationsTemps, domaineRond, pasRond, indiceProche,
  cheminLigne, domaineY, couleurCompartiment, oklchVersHex, contraste, cssCouleursCompartiments, libelleTemps,
  equilibreSurface, formatValeur, fenetreTemps,
} from '../plongee/js/graphiques.js';
import {
  genererCSV, echapperCSV, couleurChaleur, domaineChaleur, interpolerHex, encrePour, nomFichierCSV, instantCourt,
} from '../plongee/js/tableau.js';
import { lire, ecrire, effacer, utiliserStockage, estPersistant, PREFIXE } from '../plongee/js/stockage.js';
import {
  urlElevation, lireReponseElevation, choisirAltitude, obtenirPosition, elevationOpenMeteo, altitudeIci,
} from '../plongee/js/geo.js';
import { planifier as planifierFactice, PARAMETRES_DEFAUT as DEFAUT_FACTICE } from '../plongee/js/moteur-factice.js';

const NNBSP = ' ';

describe('format', () => {
  test('formatNombre : virgule décimale, espace fine des milliers, signe moins typographique', () => {
    assert.equal(formatNombre(3.14159, 2), '3,14');
    assert.equal(formatNombre(12), '12');
    assert.equal(formatNombre(1450), '1450');
    assert.equal(formatNombre(12345), `12${NNBSP}345`);
    assert.equal(formatNombre(-0.0001, 2), '0,00');
    assert.equal(formatNombre(-2.5, 1), '−2,5');
    assert.equal(formatNombre(NaN), '—');
    assert.equal(formatNombre(undefined), '—');
  });

  test('nombreCSV : virgule décimale, sans séparateur de milliers, vide si non fini', () => {
    assert.equal(nombreCSV(0.75123, 3), '0,751');
    assert.equal(nombreCSV(12345.5, 1), '12345,5');
    assert.equal(nombreCSV(2, 3), '2');
    assert.equal(nombreCSV(null), '');
    assert.equal(nombreCSV(Infinity), '');
  });

  test('formatDuree : minutes, puis heures-minutes, puis heures', () => {
    assert.equal(formatDuree(0), `0${NNBSP}min`);
    assert.equal(formatDuree(0.4), '< 1 min');
    assert.equal(formatDuree(42), `42${NNBSP}min`);
    assert.equal(formatDuree(60), `1${NNBSP}h`);
    assert.equal(formatDuree(125), `2${NNBSP}h${NNBSP}05`);
    assert.equal(formatDuree(2820), `47${NNBSP}h`);
    assert.equal(formatDuree(59.6), `1${NNBSP}h`);
    assert.equal(formatDuree(10.2, { arrondi: 'haut' }), `11${NNBSP}min`);
    assert.equal(formatDuree(null), '—');
  });

  test('formatInstant : décimale utile seulement', () => {
    assert.equal(formatInstant(1.5), `1,5${NNBSP}min`);
    assert.equal(formatInstant(20), `20${NNBSP}min`);
    assert.equal(formatInstant(87), `1${NNBSP}h${NNBSP}27`);
  });

  test('formatPaliers : « 3 min à 6 m, 7 min à 3 m », gaz et sécurité précisés', () => {
    assert.equal(formatPaliers([{ profondeur: 6, duree: 3 }, { profondeur: 3, duree: 7 }]),
      `3${NNBSP}min à 6${NNBSP}m, 7${NNBSP}min à 3${NNBSP}m`);
    assert.equal(formatPaliers([{ profondeur: 6, duree: 2, gaz: 'EAN50' }], { gazFond: 'Air' }), `2${NNBSP}min à 6${NNBSP}m (EAN50)`);
    assert.equal(formatPaliers([{ profondeur: 5, duree: 3, securite: true }]), `3${NNBSP}min à 5${NNBSP}m (sécurité)`);
    assert.equal(formatPaliers([]), '');
    assert.equal(formatPaliers(null), '');
  });

  test('nomGaz', () => {
    assert.equal(nomGaz(0.21), 'Air');
    assert.equal(nomGaz(0.32), 'Nitrox 32');
    assert.equal(nomGaz(1), 'Oxygène pur');
  });
});

describe('formulaire', () => {
  test('lireNombre accepte la virgule et refuse le texte', () => {
    assert.equal(lireNombre('12,5'), 12.5);
    assert.equal(lireNombre(' 1 500 '), 1500);
    assert.equal(lireNombre(''), null);
    assert.equal(lireNombre(undefined), null);
    assert.ok(Number.isNaN(lireNombre('abc')));
    assert.ok(Number.isNaN(lireNombre('1,2,3')));
    assert.equal(lireNombre(7), 7);
  });

  test('état par défaut → paramètres conformes au contrat', () => {
    const { params, erreurs } = construireParams(etatDefaut());
    assert.deepEqual(erreurs, []);
    assert.deepEqual(params.niveaux, [{ profondeur: 30, duree: 20 }]);
    assert.deepEqual(params.gaz, { o2: 0.21 });
    assert.equal(params.altitude, 0);
    assert.equal(params.eau, 'mer');
    assert.equal(params.gfBas, 40);
    assert.equal(params.gfHaut, 85);
    assert.equal(params.lastStopDepth, 3);
    assert.equal(params.stopIncrement, 3);
    assert.deepEqual(params.safetyStop, { actif: true, profondeur: 5, duree: 3 });
    assert.equal(params.dureeInclutDescente, true);
    assert.equal(params.desatThreshold, 0.02);
    assert.equal(params.consommation, null);
    assert.equal(params.plongeePrecedente, null);
    assert.equal(params.acclimatation, null);
    assert.deepEqual(params.gazDeco, []);
  });

  test('erreurs rattachées aux champs, messages en français', () => {
    const e = etatDefaut();
    e.niveaux = [{ profondeur: 'trente', duree: '20' }, { profondeur: '150', duree: '' }];
    e.altitude = '-5';
    e.gfBas = '90'; e.gfHaut = '70';
    const { params, erreurs } = construireParams(e);
    assert.equal(params, null);
    const champs = erreurs.map((x) => x.champ);
    assert.ok(champs.includes('niveaux.0.profondeur'));
    assert.ok(champs.includes('niveaux.1.profondeur'));
    assert.ok(champs.includes('niveaux.1.duree'));
    assert.ok(champs.includes('altitude'));
    assert.ok(champs.includes('gfBas'));
    assert.match(erreurs.find((x) => x.champ === 'niveaux.0.profondeur').message, /nombre attendu/);
    assert.match(erreurs.find((x) => x.champ === 'niveaux.1.duree').message, /obligatoire/);
    assert.match(erreurs.find((x) => x.champ === 'altitude').message, /entre 0 et 5000/);
  });

  test('nitrox, consommation, gaz de déco, successive, acclimatation', () => {
    const e = etatDefaut();
    e.gazType = 'nitrox'; e.o2 = '32';
    e.altitude = '1 200'; e.eau = 'douce';
    e.conso = { volume: '12', pression: '200', reserve: '', sac: '18,5' };
    e.gazDeco = [{ o2: '50', profondeur: '21' }];
    e.successive = true; e.precProfondeur = '25'; e.precDuree = '30'; e.precO2 = '21'; e.intervalle = '90';
    e.acclim = true; e.altitudeOrigine = '0'; e.heuresDepuisArrivee = '3';
    e.lastStopDepth = '6'; e.securiteActif = false;
    const { params, erreurs } = construireParams(e);
    assert.deepEqual(erreurs, []);
    assert.equal(params.gaz.o2, 0.32);
    assert.equal(params.altitude, 1200);
    assert.equal(params.eau, 'douce');
    assert.deepEqual(params.consommation, { sac: 18.5, volume: 12, pression: 200, reserve: 50 });
    assert.deepEqual(params.gazDeco, [{ o2: 0.5, profondeurBascule: 21 }]);
    assert.deepEqual(params.plongeePrecedente, { niveaux: [{ profondeur: 25, duree: 30 }], gaz: { o2: 0.21 }, intervalle: 90 });
    assert.deepEqual(params.acclimatation, { altitudeOrigine: 0, heuresDepuisArrivee: 3 });
    assert.equal(params.lastStopDepth, 6);
    assert.equal(params.safetyStop.actif, false);
  });

  test('consommation incomplète ou incohérente → erreur', () => {
    const e = etatDefaut();
    e.conso = { volume: '12', pression: '', reserve: '50', sac: '' };
    const r = construireParams(e);
    assert.ok(r.erreurs.some((x) => x.champ === 'conso.pression'));
    assert.ok(r.erreurs.some((x) => x.champ === 'conso.sac'));
    e.conso = { volume: '12', pression: '200', reserve: '250', sac: '20' };
    assert.ok(construireParams(e).erreurs.some((x) => x.champ === 'conso.reserve'));
  });

  test('fusionnerEtat ignore les clés inconnues et les types invalides', () => {
    const e = fusionnerEtat({ altitude: 850, niveaux: [{ profondeur: 12, duree: 40 }, null], pirate: 'x', successive: 'oui', conso: { sac: 20 } });
    assert.equal(e.altitude, '850');
    assert.deepEqual(e.niveaux, [{ profondeur: '12', duree: '40' }]);
    assert.equal(e.pirate, undefined);
    assert.equal(e.successive, false);
    assert.equal(e.conso.sac, '20');
    assert.equal(e.conso.reserve, '50');
    assert.deepEqual(fusionnerEtat(null), etatDefaut());
    assert.deepEqual(fusionnerEtat([1, 2]), etatDefaut());
    assert.deepEqual(fusionnerEtat({ niveaux: [] }).niveaux, etatDefaut().niveaux);
  });

  test('préréglages GF et MOD', () => {
    assert.equal(presetPourGF(100, 100), '100/100');
    assert.equal(presetPourGF(30, 70), '30/70');
    assert.equal(presetPourGF(41, 85), 'perso');
    assert.ok(PRESETS_GF.find((p) => p.id === '100/100').libelle.includes('Bühlmann pur'));
    assert.equal(profondeurMOD(0.5, 1.6), 21);
    // Physique exacte (1,01325 bar, eau de mer 1,025) : 5,8 m → bascule O2 pur à 3 m (6 m donnerait 1,62 bar).
    assert.equal(profondeurMOD(1, 1.6), 3);
    assert.equal(profondeurMOD(0.32, 1.4), 33);
    assert.ok(Math.abs(profondeurMOD(0.32, 1.4, { pas: 0 }) - 33.45) < 0.05);
    assert.equal(profondeurMOD(0, 1.4), null);
  });
});

describe('graphiques : échelles et graduations', () => {
  test('échelle linéaire et inverse', () => {
    const f = echelleLineaire(0, 10, 100, 200);
    assert.equal(f(5), 150);
    assert.equal(f.inverse(175), 7.5);
    const g = echelleLineaire(0, 1, 300, 0); // axe vertical inversé
    assert.equal(g(1), 0);
    assert.equal(g.inverse(150), 0.5);
  });

  test('pas ronds et graduations', () => {
    assert.equal(pasRond(0.7), 1);
    assert.equal(pasRond(0.23), 0.25);
    assert.equal(pasRond(37), 50);
    assert.deepEqual(graduationsLineaires(0, 4, 4), [0, 1, 2, 3, 4]);
    assert.deepEqual(graduationsLineaires(0.75, 3.05, 5), [1, 1.5, 2, 2.5, 3]);
    assert.deepEqual(domaineRond(0.71, 3.2, 5), [0.5, 3.5]);
    assert.deepEqual(graduationsLineaires(5, 5), [5]);
    assert.deepEqual(graduationsLineaires(NaN, 1), []);
  });

  test('échelle de temps mixte : linéaire jusqu’à la sortie puis logarithmique, inverse exacte', () => {
    const e = echelleTemps({ tMin: 0, tMax: 2880, x0: 0, x1: 1000, mode: 'mixte', pivot: 40, fraction: 0.4 });
    assert.equal(e.mode, 'mixte');
    assert.equal(e(0), 0);
    assert.equal(e(20), 200);
    assert.equal(e(40), 400);
    assert.ok(Math.abs(e(2880) - 1000) < 1e-9);
    assert.ok(e(100) < e(1000) && e(1000) < e(2000));
    for (const t of [3, 39, 41, 90, 600, 2000]) assert.ok(Math.abs(e.inverse(e(t)) - t) < 1e-6, `t=${t}`);
    // Repli linéaire si le pivot est hors domaine
    assert.equal(echelleTemps({ tMin: 0, tMax: 30, x0: 0, x1: 300, mode: 'mixte', pivot: 40 }).mode, 'lineaire');
  });

  test('graduations de temps : minutes puis heures, sans chevauchement', () => {
    const lin = echelleTemps({ tMin: 0, tMax: 35, x0: 40, x1: 600 });
    const gl = graduationsTemps(lin, { ecartMin: 50 });
    assert.ok(gl.length >= 4);
    assert.deepEqual(gl.slice(0, 3).map((g) => g.t), [0, 5, 10]);
    const mixte = echelleTemps({ tMin: 0, tMax: 1500, x0: 40, x1: 640, mode: 'mixte', pivot: 30 });
    const gm = graduationsTemps(mixte, { ecartMin: 44 });
    assert.ok(gm.some((g) => g.libelle === `1${NNBSP}h`));
    assert.ok(gm.some((g) => g.libelle === `24${NNBSP}h`));
    for (let i = 1; i < gm.length; i++) assert.ok(gm[i].x - gm[i - 1].x >= 44 - 1e-9);
    assert.equal(libelleTemps(90), `1${NNBSP}h${NNBSP}30`);
    assert.equal(libelleTemps(-120), `−2${NNBSP}h`);
    assert.equal(libelleTemps(7.5), '7,5');
  });

  test('indiceProche (dichotomie)', () => {
    const ech = [0, 1, 2, 5, 10].map((t) => ({ t }));
    assert.equal(indiceProche(ech, -3), 0);
    assert.equal(indiceProche(ech, 3.4), 2);
    assert.equal(indiceProche(ech, 3.6), 3);
    assert.equal(indiceProche(ech, 3.5001), 3);
    assert.equal(indiceProche(ech, 99), 4);
    assert.equal(indiceProche([], 1), -1);
  });

  test('cheminLigne coupe le tracé sur les valeurs non finies', () => {
    assert.equal(cheminLigne([[0, 0], [1.234, 2.25], [NaN, 3], [4, 5]]), 'M0 0L1.2 2.3M4 5');
    assert.equal(cheminLigne([]), '');
  });

  test('domaineY inclut la ligne d’équilibre (pN2) ou 100 % (M-value)', () => {
    const ech = [{ pN2: [0.75, 0.8], pctMSurf: [40, 120], pctGF: [-400, 30] }, { pN2: [2.9, 1.1], pctMSurf: [70, 60], pctGF: [10, 20] }];
    const [a, b] = domaineY(ech, 'pN2', [0, 1], { psurf: 1.01325 });
    assert.ok(a <= equilibreSurface(1.01325) && b >= 2.9);
    const ms = domaineY(ech, 'pctMSurf', [0]);
    assert.ok(ms[0] <= 40 && ms[0] >= 0 && ms[1] === 100);
    assert.ok(domaineY(ech, 'pctMSurf', [1])[1] >= 120);
    const g = domaineY(ech, 'pctGF', [0, 1], { gfHaut: 85 });
    assert.ok(g[0] >= -100 && g[1] >= 100);
  });

  test('équilibre en surface et format de valeur', () => {
    assert.ok(Math.abs(equilibreSurface(1.01325) - 0.7511) < 1e-3);
    assert.equal(formatValeur(0.7512, 'pN2'), `0,751${NNBSP}bar`);
    assert.equal(formatValeur(78.4, 'pctGF'), `78${NNBSP}%`);
  });
});

describe('graphiques : couleurs des compartiments', () => {
  test('oklchVersHex : blanc, noir, gris neutres', () => {
    assert.equal(oklchVersHex(1, 0, 0), '#ffffff');
    assert.equal(oklchVersHex(0, 0, 0), '#000000');
    const g = oklchVersHex(0.6, 0, 120);
    assert.equal(g.slice(1, 3), g.slice(3, 5));
  });

  test('16 couleurs distinctes, contraste ≥ 3:1 sur la carte en clair et en sombre', () => {
    for (const [theme, fond] of [['clair', '#ffffff'], ['sombre', '#0c2232']]) {
      const c = Array.from({ length: 16 }, (_, i) => couleurCompartiment(i, theme));
      assert.equal(new Set(c).size, 16);
      for (const x of c) {
        assert.match(x, /^#[0-9a-f]{6}$/);
        assert.ok(contraste(x, fond) >= 3, `${theme} ${x} : ${contraste(x, fond).toFixed(2)}`);
      }
    }
  });

  test('feuille de style des variables --c1…--c16 en clair et en sombre', () => {
    const css = cssCouleursCompartiments();
    assert.match(css, /--c1:#[0-9a-f]{6};/);
    assert.match(css, /--c16:#[0-9a-f]{6};/);
    assert.match(css, /prefers-color-scheme: dark/);
  });
});

describe('tableau : carte de chaleur et CSV', () => {
  test('interpolation et encre lisible', () => {
    assert.equal(interpolerHex(['#000000', '#ffffff'], 0.5), '#808080');
    assert.equal(interpolerHex(['#000000', '#ffffff'], 2), '#ffffff');
    assert.equal(encrePour('#ffffff'), '#0a1622');
    assert.equal(encrePour('#0d2f55'), '#ffffff');
  });

  test('domaines et couleurs selon la grandeur', () => {
    const lignes = [{ pN2: [0.75, 1] }, { pN2: [3, 0.8] }];
    assert.deepEqual(domaineChaleur(lignes, 'pN2'), { type: 'sequentiel', min: 0.75, max: 3, seuil: null });
    assert.equal(domaineChaleur(lignes, 'pctGF').type, 'divergent');
    const d = domaineChaleur(lignes, 'pctMSurf');
    assert.equal(couleurChaleur(120, d).depasse, true);
    assert.equal(couleurChaleur(80, d).depasse, false);
    for (const theme of ['clair', 'sombre']) {
      for (const v of [0, 25, 50, 75, 100, 130]) {
        const c = couleurChaleur(v, d, theme);
        assert.ok(contraste(c.fond, c.encre) >= 4.5, `${theme} ${v} ${c.fond}/${c.encre}`);
      }
    }
    assert.equal(couleurChaleur(NaN, d).fond, 'transparent');
  });

  test('échappement CSV', () => {
    assert.equal(echapperCSV('simple'), 'simple');
    assert.equal(echapperCSV('a;b'), '"a;b"');
    assert.equal(echapperCSV('dit "oui"'), '"dit ""oui"""');
    assert.equal(echapperCSV(null), '');
  });

  test('instant compact pour la colonne figée', () => {
    assert.equal(instantCourt(0), '0');
    assert.equal(instantCourt(1.5), '1,5');
    assert.equal(instantCourt(87), '1h27');
    assert.equal(instantCourt(1207), '20h');
  });

  test('CSV pour Excel français : « ; », virgule décimale, BOM facultatif, CRLF', () => {
    const res = planifierFactice({ niveaux: [{ profondeur: 30, duree: 20 }] });
    const csv = genererCSV(res, 'pN2');
    const lignes = csv.trimEnd().split('\r\n');
    assert.equal(lignes.length, res.tableau.length + 1);
    const entete = lignes[0].split(';');
    assert.equal(entete.length, 4 + 16 + 2);
    assert.equal(entete[0], 'Instant (min)');
    assert.equal(entete[4], 'C1 4 min (bar)');
    assert.equal(entete[6], 'C3 12,5 min (bar)');
    const l1 = lignes[1].split(';');
    assert.equal(l1.length, entete.length);
    assert.match(l1[4], /^0,7\d*$/);
    assert.ok(!lignes.slice(1).some((l) => /\d\.\d/.test(l)), 'aucun point décimal');
    assert.ok(genererCSV(res, 'pctGF', { bom: true }).startsWith('﻿Instant'));
    assert.match(genererCSV(res, 'pctMSurf').split('\r\n')[0], /% M surf\./);
    assert.equal(nomFichierCSV({ niveaux: [{ profondeur: 30, duree: 20 }], altitude: 1200 }, 'pN2'), 'paliers-30m-20min-alt1200m-pN2.csv');
  });
});

describe('stockage', () => {
  class FauxStockage {
    constructor() { this.m = new Map(); }
    get length() { return this.m.size; }
    key(i) { return [...this.m.keys()][i] ?? null; }
    getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
    setItem(k, v) { this.m.set(k, String(v)); }
    removeItem(k) { this.m.delete(k); }
  }
  beforeEach(() => { utiliserStockage(undefined); effacer(); });

  test('sans localStorage (Node) : repli en mémoire', () => {
    utiliserStockage(null);
    assert.equal(estPersistant(), false);
    assert.equal(lire('x', 'défaut'), 'défaut');
    assert.equal(ecrire('x', { a: 1 }), true);
    assert.deepEqual(lire('x'), { a: 1 });
  });

  test('clés préfixées, effacement limité à l’application, JSON corrompu ignoré', () => {
    const s = new FauxStockage();
    s.setItem('autre-appli', 'garder');
    utiliserStockage(s);
    assert.equal(estPersistant(), true);
    ecrire('formulaire', { altitude: '850' });
    assert.equal(s.getItem(`${PREFIXE}formulaire`), '{"altitude":"850"}');
    s.setItem(`${PREFIXE}casse`, '{pas du json');
    assert.equal(lire('casse', 'défaut'), 'défaut');
    effacer();
    assert.equal(s.getItem(`${PREFIXE}formulaire`), null);
    assert.equal(s.getItem('autre-appli'), 'garder');
  });

  test('stockage qui lève (quota, navigation privée) : aucune exception', () => {
    const hostile = { getItem() { throw new Error('bloqué'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('x'); }, get length() { throw new Error('x'); }, key() { return null; } };
    utiliserStockage(hostile);
    assert.equal(lire('a', 1), 1);
    assert.equal(ecrire('a', 2), false);
    assert.doesNotThrow(() => effacer());
    assert.equal(ecrire('b', () => 1), false);
  });
});

describe('géolocalisation et élévation', () => {
  test('URL Open-Meteo et lecture de la réponse', () => {
    assert.equal(urlElevation(45.123456, 6.98765), 'https://api.open-meteo.com/v1/elevation?latitude=45.1235&longitude=6.9877');
    assert.equal(lireReponseElevation({ elevation: [1834.0] }), 1834);
    assert.equal(lireReponseElevation({ elevation: [] }), null);
    assert.equal(lireReponseElevation({ error: true, reason: 'x' }), null);
    assert.equal(lireReponseElevation(null), null);
  });

  test('choix de l’altitude : GPS précis, sinon API, sinon GPS imprécis ; négatif ramené à 0', () => {
    assert.equal(choisirAltitude({ altitudeM: 812.4, altitudePrecisionM: 10 }, 790).source, 'gps');
    assert.equal(choisirAltitude({ altitudeM: 812.4, altitudePrecisionM: 10 }, 790).altitude, 812);
    assert.equal(choisirAltitude({ altitudeM: 812, altitudePrecisionM: 80 }, 790).source, 'api');
    assert.equal(choisirAltitude({ altitudeM: null, altitudePrecisionM: null }, 790).altitude, 790);
    assert.equal(choisirAltitude({ altitudeM: 650, altitudePrecisionM: null }, null).source, 'gps');
    assert.equal(choisirAltitude({ altitudeM: null, altitudePrecisionM: null }, null), null);
    const morte = choisirAltitude({ altitudeM: null, altitudePrecisionM: null }, -430);
    assert.equal(morte.altitude, 0);
    assert.match(morte.note, /ramenée à 0/);
  });

  test('refus de la géolocalisation : message français', async () => {
    const geolocation = { getCurrentPosition: (_ok, ko) => ko({ code: 1 }) };
    await assert.rejects(obtenirPosition({ geolocation }), (e) => e.code === 'refus' && /refusé/.test(e.message));
  });

  test('chaîne complète : position sans altitude → API (fetch injecté)', async () => {
    const geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 45.9, longitude: 6.1, accuracy: 20, altitude: null, altitudeAccuracy: null } }) };
    let url;
    const fetchFn = async (u) => { url = u; return { ok: true, json: async () => ({ elevation: [446.6] }) }; };
    const r = await altitudeIci({ geolocation, fetchFn });
    assert.equal(r.altitude, 447);
    assert.equal(r.source, 'api');
    assert.match(url, /latitude=45\.9&longitude=6\.1/);
  });

  test('hors ligne / erreur du service : rejet avec message, GPS imprécis utilisé en secours', async () => {
    await assert.rejects(elevationOpenMeteo(1, 2, { fetchFn: async () => { throw new TypeError('Failed to fetch'); } }), /Pas de connexion/);
    await assert.rejects(elevationOpenMeteo(1, 2, { fetchFn: async () => ({ ok: false }) }), /service d'altitude/);
    const geolocation = { getCurrentPosition: (ok) => ok({ coords: { latitude: 1, longitude: 2, altitude: 300, altitudeAccuracy: 60 } }) };
    const r = await altitudeIci({ geolocation, fetchFn: async () => { throw new Error('réseau'); } });
    assert.equal(r.altitude, 300);
    assert.equal(r.source, 'gps');
  });
});

describe('moteur factice conforme au contrat', () => {
  test('structure de sortie', () => {
    const res = planifierFactice({ ...DEFAUT_FACTICE, niveaux: [{ profondeur: 35, duree: 25 }], consommation: { sac: 20, volume: 12, pression: 200, reserve: 50 } });
    assert.equal(res.ok, true);
    assert.equal(res.compartiments.length, 16);
    assert.ok(res.echantillons.length > 10 && res.echantillons.length <= 2000);
    for (const e of [res.echantillons[0], res.echantillons.at(-1), ...res.tableau]) {
      for (const k of ['pN2', 'pctMAmb', 'pctMSurf', 'pctGF']) assert.equal(e[k].length, 16, k);
      assert.ok(e.directeur >= 1 && e.directeur <= 16);
    }
    for (let i = 1; i < res.echantillons.length; i++) assert.ok(res.echantillons[i].t >= res.echantillons[i - 1].t);
    assert.ok(res.paliers.length > 0);
    for (const k of ['dureeTotale', 'dtr', 'profondeurMax', 'desaturation', 'avion', 'cns', 'otu', 'mod']) assert.equal(typeof res.resume[k], 'number', k);
    assert.ok(res.resume.consommation.litres > 0);
    const f = fenetreTemps(res, 'desat');
    assert.equal(f.mode, 'mixte');
    assert.ok(f.tMax > res.resume.dureeTotale);
  });

  test('paramètres invalides → ok:false et erreurs', () => {
    const r = planifierFactice({ niveaux: [] });
    assert.equal(r.ok, false);
    assert.ok(r.erreurs.length);
  });
});
