#!/usr/bin/env node
// Génère les jeux de données du tableau de bord « Comment marche le calcul »
// en appelant directement le moteur (js/exposure.js, js/solar.js, js/factors.js).
// Sortie : reports/moteur/*.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clearSkyUVA, cloudTransmission, effectiveUVA, settingsFactor, REFERENCE_MINUTES,
  exposureMinutesConstant, integratedExposure, dayProfile,
} from '../js/exposure.js';
import { solarPosition } from '../js/solar.js';
import * as F from '../js/factors.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'reports', 'moteur');
mkdirSync(out, { recursive: true });
const write = (name, rows) => writeFileSync(join(out, `${name}.json`), JSON.stringify(rows, null, 2));
const r = (x, d = 3) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

// Lieu et réglages de l'exemple : Paris, réglages par défaut de l'application.
const PLACE = { nom: 'Paris', lat: 48.8566, lon: 2.3522, altitudeM: 35 };
const SETTINGS = { chemistry: 'classic', substrate: 'cotton_paper', coating: 'single', humidityState: 'dry',
  glass: 'none', negative: 'digital_transparency', resultGoal: 'standard', calibrationFactor: 1 };
const localTime = (d) => d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
const parisDate = (iso) => new Date(iso); // les instants sont donnés en UTC explicite

// 1. UV-A en ciel clair selon la hauteur du soleil (direct + diffus), et temps de pose de référence.
//    Mêmes constantes que js/exposure.js (UVA_TAU = 0,7 ; UVA_DIFFUSE_DOWN = 0,6 ; Kasten-Young).
const RAD = Math.PI / 180;
const airMass = (z) => 1 / (Math.cos(z * RAD) + 0.50572 * (96.07995 - z) ** -1.6364);
const parts = (h) => {
  const t = Math.exp(-0.7 * airMass(90 - h));
  return { direct: Math.sin(h * RAD) * t, diffus: Math.sin(h * RAD) * 0.6 * (1 - t) };
};
const z = parts(90);
const zTot = z.direct + z.diffus;
const uvaElev = [];
for (let h = 2; h <= 90; h += 2) {
  const p = parts(h);
  const total = clearSkyUVA(h, 0);
  uvaElev.push({
    elevation: h,
    uva: r(total),
    direct: r(p.direct / zTot),
    diffus: r(p.diffus / zTot),
    minutes_reference: r(exposureMinutesConstant(total, {}), 1),
  });
}
write('uva-elevation', uvaElev);

// 2. Nuages : transmission et allongement du temps de pose.
const nuages = [];
for (let c = 0; c <= 100; c += 5) {
  const t = cloudTransmission(c);
  nuages.push({ couverture: c, transmission: r(t), allongement: r(1 / t, 2) });
}
write('nuages', nuages);

// 3. Trois journées à Paris, ciel clair, réglages par défaut : temps de pose selon l'heure de départ.
const days = [
  { jour: '21 juin', iso: '2026-06-21T12:00:00Z' },
  { jour: '16 octobre', iso: '2026-10-16T12:00:00Z' },
  { jour: '21 décembre', iso: '2026-12-21T12:00:00Z' },
];
const journees = [];
for (const d of days) {
  const prof = dayProfile({ day: parisDate(d.iso), lat: PLACE.lat, lon: PLACE.lon, altitudeM: PLACE.altitudeM,
    settings: SETTINGS, weatherAt: () => null, stepMinutes: 15 });
  for (const p of prof) {
    const parts = localTime(p.t).split(':').map(Number);
    journees.push({
      jour: d.jour,
      heure: localTime(p.t),
      heure_decimale: r(parts[0] + parts[1] / 60, 2),
      elevation: r(p.elevation, 1),
      uva: r(p.uva),
      minutes: Number.isFinite(p.minutes) ? r(p.minutes, 1) : null,
    });
  }
}
write('journees', journees);

// 4. Catalogue des facteurs (multiplicateurs du temps de pose).
const cats = [
  ['Chimie', F.CHEMISTRY], ['Support', F.SUBSTRATE], ['Couche', F.COATING], ['Humidité du papier', F.HUMIDITY_STATE],
  ['Verre', F.GLASS], ['Négatif', F.NEGATIVE], ['Rendu souhaité', F.RESULT_GOAL],
];
const facteurs = [];
for (const [categorie, list] of cats) {
  for (const it of list) facteurs.push({ id: it.id, categorie, reglage: it.label, facteur: it.factor, description: it.description });
}
write('facteurs', facteurs);

// 5. Exemple pas à pas : Paris, 16 octobre 2026, départ 13:00 (11:00 UTC), 40 % de nuages.
const start = new Date('2026-10-16T11:00:00Z');
const CLOUD = 40;
const pos = solarPosition(start, PLACE.lat, PLACE.lon);
const clear = clearSkyUVA(pos.elevation, PLACE.altitudeM);
const tCloud = cloudTransmission(CLOUD);
const uvaEff = effectiveUVA({ elevationDeg: pos.elevation, altitudeM: PLACE.altitudeM, cloudCoverPct: CLOUD });
const sf = settingsFactor(SETTINGS);
const dose = REFERENCE_MINUTES * sf;
const tConst = exposureMinutesConstant(uvaEff, SETTINGS);
const integ = integratedExposure({ start, lat: PLACE.lat, lon: PLACE.lon, altitudeM: PLACE.altitudeM, settings: SETTINGS,
  weatherAt: () => ({ cloudCoverPct: CLOUD, uvIndex: null, uvIndexClearSky: null }) });
const exemple = [
  { ordre: 1, etape: 'Hauteur du soleil', valeur: r(pos.elevation, 1), unite: '°', calcul: 'Position solaire NOAA pour Paris, 16/10 à 13:00' },
  { ordre: 2, etape: 'UV-A en ciel clair', valeur: r(clear), unite: '× zénith', calcul: 'Direct + diffus après traversée de l’atmosphère, +6 %/km d’altitude' },
  { ordre: 3, etape: 'Transmission des nuages', valeur: r(tCloud), unite: '', calcul: `1 − 0,56 × (${CLOUD} %)^2,5` },
  { ordre: 4, etape: 'UV-A effectif', valeur: r(uvaEff), unite: '× zénith', calcul: 'UV-A ciel clair × transmission des nuages' },
  { ordre: 5, etape: 'Facteur des réglages', valeur: r(sf, 2), unite: '×', calcul: 'Produit des facteurs : papier coton 1 × négatif numérique 1,45 × autres 1' },
  { ordre: 6, etape: 'Dose cible', valeur: r(dose, 1), unite: 'min au zénith', calcul: '8 min de référence × facteur des réglages' },
  { ordre: 7, etape: 'Temps si le soleil restait fixe', valeur: r(tConst, 1), unite: 'min', calcul: 'Dose cible ÷ UV-A effectif' },
  { ordre: 8, etape: 'Temps intégré (affiché)', valeur: r(integ.minutes, 1), unite: 'min', calcul: 'Dose cumulée minute par minute avec le soleil qui bouge' },
];
write('exemple', exemple);

// Cascade : comment on passe de 8 min au temps affiché (version « soleil fixe »).
const cascade = [
  { ordre: 1, etape: 'Référence', minutes: r(REFERENCE_MINUTES, 2) },
  { ordre: 2, etape: '× négatif numérique', minutes: r(dose, 2) },
  { ordre: 3, etape: '÷ hauteur du soleil', minutes: r(dose / clear, 2) },
  { ordre: 4, etape: '÷ nuages 40 %', minutes: r(dose / clear / tCloud, 2) },
];
write('cascade', cascade);

// 6. Intégration : départ à 16:30 (14:30 UTC) le 16/10, ciel clair. Le soleil baisse pendant la pose.
const late = new Date('2026-10-16T14:30:00Z');
const lateInt = integratedExposure({ start: late, lat: PLACE.lat, lon: PLACE.lon, altitudeM: PLACE.altitudeM,
  settings: SETTINGS, weatherAt: () => null });
const latePos = solarPosition(late, PLACE.lat, PLACE.lon);
const lateConst = exposureMinutesConstant(clearSkyUVA(latePos.elevation, PLACE.altitudeM), SETTINGS);
const integration = lateInt.doseCurve.map((p, i) => ({
  minute: i,
  heure: localTime(p.t),
  uva: r(p.uva),
  dose_pct: r(p.cumulative * 100, 1),
}));
write('integration', integration);
write('integration-resume', [
  { cas: 'Soleil supposé fixe', minutes: r(lateConst, 1) },
  { cas: 'Dose intégrée (affiché)', minutes: r(lateInt.minutes, 1) },
]);

// 7. Constantes du modèle.
write('constantes', [
  { constante: 'Temps de référence', valeur: REFERENCE_MINUTES, unite: 'min', role: 'Cyanotype classique, papier coton, sans verre, soleil au zénith, ciel clair.' },
  { constante: 'Épaisseur optique UV-A', valeur: 0.7, unite: '', role: 'Atténuation par l’air (Rayleigh ≈ 0,5) et les aérosols (≈ 0,2).' },
  { constante: 'Part du diffus vers le sol', valeur: 0.6, unite: '', role: 'Le ciel bleu fournit 30 à 40 % des UV-A : on peut insoler à l’ombre.' },
  { constante: 'Gain d’altitude', valeur: 0.06, unite: 'par km', role: 'Moins d’air au-dessus de soi, plus d’UV-A (plafonné à 6 km).' },
  { constante: 'Coefficient des nuages a', valeur: 0.56, unite: '', role: 'Ciel couvert à 100 % : il reste 44 % des UV-A.' },
  { constante: 'Exposant des nuages b', valeur: 2.5, unite: '', role: 'Quelques nuages épars atténuent peu.' },
  { constante: 'Rapport UV minimum', valeur: 0.03, unite: '', role: 'Plancher du rapport UV / UV ciel clair d’Open-Meteo.' },
  { constante: 'Rapport UV maximum', valeur: 1.15, unite: '', role: 'Renforcement possible au bord des cumulus.' },
  { constante: 'Rétrodiffusion du ciel', valeur: 0.2, unite: '', role: 'Gain dû à un sol clair : neige fraîche ≈ +19 %.' },
]);

console.log('Données écrites dans', out);
