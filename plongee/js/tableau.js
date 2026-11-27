// tableau.js — Tableau des charges des 16 compartiments aux instants clés (carte de chaleur)
// et export CSV pour Excel en français (« ; » et virgule décimale).
// Partie pure (couleurs, CSV) testée sous Node ; `rendreTableau` / `rendreLegende` touchent au DOM.

import { formatNombre, nombreCSV } from './format.js';
import { unite, UNITES, contraste } from './graphiques.js';

// ---------------------------------------------------------------------------------------------
// Carte de chaleur
// ---------------------------------------------------------------------------------------------

/** Rampes : séquentielle (une teinte, clair → foncé) et divergente (bleu ← gris → orangé). */
export const RAMPES = {
  clair: {
    sequentiel: ['#f2f8f9', '#c9e6ea', '#8fcad3', '#4fa3b6', '#2a7898', '#174f78', '#0d2f55'],
    divergent: ['#2f6db0', '#8fb4da', '#eef0f0', '#f0b989', '#c2570c'],
    depassement: '#a3161a',
  },
  sombre: {
    sequentiel: ['#0f2233', '#123a4e', '#175569', '#1f7485', '#3d9aa3', '#7cc6c4', '#c9efe8'],
    divergent: ['#4f93d6', '#2c5677', '#2a3039', '#8a5a33', '#f0954a'],
    depassement: '#ff6b6b',
  },
};

const ENCRE = { sombre: '#0a1622', claire: '#ffffff' };

/** Interpole linéairement dans une liste de couleurs #rrggbb, t ∈ [0,1]. */
export function interpolerHex(stops, t) {
  const v = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const pos = v * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = stops[i];
  const b = stops[i + 1];
  const c = [1, 3, 5].map((p) => {
    const x = parseInt(a.slice(p, p + 2), 16);
    const y = parseInt(b.slice(p, p + 2), 16);
    return Math.round(x + (y - x) * f).toString(16).padStart(2, '0');
  });
  return `#${c.join('')}`;
}

/** Encre lisible (noire ou blanche) sur un fond donné. */
export function encrePour(fond) {
  return contraste(fond, ENCRE.sombre) >= contraste(fond, ENCRE.claire) ? ENCRE.sombre : ENCRE.claire;
}

/**
 * Domaine de couleur pour une grandeur. pN2 : min–max des données ; % M-value : 0–100
 * (au-delà = dépassement) ; % gradient : divergent −100 … 0 … 100.
 * @returns {{ type:'sequentiel'|'divergent', min:number, max:number, seuil:number|null }}
 */
export function domaineChaleur(lignes, cleUnite) {
  if (cleUnite === 'pctGF') return { type: 'divergent', min: -100, max: 100, seuil: 100 };
  if (cleUnite === 'pN2') {
    let min = Infinity;
    let max = -Infinity;
    for (const l of lignes) for (const v of l.pN2) { if (v < min) min = v; if (v > max) max = v; }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    if (max - min < 1e-6) max = min + 0.1;
    return { type: 'sequentiel', min, max, seuil: null };
  }
  return { type: 'sequentiel', min: 0, max: 100, seuil: 100 };
}

/**
 * Couleurs d'une cellule.
 * @returns {{ fond:string, encre:string, depasse:boolean }}
 */
export function couleurChaleur(v, domaine, theme = 'clair') {
  const r = RAMPES[theme] || RAMPES.clair;
  if (!Number.isFinite(v)) return { fond: 'transparent', encre: 'inherit', depasse: false };
  const depasse = domaine.seuil !== null && v > domaine.seuil + 1e-9;
  let fond;
  if (depasse) fond = r.depassement;
  else if (domaine.type === 'divergent') fond = interpolerHex(r.divergent, (v - domaine.min) / (domaine.max - domaine.min));
  else fond = interpolerHex(r.sequentiel, (v - domaine.min) / (domaine.max - domaine.min));
  return { fond, encre: encrePour(fond), depasse };
}

/**
 * Instant compact pour la colonne figée : « 1,5 » (minutes) puis « 1h27 », « 20h » au-delà d'une heure.
 */
export function instantCourt(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return '—';
  const signe = t < 0 ? '−' : '';
  const a = Math.abs(t);
  if (a < 59.95) return signe + formatNombre(a, Math.abs(a - Math.round(a)) < 0.05 ? 0 : 1);
  const m = Math.round(a);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${signe}${h}h${r && h < 10 ? String(r).padStart(2, '0') : ''}`;
}

// ---------------------------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------------------------

/** Échappe un champ CSV (séparateur « ; »). */
export function echapperCSV(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const LIBELLES_PHASE = {
  descente: 'descente', fond: 'fond', transition: 'transition', remontee: 'remontée', palier: 'palier', surface: 'surface',
};

/**
 * CSV du tableau, prêt pour Excel en français.
 * @param {object} res sortie de planifier()
 * @param {string} cleUnite 'pN2' | 'pctMSurf' | 'pctMAmb' | 'pctGF'
 * @param {{ bom?: boolean }} [opts] bom : préfixe UTF-8 pour qu'Excel reconnaisse les accents
 */
export function genererCSV(res, cleUnite, { bom = false } = {}) {
  const u = unite(cleUnite);
  const dec = cleUnite === 'pN2' ? 4 : 1;
  const entete = [
    'Instant (min)', 'Étape', 'Profondeur (m)', 'Phase',
    ...res.compartiments.map((c) => `C${c.n} ${String(c.demiVie).replace('.', ',')} min (${u.court})`),
    'Plafond (m)', 'Compartiment directeur',
  ];
  const lignes = [entete.map(echapperCSV).join(';')];
  for (const l of res.tableau) {
    lignes.push([
      nombreCSV(l.t, 2), l.libelle, nombreCSV(l.profondeur, 1), LIBELLES_PHASE[l.phase] || l.phase,
      ...l[u.cle].map((v) => nombreCSV(v, dec)),
      nombreCSV(l.plafond, 1), l.directeur ? `C${l.directeur}` : '',
    ].map(echapperCSV).join(';'));
  }
  return (bom ? '﻿' : '') + lignes.join('\r\n') + '\r\n';
}

/** Nom de fichier CSV parlant. */
export function nomFichierCSV(params, cleUnite) {
  const n = (params && params.niveaux) || [];
  const prof = n.length ? Math.max(...n.map((x) => x.profondeur)) : 0;
  const duree = n.reduce((s, x) => s + x.duree, 0);
  const alt = params && params.altitude ? `-alt${Math.round(params.altitude)}m` : '';
  return `paliers-${prof}m-${duree}min${alt}-${cleUnite}.csv`;
}

// ---------------------------------------------------------------------------------------------
// Rendu DOM
// ---------------------------------------------------------------------------------------------

function cree(nom, classe, parent, contenu) {
  const n = document.createElement(nom);
  if (classe) n.className = classe;
  if (contenu !== undefined) n.textContent = contenu;
  if (parent) parent.appendChild(n);
  return n;
}

/**
 * Tableau HTML des charges (lignes = instants clés, colonnes = compartiments).
 * @param {HTMLElement} conteneur
 * @param {object} res
 * @param {{ unite:string, theme:'clair'|'sombre' }} opts
 */
export function rendreTableau(conteneur, res, { unite: cleUnite, theme }) {
  conteneur.replaceChildren();
  const u = unite(cleUnite);
  const dom = domaineChaleur(res.tableau, u.cle);
  const table = cree('table', 'charges', conteneur);
  const cap = cree('caption', 'visuellement-cache', table,
    `Charges en azote des 16 compartiments aux instants clés, en ${u.libelle}. Le compartiment directeur de chaque ligne est encadré.`);
  void cap;
  const thead = cree('thead', null, table);
  const tr = cree('tr', null, thead);
  const th = (txt, classe, sous) => {
    const c = cree('th', classe, tr, txt);
    c.scope = 'col';
    if (sous) cree('span', 'sous', c, sous);
    return c;
  };
  th('Instant', 'fige f1', 'min');
  th('Étape', 'fige f2');
  th('Prof.', 'fige f3', 'm');
  for (const c of res.compartiments) {
    const h = th(`C${c.n}`, 'comp', `${formatNombre(c.demiVie, c.demiVie % 1 ? 1 : 0)} min`);
    h.title = `Compartiment ${c.n}, demi-vie ${c.demiVie} min`;
  }
  th('Plafond', 'num', 'm');
  th('Dir.', 'num');
  const tbody = cree('tbody', null, table);
  for (const l of res.tableau) {
    const ligne = cree('tr', `phase-${l.phase}`, tbody);
    cree('td', 'fige f1 num', ligne, instantCourt(l.t));
    const et = cree('th', 'fige f2', ligne, l.libelle);
    et.scope = 'row';
    cree('td', 'fige f3 num', ligne, formatNombre(l.profondeur, l.profondeur % 1 ? 1 : 0));
    l[u.cle].forEach((v, i) => {
      const td = cree('td', 'val', ligne, formatNombre(v, u.decimales));
      const coul = couleurChaleur(v, dom, theme);
      td.style.background = coul.fond;
      td.style.color = coul.encre;
      if (coul.depasse) td.classList.add('depasse');
      if (l.directeur === i + 1) {
        td.classList.add('directeur');
        td.title = `Compartiment directeur (C${i + 1})`;
      }
    });
    cree('td', 'num', ligne, l.plafond > 0 ? formatNombre(l.plafond, 1) : '—');
    cree('td', 'num', ligne, l.directeur ? `C${l.directeur}` : '—');
  }
}

/** Légende de la carte de chaleur. */
export function rendreLegende(conteneur, res, { unite: cleUnite, theme }) {
  conteneur.replaceChildren();
  const u = unite(cleUnite);
  const dom = domaineChaleur(res.tableau, u.cle);
  const r = RAMPES[theme] || RAMPES.clair;
  const stops = dom.type === 'divergent' ? r.divergent : r.sequentiel;
  cree('span', 'legende-titre', conteneur, u.libelle);
  const barre = cree('span', 'legende-barre', conteneur);
  barre.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  barre.setAttribute('aria-hidden', 'true');
  const bornes = cree('span', 'legende-bornes', conteneur);
  const d = u.decimales;
  cree('span', null, bornes, formatNombre(dom.min, d));
  if (dom.type === 'divergent') cree('span', null, bornes, '0');
  cree('span', null, bornes, formatNombre(dom.max, d));
  if (dom.seuil !== null) {
    const dep = cree('span', 'legende-depasse', conteneur);
    const p = cree('span', 'pastille', dep);
    p.style.background = r.depassement;
    dep.append(` > ${formatNombre(dom.seuil)} % (M-value dépassée)`);
  }
  const dir = cree('span', 'legende-dir', conteneur);
  cree('span', 'exemple-directeur', dir, '12');
  dir.append(' compartiment directeur');
}

export { UNITES };
