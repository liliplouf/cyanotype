# Cyanoplouf

*Tu insoles, tu ploufes, c'est bleu.*

En ligne : https://liliplouf.github.io/cyanotype/

Application web (statique, sans build, sans dépendance) qui estime le **temps d'exposition d'un
cyanotype** (tirage au bleu de Prusse) selon la **position du soleil**, la **météo prévue**, le
**lieu** (latitude, altitude, sol environnant) et votre **procédé** (chimie, support, couche,
humidité du papier, verre, négatif, rendu souhaité, calibration personnelle).

Pensée pour un usage **sur téléphone, dehors, au soleil** : résultat et minuteur visibles dès
l'ouverture, gros boutons, fort contraste, mode sombre automatique.

## Fonctionnalités

- **Lieu** : « Ma position » (géolocalisation), recherche de ville avec autocomplétion
  (Open-Meteo Geocoding), ou latitude / longitude / altitude saisies à la main.
  Premier lancement : la position est demandée, sinon Paris par défaut.
- **Conditions** : départ « maintenant » ou à une date/heure choisie (dans le fuseau du lieu),
  prévisions horaires Open-Meteo (nuages, indice UV, UV ciel clair, température, humidité),
  saisie manuelle possible (nuages %, UV) et **mode hors ligne** (ciel clair par défaut),
  sol réfléchissant (neige, sable…).
- **Résultat** : temps de pose en gros chiffres (mm:ss), heure de fin, élévation du soleil,
  irradiance UV-A relative, fourchette prudente (−20 % / +25 %), meilleur créneau, conseils.
- **Graphique de la journée** (SVG fait main) : temps de pose selon l'heure de départ,
  élévation solaire, nuages, ligne « maintenant », meilleur créneau ; info-bulle au survol / tap,
  clic (ou Entrée au clavier) pour choisir l'heure de départ.
- **Minuteur à dose intégrée** : le décompte suit la dose UV réellement reçue (le soleil bouge,
  les nuages passent), barre de progression, pause / reprise / annulation, bip, notification,
  vibration, écran maintenu allumé (Wake Lock) quand le navigateur le permet.
- **Bande test** : nombre de bandes et pas (%) réglables, méthode « découvrir » ou « couvrir »
  progressivement, tableau des temps, et minuteur bande test qui bipe à chaque étape.
- **Calibration & journal** : après un tirage, notez le temps réel et le résultat
  (sous / bon / sur) ; créez une **calibration personnelle** à partir d'un bon tirage — idéal
  pour un **kit du commerce dont la formule est inconnue** ; historique, export / import JSON.
- Sources UV artificielles (LED 365 nm, tubes BL, insoleuse…) disponibles en option repliée.

## Lancement

```sh
./start.sh            # http://localhost:8000
PORT=9000 ./start.sh  # autre port
# ou : npm start
```

Le script lance simplement `python3 -m http.server` dans le dossier du projet. Les modules ES
natifs exigent d'être servis en HTTP (ouvrir `index.html` directement depuis le disque ne
fonctionne pas). La géolocalisation n'est disponible qu'en `https://` ou sur `localhost`.

### Tests

```sh
npm test
```

(Node 22 ; lance `scripts/run-tests.mjs`, qui exécute les tests de `tests/*.test.mjs`.)

## Modèle de calcul (résumé)

Le cyanotype est sensible aux **UV-A (320–400 nm)**, pas à l'indice UV « coup de soleil » qui est
dominé par les UV-B.

1. **Position du soleil** : algorithme NOAA (`js/solar.js`), élévation corrigée de la réfraction.
2. **UV-A ciel clair** (`js/exposure.js`) : transmission directe de Beer-Lambert avec la masse
   d'air de Kasten & Young + part diffuse du ciel, normalisée à 1 pour un soleil au zénith au
   niveau de la mer ; gain modéré avec l'altitude (+6 %/km).
3. **Nuages** : si Open-Meteo fournit l'indice UV et l'indice UV ciel clair, leur **rapport** sert
   de transmission du ciel ; sinon loi de type Kasten & Czeplak `1 − 0,56·N^2,5` sur la
   couverture nuageuse. Sol réfléchissant : petit gain lié à l'albédo.
4. **Facteurs du procédé** (`js/factors.js`) : produit de facteurs multiplicatifs sur le temps
   (chimie, support, couche, humidité, verre, négatif, rendu) × calibration personnelle.
   Référence : cyanotype classique, papier coton, une couche, sans verre, photogramme
   → **8 min** pour un UV-A relatif de 1.
5. **Dose intégrée** : la dose cible vaut `8 min × facteurs` ; elle est accumulée minute par
   minute avec le soleil qui se déplace et la météo horaire interpolée. Le temps affiché est
   l'instant où la dose est atteinte (inatteignable si le soleil se couche avant).
6. **Lampes UV** : `temps = tempsRéf × (distance/distanceRéf)² × (puissanceRéf/puissance) × facteurs`.
7. **Calibration** : bon tirage obtenu en `t_réel` quand le calcul prévoyait `t_prévu`
   → facteur personnel `t_réel / t_prévu` (hors calibration déjà active).

## Limites

- Ce sont des **estimations** : papier, kit, épaisseur de couche, négatif et appareil de mesure
  varient énormément. **Faites une bande test**, puis une calibration.
- Le calcul suppose un châssis **à plat** (horizontal). Incliner face au soleil quand il est bas
  raccourcit la pose.
- Les prévisions nuageuses sont horaires et locales : un passage nuageux imprévu allonge la pose
  (le minuteur, lui, ne mesure pas la lumière réelle).
- Prévisions limitées à 3 jours ; au-delà, ciel clair supposé (ou saisie manuelle).
- Hors ligne, le fuseau horaire du lieu n'est pas connu : les heures sont celles de l'appareil.
- Notifications : certains navigateurs mobiles ne les affichent pas sans service worker ; le bip
  et la vibration restent actifs. Gardez la page ouverte pendant la pose.
- Données (réglages, calibrations, journal) stockées **localement** dans le navigateur
  (localStorage) : pensez à exporter le JSON.

## Crédits

- Données météo et géocodage : [Open-Meteo.com](https://open-meteo.com/) — licence
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Gratuit, sans clé API.
- Position solaire : NOAA Global Monitoring Laboratory (algorithme de Meeus).
- Facteurs de procédé : ordres de grandeur tirés de Mike Ware (*Cyanotype*, 1999 ;
  *New Cyanotype*, 1994) et de Christina Z. Anderson (*Cyanotype: The Blueprint in
  Contemporary Practice*, 2019).
- Polices : Fraunces et Inter (Google Fonts, licence OFL).

## Arborescence

```
index.html, css/style.css, js/app.js   interface
js/solar.js, js/exposure.js, js/factors.js   moteur de calcul
js/weather.js, js/geo.js, js/storage.js      données (Open-Meteo, géolocalisation, stockage local)
tests/, scripts/run-tests.mjs                tests (npm test)
start.sh                                     serveur local
```
