# Désatyves

*Calculateur de décompression pédagogique : Bühlmann ZHL-16C avec facteurs de gradient.*

En ligne : https://liliplouf.github.io/cyanotype/plongee/

Application web (statique, sans build, sans dépendance) qui calcule les **paliers** d'une plongée
à l'air ou au nitrox, **multiniveaux**, en **mer** comme en **lac d'altitude**, et montre la
**charge en azote des 16 compartiments** du modèle de Bühlmann à chaque instant, jusqu'à la
désaturation complète. Utilisable sur ordinateur et sur téléphone, mode sombre automatique.

> ⚠️ **Outil pédagogique, pas un outil de plongée.** Ces calculs ne remplacent ni un ordinateur
> de plongée, ni des tables officielles, ni une formation. Un modèle de décompression ne
> garantit jamais l'absence d'accident : fatigue, froid, effort, déshydratation, âge, foramen
> ovale perméable… ne sont pas pris en compte. **Ne planifiez jamais une plongée réelle avec ce
> seul outil.**

## Fonctionnalités

- **Plongée** : un ou plusieurs niveaux (profondeur, durée), air ou nitrox (22 à 100 % d'O₂),
  durée comptée depuis l'immersion (convention française) ou non.
- **Lieu** : altitude de la surface de l'eau (saisie ou bouton « Ma position » : géolocalisation
  puis altitude du terrain via Open-Meteo), eau de mer ou eau douce.
- **Consommation** (facultative) : bouteille, pression, réserve, consommation en surface (SAC) ;
  gaz restant estimé et alerte si la réserve est entamée.
- **Réglages avancés** : facteurs de gradient (préréglages 100/100 à 20/60 ou personnalisés),
  vitesses de descente et de remontée, palier de sécurité, dernier palier à 3 ou 6 m, PpO₂
  maximales, jusqu'à 3 gaz de déco, **plongée successive** (plongée précédente + intervalle),
  **acclimatation** après une arrivée récente en altitude, seuil de désaturation.
- **Résultat** : paliers en gros caractères, DTR, durée totale, NDL, désaturation, délai
  **avion / col**, CNS et OTU, gaz restant, alertes (MOD dépassée, > 40 m à l'air, > 60 m,
  remontée trop rapide, plafond franchi, toxicité de l'oxygène…), petit profil de plongée avec
  le plafond.
- **Tableau** des 16 compartiments aux instants clés (fin de descente, paliers, sortie,
  surface +10 min … +48 h, désaturation) en carte de chaleur, compartiment directeur encadré,
  **export CSV** pour Excel en français.
- **Courbes** (SVG fait main) : toutes les courbes superposées sur le profil de profondeur, ou un
  petit graphique par compartiment ; quatre grandeurs au choix ; info-bulle au survol, au toucher
  et au clavier ; durée affichée « plongée », « jusqu'à désaturation » ou, pour une plongée
  successive, « avec la plongée précédente » (chaque plongée sur une partie linéaire de l'axe,
  intervalle et surface compressés).
- Réglages mémorisés dans le navigateur (localStorage) ; aucune donnée envoyée ailleurs, hormis
  les coordonnées transmises à Open-Meteo quand on demande « Ma position ».

## Lancement

```sh
./start.sh            # à la racine du dépôt, puis http://localhost:8000/plongee/
PORT=9000 ./start.sh  # autre port
```

Les modules ES natifs exigent d'être servis en HTTP (ouvrir `index.html` depuis le disque ne
fonctionne pas). La géolocalisation n'est disponible qu'en `https://` ou sur `localhost`.
`?factice=1` charge un moteur de démonstration (développement de l'interface).

### Tests

```sh
npm test   # à la racine : toutes les suites, dont tests/plongee-*.test.mjs
```

`tests/plongee-reference.test.mjs` compare le moteur à une **implémentation de référence
indépendante** (intégration numérique pas à pas, sans le code du moteur) sur une douzaine de cas
(air / nitrox, 18–60 m, GF 100/100, 40/85, 30/70, altitude 0 / 1 000 / 2 500 m, eau douce, gaz de
déco, multiniveaux, plongée successive).

## Modèle de calcul (résumé)

Le contrat détaillé (entrées, sorties, conventions) est dans [`SPEC.md`](SPEC.md).

1. **Pressions** : pression de surface en altitude (atmosphère standard)
   `Psurf = 1,01325 × (1 − 2,25577·10⁻⁵ × h)^5,25588` bar ;
   pression ambiante `Pamb = Psurf + prof × ρ × g / 100` (ρ = 1,025 kg/L en mer, 1,000 en eau douce,
   g = 9,80665).
2. **Gaz inspiré** : `Pi = (Pamb − PH₂O) × fN₂`, vapeur d'eau `PH₂O = 0,0627` bar,
   `fN₂ = 0,7902` pour l'air, `1 − fO₂` pour un nitrox. Au départ, les tissus sont à l'équilibre
   avec l'air à `Psurf` : `(Psurf − 0,0627) × 0,7902`.
3. **Échanges d'azote** dans 16 compartiments (demi-vies 4 à 635 min) :
   à profondeur constante (Haldane) `P(t) = Pi + (P₀ − Pi) e^(−kt)`, `k = ln 2 / T½` ;
   à profondeur variable (Schreiner) `P(t) = Pi₀ + R(t − 1/k) − (Pi₀ − P₀ − R/k) e^(−kt)`,
   `R` = vitesse de variation de `Pi`.
4. **Tolérance (M-value)** de Bühlmann ZHL-16C : `M(Pamb) = a + Pamb / b` (coefficients a, b
   publiés). Avec un **facteur de gradient** GF, la tension tolérée est
   `Pamb + GF × (M(Pamb) − Pamb)` ; d'où le **plafond** (pression ambiante minimale tolérée)
   `Pplafond = (P − a·GF) / (GF/b + 1 − GF)`.
5. **Remontée** (méthode de Baker) : si la remontée directe est impossible au GF haut sur le gaz
   fond, le 1er palier est trouvé par une remontée projetée au **GF bas** ; le GF varie ensuite
   linéairement du GF bas (1er palier) au GF haut (surface). Paliers tous les 3 m, en minutes
   entières, au moins 1 min au 1er palier ; on quitte un palier quand le plafond à l'arrivée au
   palier suivant est respecté. Sans palier obligatoire : palier de sécurité (3 min à 5 m).
6. **Désaturation** : en surface, quand chaque compartiment est revenu à moins de 2 % (réglable)
   au-dessus de l'équilibre ; simulation plafonnée à 96 h.
7. **Avion / col** : la valeur principale est la **recommandation usuelle** (DAN) : au moins
   **12 h** après une plongée unique sans palier, **18 h** après plusieurs plongées ou plusieurs
   jours, **24 h** après une plongée avec paliers obligatoires — ou la valeur du modèle si elle est
   plus longue. Le délai « Bühlmann seul » (plafond compatible avec une cabine à 0,75 bar,
   ≈ 2 400 m) est donné en petit : souvent quelques dizaines de minutes, il est théorique et ne
   tient pas compte des microbulles ; il ne doit pas servir de délai.
8. **Oxygène** : `PpO₂ = Pamb × fO₂` ; % CNS par interpolation des limites NOAA
   (720 min à 0,6 bar … 45 min à 1,6 bar), demi-vie de 90 min en surface ; OTU par minute
   `((PpO₂ − 0,5) / 0,5)^(5/6)`.
9. **Consommation** : `SAC × Pamb moyenne × durée` (litres « surface ») ;
   pression restante `P_gonflage − litres / volume`.

## Grandeurs affichées

- **pN₂** : tension (pression partielle) d'azote dans le compartiment, en bar. La ligne
  « équilibre en surface » est la valeur d'un plongeur qui n'a pas plongé, à l'altitude choisie.
- **% M-value surface** : `pN₂ / M(Psurf) × 100`. Au-delà de 100 %, le compartiment dépasserait la
  tolérance de Bühlmann s'il était remonté directement en surface.
- **% M-value ambiante** : `pN₂ / M(Pamb) × 100`, rapporté à la tolérance à la profondeur du
  moment.
- **% gradient** : `(pN₂ − Pamb) / (M(Pamb) − Pamb) × 100` : 0 % = tension égale à la pression
  ambiante, 100 % = M-value. C'est la grandeur que limitent les facteurs de gradient (pendant la
  remontée elle reste sous le GF courant). Négatif : le compartiment se charge encore.
- **Compartiment directeur** : celui qui impose le plafond le plus profond (le plus contraignant
  à cet instant), encadré dans le tableau.
- **Plafond** : profondeur minimale à ne pas franchir vers le haut, calculée avec le GF courant
  (GF bas jusqu'au 1er palier, puis interpolé ; GF haut sans palier et en surface).
- **NDL** : temps restant au niveau (au début du dernier niveau) pendant lequel une remontée
  directe sans palier obligatoire reste possible sur le gaz fond.
- **DTR** : durée totale de remontée, de la fin du fond à la sortie, paliers compris.

## Limites

- Modèle **azote seul** (air et nitrox) : pas d'hélium (trimix), pas de recycleur.
- Pas de modèle de bulles (VPM, RGBM) ; pas de pénalité pour effort, froid, remontée en
  « yo-yo » ou plongées multi-jours (seule la plongée précédente est prise en compte).
- Le délai avion du modèle est théorique : suivez la règle usuelle affichée, ou plus.
- Les conventions (1er compartiment 4 min, ancrage du GF bas au 1er palier, minute minimale au
  1er palier, densité de l'eau de mer 1,025) peuvent donner un palier ou une minute d'écart avec
  d'autres logiciels ; voir `SPEC.md`.
- Profondeur limitée à 100 m dans le formulaire (alerte au-delà de 40 m à l'air et de 60 m) ;
  altitude 0 à 5 000 m.

## Crédits

- A. A. Bühlmann, E. B. Völlm, P. Nussberger, *Tauchmedizin*, Springer, 2002 (ZHL-16C).
- Erik C. Baker, « Clearing up the confusion about “deep stops” » et
  « Understanding M-values » (facteurs de gradient).
- Coefficients croisés avec Subsurface (`core/deco.cpp`) et DecoTengu (`ZH_L16C_GF`).
- Limites d'exposition à l'oxygène : *NOAA Diving Manual* ; OTU : Lambertsen, Hamilton.
- Délais avion : recommandations du Divers Alert Network (DAN, atelier « Flying after
  recreational diving », 2002).
- Altitude du terrain : [Open-Meteo.com](https://open-meteo.com/) — licence
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

## Arborescence

```
plongee/
  index.html, css/plongee.css, js/app.js       interface
  js/formulaire.js, js/format.js               saisie ↔ paramètres, formatage (fonctions pures)
  js/graphiques.js, js/tableau.js              courbes SVG, tableau des charges, CSV
  js/geo.js, js/stockage.js                    altitude (Open-Meteo), stockage local
  js/planificateur.js                          moteur : planifier(params) (voir SPEC.md)
  js/physique.js, js/buhlmann.js               pressions, gaz, ZHL-16C, GF, Haldane, Schreiner
  js/oxygene.js, js/consommation.js            CNS / OTU, consommation
  js/moteur-factice.js                         moteur de démonstration (?factice=1)
  SPEC.md                                      contrat et conventions
tests/plongee-*.test.mjs                       tests (npm test à la racine)
```
