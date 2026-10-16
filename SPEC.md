# Cyanotype Exposure Calculator — Spécification technique (contrat entre modules)

Application web statique, **sans build**, en ES modules natifs. Langue de l'interface : **français**.
Lancement : `python3 -m http.server 8000` dans le dossier puis http://localhost:8000 (script `start.sh`).
Aucune dépendance npm à l'exécution. Pas de framework. Pas de clé API.

## Arborescence

```
index.html              (UI)        — agent UI
css/style.css           (UI)        — agent UI
js/app.js               (UI)        — agent UI : orchestration, état, DOM, minuteur, graphique
js/solar.js             (moteur)    — agent Moteur : position solaire
js/exposure.js          (moteur)    — agent Moteur : modèle UV + temps de pose
js/factors.js           (moteur)    — agent Moteur : catalogues de facteurs (chimie, papier, verre…)
js/weather.js           (données)   — agent Données : Open-Meteo prévisions + géocodage
js/geo.js               (données)   — agent Données : géolocalisation navigateur
js/storage.js           (données)   — agent Données : persistance localStorage (réglages, calibrations, journal)
tests/*.test.mjs        tests node (`npm test`) — chaque agent teste ses modules
start.sh, README.md
```

Tous les modules sont des ES modules purs (`export function …`), importables dans le navigateur
ET dans Node 22 (pas d'accès à `window`/`document` au chargement du module, sauf app.js).

---

## 1. `js/solar.js`

```js
export function solarPosition(date: Date, lat: number, lon: number)
  -> { elevation: number /*degrés, réfraction incluse*/, azimuth: number /*degrés depuis N, sens horaire*/,
       zenith: number /*degrés*/ }
export function sunTimes(date: Date, lat: number, lon: number)
  -> { sunrise: Date|null, sunset: Date|null, solarNoon: Date, maxElevation: number }
  // null si soleil de minuit / nuit polaire
```
Algorithme NOAA (précision < 0.1°). `date` est un instant UTC (objet Date).

## 2. `js/factors.js`

Catalogues exportés : tableaux d'objets `{ id: string, label: string /*fr*/, factor: number, description: string /*fr*/ }`.
`factor` est **multiplicatif sur le temps** (>1 = pose plus longue).

```js
export const CHEMISTRY      // 'classic' (réf 1.0), 'classic_double', 'new_ware' (~0.25–0.35), 'rex', 'classic_oxalic', ...
export const SUBSTRATE      // 'cotton_paper' (1.0), 'watercolor_cellulose', 'fabric_cotton', 'wood', 'glass_gelatin', ...
export const COATING        // 'single' (1.0), 'double', 'thin'
export const HUMIDITY_STATE // 'dry' (1.0), 'humidified' (papier ré-humidifié avant pose : plus rapide, ~0.7)
export const GLASS          // 'none' (1.0), 'float_glass' (~1.15–1.25), 'low_iron', 'acrylic_uvt', 'acrylic_standard' (bloque UV ~3+), 'borosilicate'
export const NEGATIVE       // 'photogram' (objets, 1.0), 'digital_transparency' (~1.3–1.6), 'inkjet_pictorico', 'film_negative'
export const LIGHT_SOURCE   // { id, label, kind: 'sun'|'lamp', ... } : 'sun', 'uv_led_365', 'uv_led_395', 'blacklight_tubes', 'metal_halide', 'uv_box_generic'
export const RESULT_GOAL    // 'standard' (1.0), 'deep' (bleus profonds ~1.3, pour virage), 'light' (~0.8), 'toning_planned' (surexposition pour virage ~1.5)
export function getById(list, id) -> item | undefined
```

## 3. `js/exposure.js`

Modèle physique : l'insolation du cyanotype dépend surtout des **UV-A (320–400 nm)**, pas de l'indice UV érythémal.

```js
// Irradiance UV-A relative en ciel clair (1.0 = soleil au zénith, niveau mer).
export function clearSkyUVA(elevationDeg: number, altitudeM = 0) -> number  // 0 si soleil sous l'horizon

// Facteur de transmission nuageuse (0..1) pour UV-A, cloudCover en %. Utiliser une loi type
// 1 - 0.56*(c)^? calibrée pour UV ; documenter la source dans un commentaire.
export function cloudTransmission(cloudCoverPct: number) -> number

// Irradiance UV-A relative effective, combinant tout. Si `uvIndex` et `uvIndexClearSky` (Open-Meteo)
// sont fournis, les utiliser pour corriger le ciel (ratio uv/uvClear) plutôt que cloudCover seul.
export function effectiveUVA({ elevationDeg, altitudeM, cloudCoverPct, uvIndex, uvIndexClearSky, albedo /*0..1, ex neige 0.8*/ })
  -> number

// Facteur combiné des réglages (produit des facteurs catalogues + calibration personnelle).
export function settingsFactor(settings) -> number
// settings = { chemistry, substrate, coating, humidityState, glass, negative, resultGoal, calibrationFactor /*défaut 1*/ }

// Temps de pose au SOLEIL pour une irradiance constante. Référence :
// cyanotype classique, papier coton, contact sans verre, photogramme, uva relatif = 1.0  =>  REFERENCE_MINUTES (≈ 8 min).
export const REFERENCE_MINUTES
export function exposureMinutesConstant(uvaRel: number, settings) -> number  // Infinity si uvaRel ~ 0

// Temps de pose INTÉGRÉ : démarre à `start`, accumule la dose minute par minute avec l'irradiance
// qui change (soleil qui bouge + météo horaire interpolée). Renvoie quand la dose cible est atteinte.
// `weatherAt(date) -> { cloudCoverPct, uvIndex, uvIndexClearSky } | null` (fourni par l'appelant, peut renvoyer null)
export function integratedExposure({ start: Date, lat, lon, altitudeM, settings, weatherAt, albedo, maxMinutes = 360 })
  -> { minutes: number, end: Date|null, reachable: boolean, doseCurve: Array<{t: Date, uva: number, cumulative: number /*0..1 de la dose cible*/}> }

// Courbe de la journée : pour chaque pas (défaut 15 min) entre lever et coucher, le temps de pose intégré
// si on commençait à cet instant. Sert au graphique et à "meilleur moment".
export function dayProfile({ day: Date, lat, lon, altitudeM, settings, weatherAt, albedo, stepMinutes = 15 })
  -> Array<{ t: Date, elevation: number, uva: number, minutes: number /*Infinity si inatteignable*/ }>

// Lampe UV : temps = refMinutes(source) * (distanceRef/distance)^2 * (puissanceRef/puissance) * settingsFactor
export function lampExposureMinutes({ sourceId, powerW, distanceCm, settings }) -> number

// Conseil qualitatif en français selon les conditions (ex. "Soleil trop bas…", "Ciel couvert : prévoir…").
export function adviceFor({ elevationDeg, cloudCoverPct, minutes, humidityPct, temperatureC }) -> string[]
```

## 4. `js/weather.js` — Open-Meteo (gratuit, sans clé, CORS OK)

```js
// https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&hourly=cloud_cover,uv_index,uv_index_clear_sky,
//   temperature_2m,relative_humidity_2m,shortwave_radiation,weather_code&current=...&timezone=auto&forecast_days=3
export async function fetchForecast(lat, lon, { fetchImpl = fetch } = {})
  -> { elevation: number /*m*/, timezone: string, utcOffsetSeconds: number,
       current: { time: Date, cloudCoverPct, uvIndex, temperatureC, humidityPct, weatherCode },
       hourly: Array<{ time: Date, cloudCoverPct, uvIndex, uvIndexClearSky, temperatureC, humidityPct, shortwaveWm2, weatherCode }> }
  // Les heures renvoyées en heure locale du lieu doivent être converties en vrais instants UTC (Date)
  // via utcOffsetSeconds (utiliser timeformat=unixtime pour éviter toute ambiguïté).

// Interpolation linéaire entre heures → fonction utilisable par exposure.integratedExposure
export function makeWeatherAt(forecast) -> (date: Date) => ({ cloudCoverPct, uvIndex, uvIndexClearSky }) | null

// Géocodage : https://geocoding-api.open-meteo.com/v1/search?name=..&count=5&language=fr
export async function searchPlace(query, { fetchImpl = fetch } = {})
  -> Array<{ name, admin1, country, lat, lon, elevation, label /* "Arles, Provence-Alpes-Côte d'Azur, France" */ }>

export function weatherCodeLabel(code) -> { label: string /*fr*/, icon: string /*emoji*/ }

// Cache mémoire + localStorage optionnel (10 min) pour éviter de re-télécharger.
```
Erreurs : lever `Error` avec message français clair. Doit fonctionner hors ligne → l'UI bascule en saisie manuelle.

## 5. `js/geo.js`

```js
export function getBrowserPosition({ timeoutMs = 10000 } = {}) -> Promise<{ lat, lon, accuracyM }>
  // rejette avec message français (permission refusée, indisponible, délai)
```

## 6. `js/storage.js`

```js
export function loadSettings() -> object|null ; export function saveSettings(obj)
export function listCalibrations() -> Array<{ id, name, factor, createdAt, notes }>
export function saveCalibration({ name, factor, notes }) -> calibration ; export function deleteCalibration(id)
// Calibration : l'utilisateur a obtenu un bon tirage en `actualMinutes` alors que le calcul prévoyait `predictedMinutes`
export function computeCalibrationFactor(actualMinutes, predictedMinutes) -> number
export function listJournal() -> Array<entry> ; export function addJournalEntry(entry) ; export function deleteJournalEntry(id)
// entry = { id, date, place, settings, predictedMinutes, actualMinutes, result: 'under'|'good'|'over', notes }
export function exportAll() -> string (JSON) ; export function importAll(json)
```
Tolérer l'absence de localStorage (Node, mode privé) : fallback mémoire, jamais d'exception.

## 7. UI (`index.html`, `css/style.css`, `js/app.js`)

Sections :
1. **Lieu** : bouton « Ma position », recherche de ville (autocomplétion via searchPlace), saisie lat/lon/altitude manuelle, affichage du lieu choisi.
2. **Conditions** : date + heure de début (défaut maintenant), météo chargée automatiquement (nuages %, UV, température, humidité, icône), possibilité de forcer manuellement la couverture nuageuse / UV ; option neige/sol clair (albédo). Mode hors ligne.
3. **Source lumineuse** : soleil ou lampe (puissance W, distance cm).
4. **Procédé** : chimie, support, couche, humidité du papier, verre, négatif, rendu souhaité, calibration personnelle (liste déroulante).
5. **Résultat** (gros chiffre) : temps de pose en mm:ss, heure de fin, élévation solaire, irradiance relative, fourchette (−20 %/+25 %), conseils. Bouton « Démarrer le minuteur ».
6. **Graphique de la journée** (SVG fait main, pas de lib) : temps de pose selon l'heure de départ + élévation solaire + nuages ; marqueur « maintenant » ; « meilleur créneau » mis en évidence.
7. **Minuteur** : compte à rebours basé sur la dose intégrée, barre de progression, bip (WebAudio) + notification à la fin, pause/reprise.
8. **Bande test** : génère un plan de bande test (ex. 5 bandes à −50 %, −25 %, 0, +25 %, +50 %) avec le temps à découvrir pour chaque bande.
9. **Calibration & journal** : après un tirage, saisir le temps réellement utilisé / résultat → crée une calibration ; historique ; export/import JSON.

Design : esthétique « bleu de Prusse » (cyanotype), sobre, responsive mobile (usage dehors au soleil → contraste fort, gros boutons), mode sombre via prefers-color-scheme.
Toujours recalculer en direct quand un champ change. Sauvegarder les réglages.

## 8. Besoins utilisateur (cadrage du 16/10/2026) — à prendre en compte pour la V2

| Thème | Réponse | Conséquence |
|---|---|---|
| Chimie | Kit du commerce (formule inconnue) | La calibration personnelle est centrale ; préréglages « kit du commerce » ; guide de bande test. |
| Lumière | Soleil uniquement | Le calcul météo/position est le cœur ; le mode lampe reste secondaire. |
| Supports | Papier + négatif numérique | Valeurs par défaut : papier coton + négatif numérique sur transparent ; aide aux négatifs numériques. |
| Usage | Téléphone, en extérieur | Application installable hors ligne (PWA, service worker), gros boutons, fort contraste, minuteur fiable écran verrouillé. |
| Châssis | à préciser | Facteur de verre par défaut. |
| Calibration | à préciser | Guide pas à pas ou charte de gris. |

## 9. Tests

`npm test` (= `node scripts/run-tests.mjs [étiquette]`) lance toutes les suites `tests/*.test.mjs`,
affiche un résumé et écrit `reports/test-report.json`, `reports/suites.json`, `reports/test-history.json`
(historique lu par le tableau de bord d'avancement). Note : sous Node 22, `node --test tests/` ne fonctionne pas ;
utiliser `node --test` sans argument ou `npm test`.
