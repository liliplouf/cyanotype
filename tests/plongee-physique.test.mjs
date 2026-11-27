import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pressionAltitude,
  pressionAmbiante,
  profondeurDepuisPression,
  barParMetre,
  nomGaz,
  fractionN2,
  profondeurMOD,
  equilibreN2,
  PH2O,
  FN2_AIR,
} from '../plongee/js/physique.js';
import {
  COMPARTIMENTS_ZHL16C,
  haldane,
  schreiner,
  mValue,
  plafondCompartiment,
  gfInterpole,
  plafondGlobal,
} from '../plongee/js/buhlmann.js';
import { tauxCNS, tauxOTU, expositionOxygene, decroissanceCNS } from '../plongee/js/oxygene.js';
import { consoSegment, bilanConsommation } from '../plongee/js/consommation.js';

const proche = (x, attendu, tol, msg) => assert.ok(Math.abs(x - attendu) <= tol, `${msg ?? ''} ${x} ≠ ${attendu} ± ${tol}`);

// ───── physique ─────

test("pression d'altitude : 0 m → 1,01325 bar ; 1 000 m ≈ 0,8988 ; 3 000 m ≈ 0,701", () => {
  assert.equal(pressionAltitude(0), 1.01325);
  proche(pressionAltitude(1000), 0.8988, 0.0005);
  proche(pressionAltitude(2000), 0.795, 0.001);
  proche(pressionAltitude(3000), 0.701, 0.001);
  assert.ok(pressionAltitude(-100) > 1.01325);
});

test('pression ambiante et profondeur : mer (1,025 kg/L) et eau douce, inverses l’une de l’autre', () => {
  proche(barParMetre('mer'), 0.10052, 1e-5);
  proche(barParMetre('douce'), 0.0980665, 1e-9);
  proche(pressionAmbiante(10, 1.01325, 'mer'), 2.0185, 1e-4);
  assert.ok(pressionAmbiante(30, 1, 'douce') < pressionAmbiante(30, 1, 'mer'));
  for (const eau of ['mer', 'douce']) {
    for (const d of [0, 3, 17.5, 60]) proche(profondeurDepuisPression(pressionAmbiante(d, 0.8, eau), 0.8, eau), d, 1e-9);
  }
  assert.equal(pressionAmbiante(0, 0.85), 0.85);
});

test('gaz : noms, fraction d’azote, MOD, équilibre', () => {
  assert.equal(nomGaz(0.21), 'Air');
  assert.equal(nomGaz(0.32), 'Nx32');
  assert.equal(nomGaz(0.5), 'Nx50');
  assert.equal(nomGaz(1), 'O2');
  assert.equal(fractionN2(0.21), FN2_AIR);
  proche(fractionN2(0.32), 0.68, 1e-12);
  // MOD de l'air à 1,4 bar au niveau de la mer : (1,4/0,21 − 1,01325) / 0,10052 ≈ 56,2 m
  proche(profondeurMOD(0.21, 1.4, 1.01325, 'mer'), 56.24, 0.05);
  // Nx32 à 1,4 bar ≈ 33,4 m (≈ 33,8 m avec la règle 10 m/bar)
  proche(profondeurMOD(0.32, 1.4, 1.01325, 'mer'), 33.44, 0.05);
  proche(equilibreN2(1.01325), (1.01325 - PH2O) * 0.7902, 1e-12);
});

// ───── Bühlmann ─────

test('coefficients ZHL-16C : 16 compartiments, demi-vies croissantes, valeurs publiées', () => {
  assert.equal(COMPARTIMENTS_ZHL16C.length, 16);
  const demiVies = [4, 8, 12.5, 18.5, 27, 38.3, 54.3, 77, 109, 146, 187, 239, 305, 390, 498, 635];
  assert.deepEqual(
    COMPARTIMENTS_ZHL16C.map((c) => c.demiVie),
    demiVies,
  );
  COMPARTIMENTS_ZHL16C.forEach((c, i) => {
    assert.equal(c.n, i + 1);
    if (i > 0) {
      assert.ok(c.demiVie > COMPARTIMENTS_ZHL16C[i - 1].demiVie);
      assert.ok(c.a < COMPARTIMENTS_ZHL16C[i - 1].a, `a décroissant (${i + 1})`);
      assert.ok(c.b > COMPARTIMENTS_ZHL16C[i - 1].b, `b croissant (${i + 1})`);
    }
  });
  // Compartiment 1 (et non 1b) ; quelques valeurs ZHL-16C caractéristiques (a de la version C).
  assert.deepEqual({ ...COMPARTIMENTS_ZHL16C[0] }, { n: 1, demiVie: 4, a: 1.2599, b: 0.505 });
  assert.equal(COMPARTIMENTS_ZHL16C[4].a, 0.62); // ZHL-16B : 0,6667
  assert.equal(COMPARTIMENTS_ZHL16C[7].a, 0.4); // ZHL-16B : 0,4701
  assert.equal(COMPARTIMENTS_ZHL16C[15].a, 0.2327);
  assert.equal(COMPARTIMENTS_ZHL16C[15].b, 0.9653);
});

test('Haldane : une demi-vie → moitié du chemin, deux → trois quarts', () => {
  proche(haldane(0.75, 3.0, 27, 27), 0.75 + 2.25 / 2, 1e-12);
  proche(haldane(0.75, 3.0, 54, 27), 0.75 + 2.25 * 0.75, 1e-12);
  proche(haldane(2, 0.75, 4, 4), 1.375, 1e-12); // désaturation aussi
  assert.equal(haldane(1.2, 1.2, 100, 5), 1.2);
});

test('Schreiner : r = 0 donne Haldane ; cohérent avec une intégration numérique fine', () => {
  for (const hv of [4, 27, 635]) proche(schreiner(0.8, 2.5, 0, 13, hv), haldane(0.8, 2.5, 13, hv), 1e-12);
  // Descente de 0 à 40 m à 20 m/min : pi(t) = pi0 + r t ; intégration RK4 de dP/dt = k (pi − P).
  const pi0 = (1.01325 - PH2O) * 0.7902;
  const r = 20 * 0.10052 * 0.7902;
  const duree = 2;
  for (const c of COMPARTIMENTS_ZHL16C) {
    const k = Math.LN2 / c.demiVie;
    const f = (t, P) => k * (pi0 + r * t - P);
    let P = pi0;
    const h = 1e-3;
    for (let t = 0; t < duree - 1e-12; t += h) {
      const k1 = f(t, P);
      const k2 = f(t + h / 2, P + (h / 2) * k1);
      const k3 = f(t + h / 2, P + (h / 2) * k2);
      const k4 = f(t + h, P + h * k3);
      P += (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    }
    proche(schreiner(pi0, pi0, r, duree, c.demiVie), P, 1e-9, `compartiment ${c.n}`);
  }
});

test('M-value et plafond : GF 1 → plafond tel que M(plafond) = pN2 ; GF plus bas → plafond plus profond', () => {
  const { a, b } = COMPARTIMENTS_ZHL16C[3];
  proche(mValue(a, b, 1), a + 1 / b, 1e-12);
  const pN2 = 2.2;
  const P1 = plafondCompartiment(pN2, a, b, 1);
  proche(mValue(a, b, P1), pN2, 1e-12);
  const P04 = plafondCompartiment(pN2, a, b, 0.4);
  assert.ok(P04 > P1);
  // définition GF : pN2 = P + GF (M(P) − P)
  proche(P04 + 0.4 * (mValue(a, b, P04) - P04), pN2, 1e-12);
  // interpolation des GF
  assert.equal(gfInterpole(12, 9, 0.4, 0.85), 0.4);
  assert.equal(gfInterpole(0, 9, 0.4, 0.85), 0.85);
  proche(gfInterpole(4.5, 9, 0.4, 0.85), 0.625, 1e-12);
  assert.equal(gfInterpole(3, 0, 0.4, 0.85), 0.85);
  // plafond global : compartiment directeur
  const tissus = new Array(16).fill(0.75);
  tissus[2] = 2.4;
  assert.equal(plafondGlobal(tissus, 0.85).directeur, 3);
});

// ───── oxygène ─────

test('CNS (NOAA) et OTU : 30 min à 1,4 bar → 20 % et ≈ 49 OTU', () => {
  const ex = expositionOxygene(1.4, 1.4, 30);
  proche(ex.cns, 20, 1e-9);
  proche(ex.otu, 30 * Math.pow(0.9 / 0.5, 5 / 6), 1e-9);
  proche(ex.otu, 48.96, 0.05);
  assert.equal(tauxCNS(0.45), 0);
  assert.equal(tauxOTU(0.5), 0);
  proche(tauxCNS(1.0), 100 / 300, 1e-12);
  proche(tauxCNS(1.45), 100 / 135, 1e-12); // interpolation entre 150 et 120 min
  proche(tauxCNS(1.6), 100 / 45, 1e-12);
  assert.ok(tauxCNS(1.7) > tauxCNS(1.6));
  // Rampe linéaire de PpO2 : forme fermée de l'OTU (Baker) ∫((p − 0,5)/0,5)^(5/6) dt
  const p0 = 0.6;
  const p1 = 1.6;
  const t = 10;
  const ferme = ((3 / 11) * t / (p1 - p0)) * (Math.pow((p1 - 0.5) / 0.5, 11 / 6) - Math.pow((p0 - 0.5) / 0.5, 11 / 6));
  proche(expositionOxygene(p0, p1, t).otu, ferme, 1e-4);
  proche(decroissanceCNS(40, 90), 20, 1e-12);
});

// ───── consommation ─────

test('consommation : SAC × Pamb moyenne × durée, calcul à la main', () => {
  // 20 L/min, 20 min à 4 bar → 1 600 L ; descente de 1 à 4 bar en 1,5 min → 20 × 2,5 × 1,5 = 75 L
  assert.equal(consoSegment(20, 4, 4, 20), 1600);
  assert.equal(consoSegment(20, 1, 4, 1.5), 75);
  const g = { o2: 0.21, nom: 'Air', indexDeco: -1 };
  const n50 = { o2: 0.5, nom: 'Nx50', indexDeco: 0 };
  const b = bilanConsommation(
    [
      { type: 'descente', pambDebut: 1, pambFin: 4, duree: 1.5, gaz: g },
      { type: 'fond', pambDebut: 4, pambFin: 4, duree: 20, gaz: g },
      { type: 'palier', pambDebut: 1.6, pambFin: 1.6, duree: 10, gaz: n50 },
    ],
    { sac: 20, volume: 12, pression: 200, reserve: 50 },
    [{ o2: 0.5, volume: 7, pression: 200, reserve: 50 }],
  );
  assert.equal(b.litres, 75 + 1600 + 320);
  assert.equal(b.litresFond, 1675);
  proche(b.pressionRestante, 200 - 1675 / 12, 1e-9);
  assert.equal(b.reserveEntamee, false);
  const deco = b.parGaz.find((x) => x.gaz === 'Nx50');
  proche(deco.pressionRestante, 200 - 320 / 7, 1e-9);
  assert.deepEqual(
    b.parPhase.map((x) => x.type),
    ['descente', 'fond', 'palier'],
  );
});
