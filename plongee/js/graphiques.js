// graphiques.js — Graphiques SVG faits main : courbes de charge des 16 compartiments
// (superposées ou petits multiples), profil de plongée.
// La première partie est purement logique (échelles, graduations, couleurs, chemins) et
// testée sous Node ; les fonctions `rendre…` touchent au DOM et ne sont appelées que dans
// le navigateur.

import { formatNombre, formatDuree, formatInstant } from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const PH2O = 0.0627;
const FN2_AIR = 0.7902;

// ---------------------------------------------------------------------------------------------
// Grandeurs affichées
// ---------------------------------------------------------------------------------------------

export const UNITES = {
  pN2: { cle: 'pN2', libelle: 'pN2 (bar)', court: 'bar', decimales: 3, suffixe: ' bar' },
  pctMSurf: { cle: 'pctMSurf', libelle: '% M-value en surface (à l’altitude)', court: '% M surf.', decimales: 0, suffixe: ' %' },
  pctMAmb: { cle: 'pctMAmb', libelle: '% M-value à la pression ambiante', court: '% M amb.', decimales: 0, suffixe: ' %' },
  pctGF: { cle: 'pctGF', libelle: '% gradient (0 = ambiante, 100 = M-value)', court: '% gradient', decimales: 0, suffixe: ' %' },
};

export function unite(cle) {
  return UNITES[cle] || UNITES.pN2;
}

/** Valeur formatée avec son unité. */
export function formatValeur(v, cleUnite) {
  const u = unite(cleUnite);
  return formatNombre(v, u.decimales) + u.suffixe;
}

/** pN2 d'équilibre en surface (air) à la pression de surface `psurf`. */
export function equilibreSurface(psurf) {
  return (psurf - PH2O) * FN2_AIR;
}

// ---------------------------------------------------------------------------------------------
// Échelles et graduations
// ---------------------------------------------------------------------------------------------

/** Échelle linéaire [d0,d1] → [r0,r1] avec inverse. */
export function echelleLineaire(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (v) => r0 + (v - d0) * k;
  f.inverse = (x) => (k === 0 ? d0 : d0 + (x - r0) / k);
  f.domaine = [d0, d1];
  f.plage = [r0, r1];
  return f;
}

/** Pas « rond » (1, 2, 2,5, 5 × 10^n) proche de `brut`. */
export function pasRond(brut) {
  if (!(brut > 0) || !Number.isFinite(brut)) return 1;
  const p = 10 ** Math.floor(Math.log10(brut));
  const m = brut / p;
  const r = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  return r * p;
}

/** Graduations régulières couvrant [min,max] (environ `cible` valeurs). */
export function graduationsLineaires(min, max, cible = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (max < min) [min, max] = [max, min];
  if (max === min) return [min];
  const pas = pasRond((max - min) / Math.max(1, cible));
  const debut = Math.ceil(min / pas - 1e-9) * pas;
  const res = [];
  for (let v = debut; v <= max + pas * 1e-9; v += pas) res.push(Math.round(v / pas) * pas);
  return res.map((v) => Math.round(v * 1e9) / 1e9 + 0);
}

/** Étend [min,max] à des bornes rondes. */
export function domaineRond(min, max, cible = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (max === min) { max = min + 1; min -= 1; }
  const pas = pasRond((max - min) / cible);
  return [Math.floor(min / pas + 1e-9) * pas, Math.ceil(max / pas - 1e-9) * pas];
}

/**
 * Échelle de temps. Mode 'lineaire' : classique. Mode 'mixte' : linéaire jusqu'à `pivot`
 * (sortie de l'eau) sur une fraction `fraction` de la largeur, puis logarithmique
 * (x ∝ ln(1 + (t − pivot)/tau)) : la plongée reste lisible et les heures de désaturation
 * tiennent sur le même axe.
 */
export function echelleTemps({ tMin, tMax, x0, x1, mode = 'lineaire', pivot, fraction = 0.4, tau = 10, morceaux }) {
  if (mode === 'morceaux' && Array.isArray(morceaux) && morceaux.some((p) => p.fin > p.debut && p.part > 0)) {
    return echelleMorceaux(morceaux, x0, x1);
  }
  if (mode !== 'mixte' || !(pivot > tMin) || !(pivot < tMax)) {
    const f = echelleLineaire(tMin, tMax, x0, x1);
    f.mode = 'lineaire';
    return f;
  }
  const xp = x0 + (x1 - x0) * fraction;
  const lin = echelleLineaire(tMin, pivot, x0, xp);
  const lmax = Math.log1p((tMax - pivot) / tau);
  const f = (t) => (t <= pivot ? lin(t) : xp + ((x1 - xp) * Math.log1p((t - pivot) / tau)) / lmax);
  f.inverse = (x) => (x <= xp ? lin.inverse(x) : pivot + tau * Math.expm1((lmax * (x - xp)) / (x1 - xp)));
  f.domaine = [tMin, tMax];
  f.plage = [x0, x1];
  f.mode = 'mixte';
  f.pivot = pivot;
  f.xPivot = xp;
  return f;
}

/**
 * Échelle de temps par morceaux : chaque morceau [debut, fin] occupe une part `part` de la
 * largeur, en linéaire ou en logarithmique (x ∝ ln(1 + (t − debut)/tau)). Sert à montrer
 * une plongée successive : plongée précédente (linéaire), intervalle (compressé), plongée
 * courante (linéaire), surface jusqu'à désaturation (compressée).
 * @param {{ debut:number, fin:number, type:'lineaire'|'log', part:number, tau?:number, role?:string }[]} morceaux
 */
export function echelleMorceaux(morceaux, x0, x1) {
  const valides = morceaux.filter((p) => p.fin > p.debut && p.part > 0);
  const total = valides.reduce((a, p) => a + p.part, 0);
  let xc = x0;
  const ms = valides.map((p) => {
    const w = ((x1 - x0) * p.part) / total;
    const r = { ...p, tau: p.tau ?? 10, xa: xc, xb: xc + w };
    xc += w;
    return r;
  });
  const morceauT = (t) => ms.find((p) => t <= p.fin) || ms[ms.length - 1];
  const morceauX = (x) => ms.find((p) => x <= p.xb) || ms[ms.length - 1];
  const f = (t) => {
    const p = t < ms[0].debut ? ms[0] : morceauT(t);
    const u = p.type === 'log'
      ? Math.log1p(Math.max(0, t - p.debut) / p.tau) / Math.log1p((p.fin - p.debut) / p.tau)
      : (t - p.debut) / (p.fin - p.debut);
    return p.xa + (p.xb - p.xa) * u;
  };
  f.inverse = (x) => {
    const p = x < ms[0].xa ? ms[0] : morceauX(x);
    const u = (x - p.xa) / (p.xb - p.xa);
    return p.type === 'log'
      ? p.debut + p.tau * Math.expm1(Math.max(0, u) * Math.log1p((p.fin - p.debut) / p.tau))
      : p.debut + u * (p.fin - p.debut);
  };
  f.domaine = [ms[0].debut, ms[ms.length - 1].fin];
  f.plage = [x0, x1];
  f.mode = 'morceaux';
  f.morceaux = ms;
  return f;
}

const PAS_MINUTES = [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 360, 720, 1440];
// Repères horaires par ordre de priorité (les plus « ronds » d'abord, les autres s'il reste de la place).
const REPERES_HEURES = [60, 1440, 360, 720, 2880, 5760, 120, 180, 240, 480, 1080, 2160, 4320];

/** Libellé court d'une graduation de temps : « 20 », « 1 h », « 1 h 30 », « 24 h ». */
export function libelleTemps(t) {
  const a = Math.abs(t);
  const signe = t < 0 ? '−' : '';
  if (a < 60) return signe + formatNombre(a, Number.isInteger(Math.round(a * 10) / 10) ? 0 : 1);
  const h = Math.floor(a / 60);
  const m = Math.round(a - h * 60);
  return `${signe}${h} h${m ? ` ${String(m).padStart(2, '0')}` : ''}`;
}

/**
 * Graduations de l'axe du temps, espacées d'au moins `ecartMin` pixels.
 * @returns {{ t:number, x:number, libelle:string }[]}
 */
export function graduationsTemps(ech, { ecartMin = 44 } = {}) {
  const [tMin, tMax] = ech.domaine;
  const largeur = Math.abs(ech.plage[1] - ech.plage[0]);
  const res = [];
  const ajouter = (t) => {
    const x = ech(t);
    if (res.some((g) => Math.abs(g.x - x) < ecartMin)) return;
    res.push({ t, x, libelle: libelleTemps(t) });
  };
  if (ech.mode === 'morceaux') {
    // Priorité : immersion, puis graduations de la plongée courante, repères horaires après la
    // sortie, et enfin graduations de la plongée précédente.
    if (0 >= tMin && 0 <= tMax) ajouter(0);
    const lineaires = ech.morceaux.filter((p) => p.type === 'lineaire');
    const ordre = [...lineaires.filter((p) => p.debut >= 0), ...lineaires.filter((p) => p.debut < 0)];
    for (const p of ordre) {
      const nbP = Math.max(1, Math.floor((p.xb - p.xa) / ecartMin));
      const pasP = PAS_MINUTES.find((q) => (p.fin - p.debut) / q <= nbP) || 1440;
      for (let t = Math.ceil(p.debut / pasP - 1e-9) * pasP; t <= p.fin + 1e-9; t += pasP) ajouter(t);
      if (p === ordre[0]) {
        const apres = ech.morceaux.find((q) => q.type === 'log' && q.debut >= p.fin - 1e-9);
        if (apres) REPERES_HEURES.filter((t) => t > apres.debut && t <= apres.fin).forEach(ajouter);
      }
    }
    return res.sort((a, b) => a.t - b.t);
  }
  const tFinLin = ech.mode === 'mixte' ? ech.pivot : tMax;
  const largeurLin = ech.mode === 'mixte' ? Math.abs(ech.xPivot - ech.plage[0]) : largeur;
  const nb = Math.max(1, Math.floor(largeurLin / ecartMin));
  const pas = PAS_MINUTES.find((p) => (tFinLin - tMin) / p <= nb) || 1440;
  for (let t = Math.ceil(tMin / pas) * pas; t <= tFinLin + 1e-9; t += pas) ajouter(t);
  if (ech.mode === 'mixte') REPERES_HEURES.filter((t) => t > ech.pivot && t <= tMax).forEach(ajouter);
  return res.sort((a, b) => a.t - b.t);
}

/** Indice de l'échantillon le plus proche de t (recherche dichotomique, échantillons triés). */
export function indiceProche(echantillons, t) {
  const n = echantillons.length;
  if (!n) return -1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (echantillons[mid].t <= t) lo = mid; else hi = mid;
  }
  return Math.abs(echantillons[lo].t - t) <= Math.abs(echantillons[hi].t - t) ? lo : hi;
}

/** Chemin SVG d'une polyligne ; un point non fini coupe le tracé. */
export function cheminLigne(points) {
  let d = '';
  let enCours = false;
  for (const [x, y] of points) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) { enCours = false; continue; }
    d += `${enCours ? 'L' : 'M'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
    enCours = true;
  }
  return d;
}

/** Domaine vertical pour une grandeur et des compartiments donnés. */
export function domaineY(echantillons, cleUnite, indices, { psurf = 1.01325, gfHaut } = {}) {
  let min = Infinity;
  let max = -Infinity;
  for (const e of echantillons) {
    const serie = e[cleUnite];
    if (!serie) continue;
    for (const i of indices) {
      const v = serie[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min)) { min = 0; max = 1; }
  if (cleUnite === 'pN2') {
    const eq = equilibreSurface(psurf);
    min = Math.min(min, eq);
    max = Math.max(max, eq);
    return domaineRond(Math.max(0, min - (max - min) * 0.05), max + (max - min) * 0.05);
  }
  if (cleUnite === 'pctGF') {
    min = Math.max(-100, Math.min(min, 0));
    max = Math.max(max, 100, gfHaut || 0);
    return domaineRond(min, max);
  }
  return domaineRond(Math.max(0, Math.min(min, 50)), Math.max(max, 100));
}

// ---------------------------------------------------------------------------------------------
// Couleurs des compartiments : dégradé ordonné du rapide (chaud) au lent (froid), en OKLCH,
// avec deux clartés (thème clair / sombre) et une légère alternance pour séparer les voisins.
// ---------------------------------------------------------------------------------------------

/** OKLCH → hexadécimal sRGB (gamut écrêté). */
export function oklchVersHex(L, C, hDeg) {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return `#${lin
    .map((c) => {
      const v = Math.min(1, Math.max(0, c));
      const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
      return Math.round(g * 255).toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/**
 * Couleur du compartiment d'indice i (0–15).
 * @param {number} i
 * @param {'clair'|'sombre'} theme
 */
export function couleurCompartiment(i, theme = 'clair') {
  const k = Math.min(15, Math.max(0, i)) / 15;
  const teinte = 25 + k * 260; // rouge → orangé → vert → bleu → violet
  const alt = i % 2 ? 0.045 : -0.02;
  const L = theme === 'sombre' ? 0.76 + alt : 0.53 + alt;
  const C = theme === 'sombre' ? 0.14 : 0.16;
  return oklchVersHex(L, C, teinte);
}

/** Feuille de style des variables --c1 … --c16 (clair + sombre). */
export function cssCouleursCompartiments() {
  const vars = (theme) => Array.from({ length: 16 }, (_, i) => `--c${i + 1}:${couleurCompartiment(i, theme)};`).join('');
  return `:root{${vars('clair')}}@media (prefers-color-scheme: dark){:root{${vars('sombre')}}}`;
}

/** Luminance relative WCAG d'une couleur #rrggbb. */
export function luminance(hex) {
  const v = [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16) / 255);
  const [r, g, b] = v.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Rapport de contraste WCAG entre deux couleurs. */
export function contraste(h1, h2) {
  const [a, b] = [luminance(h1), luminance(h2)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

// ---------------------------------------------------------------------------------------------
// Rendu DOM (navigateur uniquement)
// ---------------------------------------------------------------------------------------------

function el(nom, attrs = {}, parent) {
  const n = document.createElementNS(SVGNS, nom);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  if (parent) parent.appendChild(n);
  return n;
}

function texte(parent, x, y, contenu, attrs = {}) {
  const t = el('text', { x, y, ...attrs }, parent);
  t.textContent = contenu;
  return t;
}

function html(nom, classe, parent, contenu) {
  const n = document.createElement(nom);
  if (classe) n.className = classe;
  if (contenu !== undefined) n.textContent = contenu;
  if (parent) parent.appendChild(n);
  return n;
}

let idUnique = 0;

/**
 * Fenêtre de temps pour l'option d'échelle choisie.
 * - 'plongee' : de l'immersion à un peu après la sortie (linéaire) ;
 * - 'desat' : de l'immersion de la plongée courante (état initial, azote résiduel compris)
 *   jusqu'à la désaturation, linéaire jusqu'à la sortie puis compressé ;
 * - 'successive' (plongée précédente seulement, sinon comme 'desat') : axe par morceaux,
 *   plongée précédente et plongée courante linéaires chacune, intervalle et surface compressés.
 */
export function fenetreTemps(res, echelle) {
  const ech = res.echantillons;
  const tSortie = res.resume.dureeTotale;
  const tFin = ech[ech.length - 1].t;
  const prec = res.plongeePrecedente;
  if (echelle === 'successive' && prec && ech[0].t < 0) {
    const debut = Math.min(prec.debut, ech[0].t);
    const dureeP = prec.sortie - debut;
    const morceaux = [
      { debut, fin: prec.sortie, type: 'lineaire', part: 0.24 * Math.min(1.5, Math.max(0.6, dureeP / Math.max(1, tSortie))), role: 'precedente' },
      { debut: prec.sortie, fin: 0, type: 'log', part: 0.1, tau: 10, role: 'intervalle' },
      { debut: 0, fin: tSortie, type: 'lineaire', part: 0.3, role: 'plongee' },
      { debut: tSortie, fin: tFin, type: 'log', part: 0.32, tau: 10, role: 'surface' },
    ];
    return { tMin: debut, tMax: tFin, mode: 'morceaux', pivot: tSortie, morceaux };
  }
  if (echelle === 'desat' || echelle === 'successive') {
    return { tMin: 0, tMax: tFin, mode: 'mixte', pivot: tSortie };
  }
  return { tMin: 0, tMax: tSortie + Math.max(5, Math.round(tSortie * 0.12)), mode: 'lineaire', pivot: tSortie };
}

/** Échantillons dans la fenêtre (avec un point de part et d'autre pour tracer jusqu'au bord). */
function echantillonsFenetre(ech, tMin, tMax) {
  let i0 = 0;
  while (i0 < ech.length - 1 && ech[i0 + 1].t <= tMin) i0++;
  let i1 = ech.length - 1;
  while (i1 > 0 && ech[i1 - 1].t >= tMax) i1--;
  return ech.slice(i0, i1 + 1);
}

/** Lignes de référence horizontales selon la grandeur. */
function references(cleUnite, psurf, gfHaut) {
  if (cleUnite === 'pN2') return [{ v: equilibreSurface(psurf), libelle: `Équilibre en surface (${formatNombre(equilibreSurface(psurf), 3)} bar)` }];
  if (cleUnite === 'pctGF') {
    const r = [{ v: 0, libelle: 'Pression ambiante' }, { v: 100, libelle: 'M-value' }];
    if (gfHaut && gfHaut < 100) r.push({ v: gfHaut, libelle: `GF haut ${gfHaut} %`, discret: true });
    return r;
  }
  return [{ v: 100, libelle: cleUnite === 'pctMSurf' ? 'M-value en surface' : 'M-value' }];
}

/**
 * Courbes de charge.
 * @param {HTMLElement} conteneur
 * @param {object} res sortie de planifier()
 * @param {{ unite:string, echelle:'plongee'|'desat', mode:'superpose'|'multiples', visibles:number[], gfHaut?:number }} opts
 */
export function rendreCourbes(conteneur, res, opts) {
  conteneur.replaceChildren();
  if (opts.mode === 'multiples') return rendreMultiples(conteneur, res, opts);
  const visibles = opts.visibles.slice().sort((a, b) => a - b);
  const largeur = Math.max(280, Math.round(conteneur.clientWidth || 600));
  const hauteur = largeur < 520 ? 300 : 380;
  const m = { g: 46, d: 40, h: 22, b: 34 };
  const fen = fenetreTemps(res, opts.echelle);
  const ech = echantillonsFenetre(res.echantillons, fen.tMin, fen.tMax);
  const x = echelleTemps({ ...fen, x0: m.g, x1: largeur - m.d });
  const dom = domaineY(ech, opts.unite, visibles.length ? visibles : [...Array(16).keys()], { psurf: res.psurf, gfHaut: opts.gfHaut });
  const y = echelleLineaire(dom[0], dom[1], hauteur - m.b, m.h);
  const profMax = Math.max(5, ...ech.map((e) => e.profondeur));
  const yProf = echelleLineaire(0, domaineRond(0, profMax)[1], m.h, hauteur - m.b);
  const u = unite(opts.unite);

  const figure = html('div', 'graphique', conteneur);
  const svg = el('svg', {
    viewBox: `0 0 ${largeur} ${hauteur}`, width: largeur, height: hauteur, class: 'courbes', tabindex: 0, role: 'img',
    'aria-label': `Courbes de charge (${u.libelle}) de ${visibles.length} compartiment(s) en fonction du temps, profil de profondeur en arrière-plan. Flèches gauche et droite pour parcourir les valeurs.`,
  }, figure);
  const clipId = `clip-${++idUnique}`;
  const clip = el('clipPath', { id: clipId }, el('defs', {}, svg));
  el('rect', { x: m.g, y: m.h, width: largeur - m.g - m.d, height: hauteur - m.h - m.b }, clip);

  // Profil de profondeur (arrière-plan, axe de droite)
  const pts = ech.map((e) => [x(e.t), yProf(e.profondeur)]);
  if (pts.length) {
    el('path', { d: `${cheminLigne(pts)}L${pts[pts.length - 1][0]} ${yProf(0)}L${pts[0][0]} ${yProf(0)}Z`, class: 'profil-fond', 'clip-path': `url(#${clipId})` }, svg);
    el('path', { d: cheminLigne(pts), class: 'profil-fond-ligne', 'clip-path': `url(#${clipId})` }, svg);
  }
  // Grille et axe gauche
  const gy = el('g', { class: 'axe' }, svg);
  for (const v of graduationsLineaires(dom[0], dom[1], hauteur < 340 ? 5 : 6)) {
    el('line', { x1: m.g, x2: largeur - m.d, y1: y(v), y2: y(v), class: 'grille' }, gy);
    texte(gy, m.g - 6, y(v) + 4, formatNombre(v, u.decimales && dom[1] - dom[0] < 1 ? 2 : u.decimales ? 1 : 0), { 'text-anchor': 'end' });
  }
  texte(gy, 4, 11, u.court, { class: 'titre-axe' });
  // Axe droit (profondeur)
  const gp = el('g', { class: 'axe axe-prof' }, svg);
  for (const v of graduationsLineaires(0, yProf.domaine[1], 4)) {
    texte(gp, largeur - m.d + 6, yProf(v) + 4, `${formatNombre(v)}`, {});
  }
  texte(gp, largeur - 2, 11, 'prof. (m)', { 'text-anchor': 'end', class: 'titre-axe' });
  // Axe du temps
  const gx = el('g', { class: 'axe' }, svg);
  el('line', { x1: m.g, x2: largeur - m.d, y1: hauteur - m.b, y2: hauteur - m.b, class: 'ligne-axe' }, gx);
  for (const g of graduationsTemps(x, { ecartMin: largeur < 520 ? 40 : 52 })) {
    el('line', { x1: g.x, x2: g.x, y1: hauteur - m.b, y2: hauteur - m.b + 4, class: 'ligne-axe' }, gx);
    texte(gx, g.x, hauteur - m.b + 16, g.libelle, { 'text-anchor': 'middle' });
  }
  const titresAxe = {
    lineaire: 'temps depuis l’immersion (min)',
    mixte: largeur < 520 ? 'temps (compressé après la sortie)' : 'temps depuis l’immersion (min, puis heures — échelle compressée après la sortie)',
    morceaux: largeur < 520 ? 'temps (intervalle et surface compressés)' : 'temps depuis l’immersion (min) — intervalle de surface et désaturation compressés',
  };
  texte(gx, m.g, hauteur - 3, titresAxe[x.mode] || titresAxe.lineaire, { class: 'titre-axe' });
  if (x.mode === 'mixte') {
    el('line', { x1: x.xPivot, x2: x.xPivot, y1: m.h, y2: hauteur - m.b, class: 'repere-sortie' }, svg);
    texte(svg, x.xPivot + 4, m.h + 11, 'sortie', { class: 'etiquette-ref' });
  } else if (x.mode === 'morceaux') {
    const inter = x.morceaux.find((p) => p.role === 'intervalle');
    if (inter) el('rect', { x: inter.xa, y: m.h, width: Math.max(0, inter.xb - inter.xa), height: hauteur - m.h - m.b, class: 'zone-intervalle' }, svg);
    for (const [t, lib] of [[0, 'immersion'], [res.resume.dureeTotale, 'sortie']]) {
      const xv = x(t);
      el('line', { x1: xv, x2: xv, y1: m.h, y2: hauteur - m.b, class: 'repere-sortie' }, svg);
      if (largeur >= 420 || lib === 'sortie') texte(svg, xv + 4, m.h + 11, lib, { class: 'etiquette-ref' });
    }
  }
  // Lignes de référence (étiquettes posées après les courbes, voir plus bas)
  const refs = references(opts.unite, res.psurf, opts.gfHaut).filter((r) => r.v >= dom[0] && r.v <= dom[1]);
  for (const r of refs) el('line', { x1: m.g, x2: largeur - m.d, y1: y(r.v), y2: y(r.v), class: r.discret ? 'reference discret' : 'reference' }, svg);
  // Courbes
  const gc = el('g', { 'clip-path': `url(#${clipId})`, class: 'series' }, svg);
  for (const i of visibles) {
    el('path', { d: cheminLigne(ech.map((e) => [x(e.t), y(e[opts.unite][i])])), class: 'serie', style: `stroke:var(--c${i + 1})`, 'data-n': i + 1 }, gc);
  }
  if (largeur >= 520) for (const r of refs) texte(svg, x0Etiquette(x, m, largeur), y(r.v) - 5, r.libelle, { 'text-anchor': 'end', class: 'etiquette-ref' });
  // Étiquettes directes en bout de courbe (≤ 4 courbes visibles)
  if (visibles.length && visibles.length <= 4) {
    const der = ech[ech.length - 1];
    const xDer = Math.min(x(der.t), largeur - m.d);
    for (const i of visibles) texte(svg, xDer - 4, y(der[opts.unite][i]) - 5, `C${i + 1}`, { 'text-anchor': 'end', class: 'etiquette-serie' });
  }

  const leg = html('p', 'legende-courbes', figure);
  const l1 = html('span', null, leg);
  html('span', 'ech-profil', l1).setAttribute('aria-hidden', 'true');
  l1.append('profil de profondeur (axe de droite)');
  for (const r of refs) {
    const l = html('span', null, leg);
    html('span', 'ech-ref', l).setAttribute('aria-hidden', 'true');
    l.append(r.libelle);
  }
  if (res.plongeePrecedente && x.mode !== 'morceaux') {
    html('span', 'note-residuel', leg, 'Les courbes partent de l’immersion, avec l’azote résiduel de la plongée précédente (choisir « Avec la plongée précédente » pour la voir).');
  }

  installerCurseur({ svg, figure, ech, x, hauteur, m, largeur, rendreInfo: (e) => infoInstant(e, visibles, opts.unite), points: (e) => visibles.map((i) => ({ cy: y(e[opts.unite][i]), i })) });
}

/** Abscisse des étiquettes de référence : bord droit du tracé. */
function x0Etiquette(x, m, largeur) {
  return largeur - m.d - 4;
}

/** Contenu de l'info-bulle : instant, profondeur, valeurs des compartiments visibles. */
function infoInstant(e, visibles, cleUnite) {
  const frag = document.createDocumentFragment();
  const tete = html('p', 'info-tete', frag);
  html('strong', null, tete, formatInstant(e.t));
  tete.append(` · ${formatNombre(e.profondeur, 1)} m`);
  if (e.plafond > 0) tete.append(` · plafond ${formatNombre(e.plafond, 1)} m`);
  const liste = html('ul', 'info-valeurs', frag);
  for (const i of visibles) {
    const li = html('li', e.directeur === i + 1 ? 'directeur' : null, liste);
    const pastille = html('span', 'pastille', li);
    pastille.style.background = `var(--c${i + 1})`;
    html('span', 'info-n', li, `C${i + 1}`);
    html('span', 'info-v', li, formatValeur(e[cleUnite][i], cleUnite));
  }
  if (!visibles.length) html('li', null, liste, 'Aucun compartiment sélectionné.');
  return frag;
}

/** Curseur vertical + info-bulle (souris, toucher, clavier). */
function installerCurseur({ svg, figure, ech, x, hauteur, m, largeur, rendreInfo, points }) {
  const ligne = el('line', { y1: m.h, y2: hauteur - m.b, class: 'curseur', visibility: 'hidden' }, svg);
  const gPts = el('g', { class: 'curseur-points' }, svg);
  const info = html('div', 'info-bulle', figure);
  info.setAttribute('role', 'status');
  info.hidden = true;
  let courant = -1;
  const montrer = (idx) => {
    if (idx < 0 || idx >= ech.length) return;
    courant = idx;
    const e = ech[idx];
    const cx = x(e.t);
    ligne.setAttribute('x1', cx);
    ligne.setAttribute('x2', cx);
    ligne.setAttribute('visibility', 'visible');
    gPts.replaceChildren();
    for (const p of points(e)) {
      if (p.cy < m.h || p.cy > hauteur - m.b) continue;
      el('circle', { cx, cy: p.cy, r: 4, class: 'point', style: `fill:var(--c${p.i + 1})` }, gPts);
    }
    info.replaceChildren(rendreInfo(e));
    info.hidden = false;
    // Position flottante (grand écran) : à droite du curseur, ou à gauche près du bord.
    const echelleAff = (svg.getBoundingClientRect().width || largeur) / largeur;
    const xPx = cx * echelleAff;
    const larg = figure.clientWidth;
    info.style.left = xPx > larg * 0.55 ? '' : `${Math.round(xPx + 14)}px`;
    info.style.right = xPx > larg * 0.55 ? `${Math.round(larg - xPx + 14)}px` : '';
  };
  const cacher = () => {
    ligne.setAttribute('visibility', 'hidden');
    gPts.replaceChildren();
    info.hidden = true;
  };
  const depuisEvenement = (ev) => {
    const r = svg.getBoundingClientRect();
    const xv = ((ev.clientX - r.left) / r.width) * largeur;
    if (xv < m.g - 10 || xv > largeur - m.d + 10) return;
    montrer(indiceProche(ech, x.inverse(Math.min(largeur - m.d, Math.max(m.g, xv)))));
  };
  svg.addEventListener('pointermove', depuisEvenement);
  svg.addEventListener('pointerdown', depuisEvenement);
  svg.addEventListener('pointerleave', (ev) => { if (ev.pointerType === 'mouse') cacher(); });
  svg.addEventListener('blur', cacher);
  svg.addEventListener('keydown', (ev) => {
    const pas = ev.shiftKey ? 10 : 1;
    if (ev.key === 'ArrowRight') montrer(Math.min(ech.length - 1, (courant < 0 ? 0 : courant + pas)));
    else if (ev.key === 'ArrowLeft') montrer(Math.max(0, (courant < 0 ? 0 : courant - pas)));
    else if (ev.key === 'Home') montrer(0);
    else if (ev.key === 'End') montrer(ech.length - 1);
    else if (ev.key === 'Escape') cacher();
    else return;
    ev.preventDefault();
  });
}

/** Petits multiples : un graphique par compartiment, échelles communes, curseur synchronisé. */
function rendreMultiples(conteneur, res, opts) {
  const fen = fenetreTemps(res, opts.echelle);
  const ech = echantillonsFenetre(res.echantillons, fen.tMin, fen.tMax);
  const tous = [...Array(16).keys()];
  const dom = domaineY(ech, opts.unite, tous, { psurf: res.psurf, gfHaut: opts.gfHaut });
  const grille = html('div', 'multiples', conteneur);
  const largDispo = Math.max(260, conteneur.clientWidth || 600);
  const colonnes = largDispo >= 900 ? 4 : largDispo >= 560 ? 3 : 2;
  grille.style.setProperty('--colonnes', String(colonnes));
  const larg = Math.max(140, Math.floor((largDispo - 8 * (colonnes - 1)) / colonnes) - 14);
  const haut = Math.round(Math.max(110, larg * 0.62));
  const m = { g: 30, d: 6, h: 8, b: 18 };
  const x = echelleTemps({ ...fen, x0: m.g, x1: larg - m.d });
  const y = echelleLineaire(dom[0], dom[1], haut - m.b, m.h);
  const profMax = Math.max(5, ...ech.map((e) => e.profondeur));
  const yProf = echelleLineaire(0, profMax, m.h, haut - m.b);
  const u = unite(opts.unite);
  const refs = references(opts.unite, res.psurf, opts.gfHaut);
  const gradY = graduationsLineaires(dom[0], dom[1], 3);
  const gradX = graduationsTemps(x, { ecartMin: 40 });
  const profilD = (() => {
    const pts = ech.map((e) => [x(e.t), yProf(e.profondeur)]);
    return pts.length ? `${cheminLigne(pts)}L${pts[pts.length - 1][0]} ${m.h}L${pts[0][0]} ${m.h}Z` : '';
  })();
  const cellules = [];
  for (const i of tous) {
    const c = res.compartiments[i];
    const fig = html('figure', 'multiple', grille);
    const leg = html('figcaption', null, fig);
    const pastille = html('span', 'pastille', leg);
    pastille.style.background = `var(--c${i + 1})`;
    html('strong', null, leg, `C${i + 1}`);
    leg.append(` · ${formatNombre(c.demiVie, c.demiVie % 1 ? 1 : 0)} min`);
    const val = html('span', 'valeur-multiple', leg);
    const svg = el('svg', { viewBox: `0 0 ${larg} ${haut}`, class: 'courbe-multiple', role: 'img',
      'aria-label': `Compartiment ${i + 1} (demi-vie ${c.demiVie} min) : maximum ${formatValeur(Math.max(...ech.map((e) => e[opts.unite][i])), opts.unite)}` }, fig);
    if (profilD) el('path', { d: profilD, class: 'profil-fond' }, svg);
    for (const v of gradY) {
      el('line', { x1: m.g, x2: larg - m.d, y1: y(v), y2: y(v), class: 'grille' }, svg);
      texte(svg, m.g - 4, y(v) + 4, formatNombre(v, u.decimales ? 1 : 0), { 'text-anchor': 'end', class: 'axe-mini' });
    }
    for (const g of gradX) texte(svg, g.x, haut - 5, g.libelle, { 'text-anchor': 'middle', class: 'axe-mini' });
    for (const r of refs) if (r.v >= dom[0] && r.v <= dom[1]) el('line', { x1: m.g, x2: larg - m.d, y1: y(r.v), y2: y(r.v), class: r.discret ? 'reference discret' : 'reference' }, svg);
    el('path', { d: cheminLigne(ech.map((e) => [x(e.t), y(e[opts.unite][i])])), class: 'serie', style: `stroke:var(--c${i + 1})` }, svg);
    const curseur = el('line', { y1: m.h, y2: haut - m.b, class: 'curseur', visibility: 'hidden' }, svg);
    const point = el('circle', { r: 3.5, class: 'point', style: `fill:var(--c${i + 1})`, visibility: 'hidden' }, svg);
    cellules.push({ svg, curseur, point, val, i });
  }
  const montrer = (idx) => {
    const e = ech[idx];
    if (!e) return;
    for (const c of cellules) {
      const cx = x(e.t);
      c.curseur.setAttribute('x1', cx);
      c.curseur.setAttribute('x2', cx);
      c.curseur.setAttribute('visibility', 'visible');
      c.point.setAttribute('cx', cx);
      c.point.setAttribute('cy', y(e[opts.unite][c.i]));
      c.point.setAttribute('visibility', 'visible');
      c.val.textContent = `${formatValeur(e[opts.unite][c.i], opts.unite)}`;
    }
    legende.textContent = `À ${formatInstant(e.t)} (${formatNombre(e.profondeur, 1)} m) — compartiment directeur : C${e.directeur}`;
  };
  const legende = html('p', 'legende-multiples', null, 'Survolez ou touchez un graphique pour lire les valeurs au même instant dans les 16 compartiments.');
  conteneur.insertBefore(legende, grille);
  for (const c of cellules) {
    const handler = (ev) => {
      const r = c.svg.getBoundingClientRect();
      const xv = ((ev.clientX - r.left) / r.width) * larg;
      montrer(indiceProche(ech, x.inverse(Math.min(larg - m.d, Math.max(m.g, xv)))));
    };
    c.svg.addEventListener('pointermove', handler);
    c.svg.addEventListener('pointerdown', handler);
  }
}

/**
 * Petit profil de plongée : profondeur et plafond en fonction du temps, paliers annotés.
 */
export function rendreProfil(conteneur, res) {
  conteneur.replaceChildren();
  const largeur = Math.max(260, Math.round(conteneur.clientWidth || 500));
  const hauteur = 150;
  const m = { g: 34, d: 10, h: 10, b: 24 };
  const tSortie = res.resume.dureeTotale;
  const ech = res.echantillons.filter((e) => e.t >= 0 && e.t <= tSortie + 0.5);
  if (!ech.length) return;
  const x = echelleLineaire(0, Math.max(1, tSortie), m.g, largeur - m.d);
  const profMax = domaineRond(0, Math.max(5, res.resume.profondeurMax), 4)[1];
  const y = echelleLineaire(0, profMax, m.h, hauteur - m.b);
  const svg = el('svg', { viewBox: `0 0 ${largeur} ${hauteur}`, width: largeur, height: hauteur, class: 'profil', role: 'img',
    'aria-label': `Profil de plongée : ${formatNombre(res.resume.profondeurMax)} m maximum, sortie à ${formatDuree(tSortie)}.` }, conteneur);
  for (const v of graduationsLineaires(0, profMax, 4)) {
    el('line', { x1: m.g, x2: largeur - m.d, y1: y(v), y2: y(v), class: 'grille' }, svg);
    texte(svg, m.g - 5, y(v) + 4, `${v}`, { 'text-anchor': 'end', class: 'axe-mini' });
  }
  for (const g of graduationsTemps(x, { ecartMin: 40 })) texte(svg, g.x, hauteur - 6, g.libelle, { 'text-anchor': 'middle', class: 'axe-mini' });
  texte(svg, largeur - m.d, hauteur - 6, 'min', { 'text-anchor': 'end', class: 'axe-mini' });
  const pts = ech.map((e) => [x(e.t), y(e.profondeur)]);
  el('path', { d: `${cheminLigne(pts)}L${pts[pts.length - 1][0]} ${y(0)}L${pts[0][0]} ${y(0)}Z`, class: 'profil-aire' }, svg);
  el('path', { d: cheminLigne(pts), class: 'profil-ligne' }, svg);
  if (ech.some((e) => e.plafond > 0)) {
    el('path', { d: cheminLigne(ech.map((e) => [x(e.t), e.plafond > 0 ? y(e.plafond) : NaN])), class: 'profil-plafond' }, svg);
  }
  for (const p of res.paliers) {
    const xm = x(p.debut + p.duree / 2);
    texte(svg, xm, y(p.profondeur) + 15, `${p.duree}′`, { 'text-anchor': 'middle', class: 'etiquette-palier' });
  }
}
