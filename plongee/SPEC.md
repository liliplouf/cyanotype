# Paliers — calculateur de décompression (spécification et contrat d'interface)

Application web statique (HTML + CSS + modules ES natifs, **aucune dépendance, aucun build**),
en français, utilisable sur ordinateur et smartphone. Dossier : `plongee/`.
Servie par `./start.sh` à la racine du dépôt → http://localhost:8000/plongee/
(en ligne après fusion : https://liliplouf.github.io/cyanotype/plongee/).

> ⚠️ Outil pédagogique de planification. Ne remplace ni un ordinateur de plongée, ni des tables
> officielles, ni une formation. Ce message doit être visible dans l'interface.

## Modèle

- **Bühlmann ZHL-16C**, 16 compartiments azote (coefficients a/b ZHL-16C, demi-vies
  4 ; 8 ; 12,5 ; 18,5 ; 27 ; 38,3 ; 54,3 ; 77 ; 109 ; 146 ; 187 ; 239 ; 305 ; 390 ; 498 ; 635 min).
- **Facteurs de gradient** GF bas / GF haut (Baker) : GF bas appliqué au premier palier, GF haut
  à la surface, interpolation linéaire en profondeur entre les deux.
- Équation de **Schreiner** pour les segments à profondeur variable, **Haldane** à profondeur
  constante. Vapeur d'eau alvéolaire : `PH2O = 0,0627 bar`. Fraction d'azote de l'air : `0,7902`.
- **Altitude** : pression atmosphérique de surface
  `Psurf = 1,01325 × (1 − 2,25577e-5 × h)^5,25588` (bar, h en m). Les tissus partent à
  l'équilibre avec `(Psurf − PH2O) × 0,7902`, sauf acclimatation incomplète (voir plus bas).
  La surface ciblée par la remontée est `Psurf` (et non 1,013 bar) : la plongée en altitude
  rallonge naturellement la décompression.
- **Eau** : mer (masse volumique 1,025 kg/L) ou douce (1,000 kg/L).
  `Pamb(prof) = Psurf + prof × ρ × 9,80665 / 100` (bar, prof en m, ρ en kg/L).
- **Paliers** : multiples de `stopIncrement` (3 m), dernier palier `lastStopDepth` (3 ou 6 m),
  durées arrondies à la minute supérieure. Palier de sécurité facultatif (si aucun palier
  obligatoire) : `safetyStop.time` minutes à `safetyStop.depth` m.
- **Désaturation** : en surface, simulation jusqu'à ce que chaque compartiment ait un excès
  `pN2 − pN2équilibre ≤ desatThreshold × pN2équilibre` (défaut 0,02 soit 2 %), plafonnée à 96 h.
- **Avion / montée en altitude** : temps après la sortie avant que le plafond de tous les
  compartiments (avec GF haut) soit compatible avec une pression de cabine de 0,75 bar
  (≈ 2 400 m). Affiché à titre indicatif avec la règle usuelle (12 h / 24 h) en rappel.
- **Oxygène** : PpO2 à chaque instant, % CNS (table NOAA, interpolation) et OTU ; alertes si
  PpO2 > `ppo2Max` (fond) ou > `ppo2MaxDeco` (paliers), si PpO2 < 0,18 bar.
- **Consommation** (facultative) : `conso(segment) = SAC × Pamb_moyenne × durée` (litres
  surface) ; pression restante = `P_gonflage − conso_totale / volume`. Alerte si la réserve
  est entamée. Gaz de déco éventuels : consommation comptée sur une bouteille séparée
  seulement si un volume lui est donné, sinon simplement « litres ».

## Contrat du moteur — `plongee/js/planificateur.js`

```js
import { planifier, PARAMETRES_DEFAUT } from './planificateur.js';
const res = planifier(params);   // fonction pure, synchrone, sans DOM
```

### Entrée `params` (tous les champs ont une valeur par défaut dans `PARAMETRES_DEFAUT`)

```js
{
  niveaux: [{ profondeur: 30, duree: 20 }],   // m, min ; plongée multiniveaux dans l'ordre
  dureeInclutDescente: true,  // convention française : temps au fond compté depuis l'immersion
                              // (s'applique au 1er niveau ; les transitions entre niveaux
                              //  sont comptées dans la durée du niveau d'arrivée)
  gaz: { o2: 0.21 },          // fraction O2 du mélange fond (air = 0.21, nitrox 0.32…) ; N2 = 1 − o2
  gazDeco: [],                // facultatif : [{ o2: 0.50, profondeurBascule: 21 }, …]
  altitude: 0,                // m (altitude de la surface de l'eau)
  eau: 'mer',                 // 'mer' | 'douce'
  vitesseDescente: 20,        // m/min
  vitesseRemontee: 10,        // m/min (jusqu'au 1er palier et entre paliers)
  gfBas: 40, gfHaut: 85,      // %
  stopIncrement: 3,           // m
  lastStopDepth: 3,           // m (3 ou 6)
  safetyStop: { actif: true, profondeur: 5, duree: 3 },
  ppo2Max: 1.4, ppo2MaxDeco: 1.6,
  desatThreshold: 0.02,
  // Plongée successive (facultatif) : la plongée précédente puis l'intervalle de surface
  plongeePrecedente: null,    // { niveaux:[…], gaz:{o2}, intervalle: 120 /* min */ }
  // Acclimatation (facultatif) : arrivée récente en altitude depuis un lieu plus bas
  acclimatation: null,        // { altitudeOrigine: 0, heuresDepuisArrivee: 2 }
  // Consommation (facultatif : null si non renseignée)
  consommation: null,         // { sac: 20 /* L/min */, volume: 12 /* L */, pression: 200, reserve: 50 /* bar */ }
}
```

### Sortie

```js
{
  ok: true,                       // false si paramètres invalides (erreurs non vide)
  erreurs: ['…'],                 // messages français, pour l'utilisateur
  alertes: [{ niveau: 'info'|'attention'|'danger', message: '…' }],
  psurf: 0.899,                   // bar, pression de surface à l'altitude
  compartiments: [{ n: 1, demiVie: 4, a: 1.2599, b: 0.5050 }, …16],
  // Phases (pour légende / frise)
  phases: [{ type: 'descente'|'fond'|'transition'|'remontee'|'palier'|'surface',
             debut: 0, fin: 1.5, profDebut: 0, profFin: 30, gaz: 'Air', libelle: 'Descente vers 30 m' }],
  paliers: [{ profondeur: 6, duree: 2, debut: 23.4, gaz: 'Air', securite: false }],
  // Série temporelle dense pour les courbes (pas ≤ 0,25 min sous l'eau, adaptatif en surface,
  // ≤ 2 000 points au total). t en minutes depuis l'immersion de CETTE plongée
  // (la plongée précédente et l'intervalle éventuels ont des t négatifs).
  echantillons: [{
    t: 12.5, profondeur: 30, pamb: 3.91, phase: 'fond',
    pN2: [16 nombres, bar],
    pctMAmb: [16],   // pN2 / M-value à la pression ambiante courante × 100
    pctMSurf: [16],  // pN2 / M-value à Psurf (pression de surface à l'altitude) × 100
    pctGF: [16],     // (pN2 − pamb) / (M(pamb) − pamb) × 100, négatif si sous-saturé
    plafond: 4.2,    // m (0 si aucun), plafond avec le GF courant
    directeur: 3,    // n° (1–16) du compartiment directeur
    ppo2: 1.04,
  }, …],
  // Lignes du tableau : instants clés
  tableau: [{ t, libelle: 'Fin de descente', profondeur, phase, pN2:[16], pctMAmb:[16], pctMSurf:[16], pctGF:[16], plafond, directeur }],
  // Instants clés au minimum : début (état initial), fin de descente, fin de chaque niveau,
  // arrivée au 1er palier, début et fin de chaque palier, sortie, puis en surface
  // +10 min, +30 min, +1 h, +2 h, +4 h, +6 h, +12 h, +24 h, +48 h (si avant désaturation)
  // et la désaturation complète.
  resume: {
    dureeTotale: 34,          // min, de l'immersion à la sortie (DTR comprise)
    dtr: 6,                   // min, durée totale de remontée depuis la fin du fond
    profondeurMax: 30,
    tempsFond: 20,
    ndl: 12,                  // min restantes sans palier au début du dernier niveau (null si déjà en déco)
    paliersObligatoires: true,
    desaturation: 2820,       // min après la sortie
    avion: 600,               // min après la sortie (cabine 0,75 bar), indicatif
    cns: 8.5, otu: 21,        // %, unités
    mod: 56.6,                // m, profondeur max d'utilisation du gaz fond à ppo2Max
    consommation: null | { litres: 1450, pressionRestante: 79, reserveEntamee: false,
                           parPhase: [{ type, litres }] },
  },
}
```

Fonctions utilitaires exportées (aussi testées) depuis `physique.js` / `buhlmann.js` :
`pressionAltitude(h)`, `pressionAmbiante(prof, psurf, eau)`, `profondeurDepuisPression(p, psurf, eau)`,
`COMPARTIMENTS_ZHL16C`, `haldane(p0, pi, duree, demiVie)`, `schreiner(p0, pi0, r, duree, demiVie)`,
`mValue(a, b, pamb)`, `plafondCompartiment(pN2, a, b, gf)`.

## Interface — `plongee/index.html`, `plongee/css/`, `plongee/js/app.js` etc.

- Saisie : niveaux (profondeur, durée ; ajout / suppression de lignes), gaz (air / nitrox %),
  altitude (défaut 0, bouton « Ma position » → géolocalisation + API d'élévation Open-Meteo
  `https://api.open-meteo.com/v1/elevation?latitude=…&longitude=…`, ou l'altitude GPS si
  fournie), type d'eau, section « Consommation » facultative (volume, pression, réserve, SAC),
  section repliée « Réglages avancés » (GF, vitesses, palier de sécurité, dernier palier,
  gaz de déco, PpO2 max, plongée successive, acclimatation).
- Résultat : résumé (DTR, paliers, durée totale, désaturation, avion, CNS, gaz), alertes,
  profil de plongée.
- Sortie au choix (onglets) :
  1. **Tableau** des charges des 16 compartiments aux instants clés (unité au choix :
     pN2 bar / % M-value surface / % M-value ambiante / % gradient), cellules colorées
     (carte de chaleur), compartiment directeur mis en évidence, export CSV.
  2. **Courbes** : toutes les courbes sur un même graphique (profil de profondeur en fond,
     ligne d'équilibre de surface, sélection des compartiments par cases à cocher, info-bulle
     au survol / toucher, zoom « plongée seule » / « jusqu'à désaturation » avec axe temps
     adapté), ou **un petit graphique par compartiment** (petits multiples).
- Graphiques en SVG faits main (pas de bibliothèque). Mobile d'abord, accessible (labels,
  contraste, clavier), mode sombre automatique. Paramètres mémorisés en localStorage
  (try/catch). Les calculs se relancent à la validation du formulaire.

## Tests

`tests/plongee-*.test.mjs` (node:test), lancés par `npm test` avec le reste du dépôt.
