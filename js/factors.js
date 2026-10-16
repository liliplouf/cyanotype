// Catalogues de facteurs pour le calcul du temps de pose du cyanotype.
//
// Convention : `factor` est MULTIPLICATIF SUR LE TEMPS (> 1 = pose plus longue).
// Référence (tous facteurs = 1) : cyanotype classique (Herschel), papier 100 % coton,
// une couche, papier sec, contact sans verre, photogramme, rendu standard.
//
// Les valeurs sont des ordres de grandeur tirés de la pratique (Mike Ware, « Cyanotype: the
// history, science and art of photographic printing in Prussian blue », 1999 ; Christina Z. Anderson,
// « Cyanotype: The Blueprint in Contemporary Practice », 2019 ; fiches techniques des films et
// verres). Chaque atelier diffère : la calibration personnelle (bande test) corrige le reste.
// Module ES pur, sans dépendance.

/** Chimie sensibilisatrice. */
export const CHEMISTRY = [
  {
    id: 'classic',
    label: 'Cyanotype classique (Herschel)',
    factor: 1.0,
    description:
      'Formule A + B : citrate ferrique ammoniacal (vert) et ferricyanure de potassium. Référence du calcul.',
  },
  {
    id: 'kit_jacquard',
    label: 'Kit Jacquard (Cyanotype Sensitizer Set)',
    factor: 1.0,
    description:
      'Kit du commerce à formule classique (deux flacons à mélanger à parts égales). Même facteur que le classique : ' +
      'ta calibration rapide ou ta bande test ajuste ensuite le temps à ta façon de travailler.',
  },
  {
    id: 'classic_double',
    label: 'Classique concentré (×2)',
    factor: 1.3,
    description:
      'Solutions A et B à double concentration : plus de fer à réduire, bleus plus denses mais pose ~30 % plus longue.',
  },
  {
    id: 'classic_oxalic',
    label: 'Classique + acide oxalique',
    factor: 0.85,
    description:
      'Quelques gouttes d’acide oxalique (ou d’oxalate) ajoutées au classique : légère accélération et blancs plus propres.',
  },
  {
    id: 'classic_dichromate',
    label: 'Classique + bichromate',
    factor: 1.6,
    description:
      'Quelques gouttes de bichromate de potassium (toxique) : contraste accru mais pose nettement plus longue.',
  },
  {
    id: 'rex',
    label: 'Cyanotype Rex',
    factor: 0.5,
    description:
      'Formule « Rex » (P. Mrhar) à base de citrate et d’oxalate ferriques : environ deux fois plus rapide que le classique.',
  },
  {
    id: 'new_ware',
    label: 'New Cyanotype (Mike Ware)',
    factor: 0.3,
    description:
      'Oxalate ferrique ammoniacal + ferricyanure (Ware, 1994) : 3 à 4 fois plus rapide que le classique, meilleure gamme tonale.',
  },
];

/** Support. */
export const SUBSTRATE = [
  {
    id: 'cotton_paper',
    label: 'Papier 100 % coton',
    factor: 1.0,
    description: 'Papier aquarelle ou gravure pur coton (type Arches Platine, Bergger COT 320). Référence.',
  },
  {
    id: 'watercolor_cellulose',
    label: 'Papier aquarelle cellulose',
    factor: 1.15,
    description:
      'Papier de cellulose (bois) : encollage et charges souvent alcalines qui freinent le virage ; pose un peu plus longue.',
  },
  {
    id: 'japanese_paper',
    label: 'Papier japonais (washi)',
    factor: 0.85,
    description: 'Papier fin et peu chargé : couche mince, pose plus courte mais bleus moins profonds.',
  },
  {
    id: 'fabric_cotton',
    label: 'Tissu coton / lin',
    factor: 1.4,
    description: 'Les fibres textiles absorbent beaucoup de solution : pose 1,2 à 1,6 fois plus longue.',
  },
  {
    id: 'fabric_silk',
    label: 'Soie',
    factor: 1.2,
    description: 'Tissu fin et lisse : un peu plus long que le papier, rendu très détaillé.',
  },
  {
    id: 'wood',
    label: 'Bois',
    factor: 1.6,
    description: 'Bois brut poncé : surface irrégulière et tanins qui ralentissent ; prévoir large.',
  },
  {
    id: 'glass_gelatin',
    label: 'Verre ou céramique gélatiné',
    factor: 0.8,
    description: 'Couche de gélatine mince sur support non absorbant : pose plus courte, densité limitée.',
  },
];

/** Épaisseur de couche. */
export const COATING = [
  { id: 'single', label: 'Une couche', factor: 1.0, description: 'Une couche au pinceau ou à la tige. Référence.' },
  {
    id: 'double',
    label: 'Deux couches',
    factor: 1.35,
    description: 'Deux couches (séchage entre les deux) : bleus plus profonds, pose environ 1/3 plus longue.',
  },
  {
    id: 'thin',
    label: 'Couche mince',
    factor: 0.85,
    description: 'Couche légère ou diluée : pose plus courte, image moins dense.',
  },
];

/** État hydrique du papier sensibilisé au moment de la pose. */
export const HUMIDITY_STATE = [
  {
    id: 'dry',
    label: 'Papier sec',
    factor: 1.0,
    description: 'Papier séché à l’air, à l’abri de la lumière. Référence.',
  },
  {
    id: 'humidified',
    label: 'Papier ré-humidifié',
    factor: 0.7,
    description:
      'Papier ré-humidifié juste avant la pose (vapeur, boîte humide) : la réduction du fer est plus rapide et les bleus plus intenses.',
  },
  {
    id: 'very_dry',
    label: 'Papier très sec (séché à chaud)',
    factor: 1.15,
    description: 'Papier séché au sèche-cheveux ou par temps très sec : réaction un peu plus lente.',
  },
];

/** Verre ou plaque de contact. Transmission UV-A (≈ 365 nm) d'après les fiches des fabricants. */
export const GLASS = [
  { id: 'none', label: 'Sans verre', factor: 1.0, description: 'Contact direct (objets posés, négatif plaqué). Référence.' },
  {
    id: 'float_glass',
    label: 'Verre float ordinaire',
    factor: 1.2,
    description:
      'Verre à vitre 3–4 mm : coupe sous ~320 nm et absorbe une partie des UV-A (fer) ; ~75–85 % transmis → pose +15 à +25 %.',
  },
  {
    id: 'low_iron',
    label: 'Verre extra-clair (pauvre en fer)',
    factor: 1.08,
    description: 'Verre « extra-blanc » : meilleure transmission UV-A (~90 %), idéal pour le châssis-presse.',
  },
  {
    id: 'borosilicate',
    label: 'Verre borosilicate',
    factor: 1.05,
    description: 'Borosilicate (type Borofloat) : excellente transmission des UV-A.',
  },
  {
    id: 'acrylic_uvt',
    label: 'Acrylique UVT (transmission UV)',
    factor: 1.05,
    description: 'Plexiglas spécial « UVT » sans absorbeur UV : quasi transparent aux UV-A.',
  },
  {
    id: 'acrylic_standard',
    label: 'Acrylique / plexiglas standard',
    factor: 3.5,
    description:
      'Contient généralement un absorbeur UV qui bloque fortement sous ~380 nm : pose 3× plus longue ou plus. À éviter.',
  },
  {
    id: 'polycarbonate',
    label: 'Polycarbonate',
    factor: 6,
    description: 'Bloque presque tous les UV : pose extrêmement longue. Fortement déconseillé.',
  },
];

/** Type de négatif / masque. */
export const NEGATIVE = [
  {
    id: 'photogram',
    label: 'Photogramme (objets)',
    factor: 1.0,
    description: 'Feuilles, fleurs, objets posés directement : rien n’absorbe dans les zones claires. Référence.',
  },
  {
    id: 'digital_transparency',
    label: 'Négatif numérique sur transparent',
    factor: 1.45,
    description:
      'Film transparent jet d’encre ou laser : la base polyester et la couche réceptrice absorbent des UV-A → pose 1,3 à 1,6 fois plus longue.',
  },
  {
    id: 'inkjet_pictorico',
    label: 'Film jet d’encre spécialisé (Pictorico)',
    factor: 1.3,
    description: 'Film conçu pour les procédés alternatifs : base plus transparente aux UV que les transparents de bureau.',
  },
  {
    id: 'film_negative',
    label: 'Négatif argentique (grand format)',
    factor: 1.25,
    description: 'Négatif film en contact : la base et le voile minimum ajoutent environ 25 %.',
  },
  {
    id: 'tracing_paper',
    label: 'Papier calque',
    factor: 1.8,
    description: 'Dessin ou impression sur calque : diffuse et absorbe une bonne part des UV.',
  },
];

/**
 * Source lumineuse. Pour les lampes : temps de référence `refMinutes` mesuré avec les réglages de
 * référence (classique, coton, sans verre, photogramme) à la puissance `refPowerW` et à la distance
 * `refDistanceCm`. Valeurs typiques de montages amateurs ; à calibrer avec une bande test.
 */
export const LIGHT_SOURCE = [
  {
    id: 'sun',
    label: 'Soleil',
    kind: 'sun',
    factor: 1.0,
    description: 'Lumière du jour : temps calculé selon la position du soleil et la météo.',
  },
  {
    id: 'uv_led_365',
    label: 'LED UV 365 nm',
    kind: 'lamp',
    factor: 1.0,
    refMinutes: 10,
    refPowerW: 50,
    refDistanceCm: 15,
    description:
      'Panneau ou barres de LED 365 nm : longueur d’onde proche du pic de sensibilité du cyanotype, très efficace.',
  },
  {
    id: 'uv_led_395',
    label: 'LED UV 395–405 nm',
    kind: 'lamp',
    factor: 1.0,
    refMinutes: 18,
    refPowerW: 50,
    refDistanceCm: 15,
    description:
      'Bandeaux LED « UV » bon marché (395–405 nm) : en limite de sensibilité, environ deux fois moins efficaces que 365 nm.',
  },
  {
    id: 'blacklight_tubes',
    label: 'Tubes lumière noire (BL 350–368 nm)',
    kind: 'lamp',
    factor: 1.0,
    refMinutes: 12,
    refPowerW: 120,
    refDistanceCm: 8,
    description: 'Banc de tubes fluorescents actiniques BL (pas BLB) proches du châssis, éclairage très uniforme.',
  },
  {
    id: 'metal_halide',
    label: 'Lampe aux iodures métalliques',
    kind: 'lamp',
    factor: 1.0,
    refMinutes: 6,
    refPowerW: 1000,
    refDistanceCm: 60,
    description: 'Insoleuse offset / sérigraphie à vapeur de mercure dopée : puissante, source ponctuelle.',
  },
  {
    id: 'uv_box_generic',
    label: 'Insoleuse UV générique',
    kind: 'lamp',
    factor: 1.0,
    refMinutes: 15,
    refPowerW: 40,
    refDistanceCm: 10,
    description: 'Petite insoleuse (circuits imprimés, sérigraphie, ongles) : à calibrer impérativement.',
  },
];

/** Rendu souhaité. */
export const RESULT_GOAL = [
  { id: 'standard', label: 'Standard', factor: 1.0, description: 'Bleu de Prusse franc, blancs propres. Référence.' },
  {
    id: 'deep',
    label: 'Bleus profonds',
    factor: 1.3,
    description: 'Ombres très denses (légère perte dans les hautes lumières) ; adapté avant un virage.',
  },
  {
    id: 'light',
    label: 'Léger / pastel',
    factor: 0.8,
    description: 'Image claire et délicate, ombres moins saturées.',
  },
  {
    id: 'toning_planned',
    label: 'Virage prévu (thé, tanin…)',
    factor: 1.5,
    description: 'Surexposition volontaire : le blanchiment puis le virage tanique éclaircissent l’image.',
  },
];

/** Recherche d'un élément par identifiant dans un catalogue. */
export function getById(list, id) {
  if (!Array.isArray(list)) return undefined;
  return list.find((item) => item.id === id);
}
