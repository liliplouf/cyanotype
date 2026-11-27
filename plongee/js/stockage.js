// stockage.js — Mémorisation des réglages dans localStorage (toujours dans try/catch).
// Navigation privée, stockage plein ou bloqué : on retombe silencieusement sur la mémoire.

export const PREFIXE = 'paliers:v1:';

let injecte; // stockage injecté (tests) ; undefined = auto-détection
const memoire = new Map();

/** Injecte un objet compatible Storage (tests), ou undefined pour l'auto-détection. */
export function utiliserStockage(s) {
  injecte = s;
}

function stockage() {
  if (injecte !== undefined) return injecte;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const k = `${PREFIXE}__test`;
    ls.setItem(k, '1');
    ls.removeItem(k);
    return ls;
  } catch {
    return null;
  }
}

/** true si les données survivront au rechargement de la page. */
export function estPersistant() {
  return !!stockage();
}

/** Lit une valeur JSON ; `defaut` si absente ou illisible. */
export function lire(cle, defaut = null) {
  const s = stockage();
  try {
    const brut = s ? s.getItem(PREFIXE + cle) : memoire.get(cle);
    if (brut === null || brut === undefined) return defaut;
    return JSON.parse(brut);
  } catch {
    return defaut;
  }
}

/** Écrit une valeur JSON ; renvoie false en cas d'échec (quota, blocage…). */
export function ecrire(cle, valeur) {
  let brut;
  try {
    brut = JSON.stringify(valeur);
  } catch {
    return false;
  }
  if (brut === undefined) return false;
  const s = stockage();
  try {
    if (s) s.setItem(PREFIXE + cle, brut);
    else memoire.set(cle, brut);
    return true;
  } catch {
    memoire.set(cle, brut);
    return false;
  }
}

/** Supprime une clé (ou toutes les clés de l'application si `cle` est omise). */
export function effacer(cle) {
  const s = stockage();
  try {
    if (cle !== undefined) {
      if (s) s.removeItem(PREFIXE + cle);
      memoire.delete(cle);
      return;
    }
    memoire.clear();
    if (!s) return;
    const cles = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIXE)) cles.push(k);
    }
    cles.forEach((k) => s.removeItem(k));
  } catch {
    /* stockage inaccessible : rien à faire */
  }
}
