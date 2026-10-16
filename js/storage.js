// storage.js — Persistance locale : réglages, calibrations, journal (agent Données).
// Module ES pur. Utilise localStorage s'il est disponible et fonctionnel ; sinon (Node,
// navigation privée, quota dépassé, stockage bloqué) bascule sur un stockage en mémoire.
// Aucune fonction de lecture/écriture ne lève d'exception à cause du stockage.

export const SCHEMA_VERSION = 1;
export const STORAGE_PREFIX = 'cyanocalc:v1:';
const KEYS = {
  schema: `${STORAGE_PREFIX}schema`,
  settings: `${STORAGE_PREFIX}settings`,
  calibrations: `${STORAGE_PREFIX}calibrations`,
  journal: `${STORAGE_PREFIX}journal`,
};
const MAX_JOURNAL = 1000;
const MAX_CALIBRATIONS = 200;
const RESULTS = ['under', 'good', 'over'];
const FACTOR_MIN = 0.05;
const FACTOR_MAX = 20;

// ---------------------------------------------------------------------------
// Back-end de stockage
// ---------------------------------------------------------------------------

const memory = new Map();
const unsynced = new Set(); // clés dont la dernière écriture n'a pas pu atteindre localStorage
let injected; // undefined = auto-détection ; null = mémoire forcée ; objet = Storage injecté

function detectLocalStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls || typeof ls.getItem !== 'function') return null;
    const probe = `${STORAGE_PREFIX}__probe__`;
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function backend() {
  if (injected !== undefined) return injected;
  return detectLocalStorage();
}

/**
 * Remplace le stockage utilisé (tests, ou intégration spécifique).
 * `storage` : objet compatible Storage (getItem/setItem/removeItem), `null` pour forcer
 * la mémoire, `undefined` pour revenir à l'auto-détection de localStorage.
 * Vide aussi le fallback mémoire.
 */
export function useStorage(storage) {
  injected = storage;
  memory.clear();
  unsynced.clear();
}

function rawGet(key) {
  const ls = backend();
  if (ls && !unsynced.has(key)) {
    try {
      const v = ls.getItem(key);
      if (v !== null && v !== undefined) return v;
    } catch { /* lecture impossible : on tente la mémoire */ }
  }
  return memory.has(key) ? memory.get(key) : null;
}

function rawSet(key, value) {
  memory.set(key, value); // toujours garder une copie en mémoire (session courante)
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(key, value);
    unsynced.delete(key);
    return true;
  } catch {
    unsynced.add(key); // quota dépassé / stockage bloqué : la copie mémoire fait foi pour la session
    return false;
  }
}

function rawRemove(key) {
  memory.delete(key);
  unsynced.delete(key);
  const ls = backend();
  if (!ls) return;
  try { ls.removeItem(key); } catch { /* ignore */ }
}

function readJson(key, fallback) {
  const s = rawGet(key);
  if (s === null) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  ensureSchema();
  let s;
  try { s = JSON.stringify(value); } catch { return false; }
  return rawSet(key, s);
}

/** Inscrit la version du schéma ; point d'entrée pour de futures migrations (v1 → v2…). */
function ensureSchema() {
  const v = Number(rawGet(KEYS.schema));
  if (v !== SCHEMA_VERSION) rawSet(KEYS.schema, String(SCHEMA_VERSION));
}

/** Indique si les données survivront au rechargement de la page (localStorage fonctionnel). */
export function isPersistent() {
  return backend() !== null;
}

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------

let idCounter = 0;
function newId(prefix) {
  try {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`;
  } catch { /* ignore */ }
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function finiteOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v, max = 2000) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

function toIso(v, fallbackNow = true) {
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    if (Number.isFinite(d.getTime())) return d.toISOString();
  }
  return fallbackNow ? new Date().toISOString() : null;
}

function cloneJson(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
}

function clampFactor(f) {
  return Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, f));
}

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

/** @returns {object|null} réglages sauvegardés, ou null s'il n'y en a pas / s'ils sont illisibles. */
export function loadSettings() {
  const v = readJson(KEYS.settings, null);
  return isPlainObject(v) ? v : null;
}

/** Sauvegarde les réglages (objet sérialisable). Renvoie true si persistés dans localStorage. */
export function saveSettings(obj) {
  if (!isPlainObject(obj)) return false;
  const copy = cloneJson(obj);
  if (!isPlainObject(copy)) return false;
  return writeJson(KEYS.settings, copy);
}

// ---------------------------------------------------------------------------
// Calibrations
// ---------------------------------------------------------------------------

function sanitizeCalibration(c) {
  if (!isPlainObject(c)) return null;
  const factor = finiteOrNull(c.factor);
  if (factor === null || factor <= 0) return null;
  return {
    id: typeof c.id === 'string' && c.id ? c.id.slice(0, 100) : newId('cal'),
    name: str(c.name, 120).trim() || 'Calibration',
    factor: clampFactor(factor),
    createdAt: toIso(c.createdAt),
    notes: str(c.notes),
  };
}

function readCalibrations() {
  const arr = readJson(KEYS.calibrations, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(sanitizeCalibration).filter(Boolean);
}

/** @returns {Array<{id, name, factor, createdAt, notes}>} du plus récent au plus ancien. */
export function listCalibrations() {
  return readCalibrations().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Crée une calibration (ou met à jour celle dont l'`id` est fourni).
 * Lève une Error (message français) si le facteur n'est pas un nombre > 0.
 */
export function saveCalibration({ id, name, factor, notes, createdAt } = {}) {
  const f = finiteOrNull(factor);
  if (f === null || f <= 0) {
    throw new Error('Facteur de calibration invalide : il doit être un nombre strictement positif.');
  }
  const list = readCalibrations();
  const existing = typeof id === 'string' ? list.find((c) => c.id === id) : undefined;
  const cal = sanitizeCalibration({
    id: existing ? existing.id : newId('cal'),
    name: str(name, 120).trim() || `Calibration du ${new Date().toLocaleDateString('fr-FR')}`,
    factor: Math.round(f * 1000) / 1000,
    createdAt: existing ? existing.createdAt : (createdAt ?? new Date()),
    notes,
  });
  const next = existing ? list.map((c) => (c.id === cal.id ? cal : c)) : [cal, ...list];
  writeJson(KEYS.calibrations, next.slice(0, MAX_CALIBRATIONS));
  return { ...cal };
}

/** Supprime une calibration. Renvoie true si elle existait. */
export function deleteCalibration(id) {
  const list = readCalibrations();
  const next = list.filter((c) => c.id !== id);
  if (next.length === list.length) return false;
  writeJson(KEYS.calibrations, next);
  return true;
}

/**
 * Facteur de calibration personnel (multiplicatif sur le temps) :
 * bon tirage obtenu en `actualMinutes` alors que le calcul prévoyait `predictedMinutes`
 * → factor = actual / predicted (borné à [0,05 ; 20], arrondi au millième).
 * Renvoie 1 si les valeurs sont inexploitables.
 */
export function computeCalibrationFactor(actualMinutes, predictedMinutes) {
  const a = finiteOrNull(actualMinutes);
  const p = finiteOrNull(predictedMinutes);
  if (a === null || p === null || a <= 0 || p <= 0) return 1;
  return Math.round(clampFactor(a / p) * 1000) / 1000;
}

// ---------------------------------------------------------------------------
// Journal des tirages
// ---------------------------------------------------------------------------

function sanitizeEntry(e) {
  if (!isPlainObject(e)) return null;
  let place = null;
  if (isPlainObject(e.place)) place = cloneJson(e.place);
  else if (typeof e.place === 'string' && e.place.trim()) place = e.place.slice(0, 300);
  return {
    id: typeof e.id === 'string' && e.id ? e.id.slice(0, 100) : newId('log'),
    date: toIso(e.date),
    place,
    settings: isPlainObject(e.settings) ? cloneJson(e.settings) : null,
    predictedMinutes: finiteOrNull(e.predictedMinutes),
    // Temps prévu par le moteur SANS calibration personnelle (sert à recalibrer depuis le journal).
    predictedRawMinutes: finiteOrNull(e.predictedRawMinutes),
    actualMinutes: finiteOrNull(e.actualMinutes),
    result: RESULTS.includes(e.result) ? e.result : null,
    notes: str(e.notes),
  };
}

function readJournal() {
  const arr = readJson(KEYS.journal, []);
  if (!Array.isArray(arr)) return [];
  return arr.map(sanitizeEntry).filter(Boolean);
}

/** @returns {Array<entry>} du plus récent au plus ancien (par `date`). */
export function listJournal() {
  return readJournal().sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Ajoute une entrée au journal. `id` et `date` (maintenant) sont générés si absents ;
 * `result` doit valoir 'under' | 'good' | 'over' (sinon null). Renvoie l'entrée enregistrée.
 */
export function addJournalEntry(entry) {
  const list = readJournal();
  const clean = sanitizeEntry(isPlainObject(entry) ? entry : {});
  if (list.some((x) => x.id === clean.id)) clean.id = newId('log');
  const next = [clean, ...list]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, MAX_JOURNAL);
  writeJson(KEYS.journal, next);
  return cloneJson(clean);
}

/**
 * Facteur de calibration tiré du journal : moyenne géométrique des rapports temps réel / temps prévu
 * sans calibration, sur les tirages jugés « bons ». Pour les entrées anciennes sans
 * predictedRawMinutes, on retire la calibration alors active (settings.calibrationFactor).
 * @returns {{factor: number, count: number, min: number, max: number} | null} null si aucun tirage exploitable.
 */
export function journalCalibration(entries = listJournal()) {
  const ratios = [];
  for (const e of entries) {
    if (!e || e.result !== 'good' || !(e.actualMinutes > 0)) continue;
    const cal = Number(e.settings?.calibrationFactor);
    const raw = e.predictedRawMinutes > 0 ? e.predictedRawMinutes
      : e.predictedMinutes > 0 ? e.predictedMinutes / (cal > 0 ? cal : 1) : null;
    if (!raw) continue;
    ratios.push(e.actualMinutes / raw);
  }
  if (!ratios.length) return null;
  const mean = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
  return {
    factor: computeCalibrationFactor(mean, 1),
    count: ratios.length,
    min: Math.round(Math.min(...ratios) * 1000) / 1000,
    max: Math.round(Math.max(...ratios) * 1000) / 1000,
  };
}

/** Supprime une entrée du journal. Renvoie true si elle existait. */
export function deleteJournalEntry(id) {
  const list = readJournal();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  writeJson(KEYS.journal, next);
  return true;
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

/** Sauvegarde complète au format JSON (chaîne indentée). */
export function exportAll() {
  return JSON.stringify({
    app: 'cyanocalc',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: loadSettings(),
    calibrations: listCalibrations(),
    journal: listJournal(),
  }, null, 2);
}

/**
 * Importe une sauvegarde produite par exportAll() (chaîne JSON ou objet déjà parsé).
 * Par défaut FUSIONNE avec les données existantes (les éléments de même id sont remplacés),
 * `{ replace: true }` remplace tout. Les réglages importés remplacent les réglages actuels.
 * Les éléments invalides sont ignorés. Lève une Error (message français) si le fichier est
 * illisible, n'est pas une sauvegarde de l'application ou vient d'une version plus récente.
 * @returns {{ settings: boolean, calibrations: number, journal: number, skipped: number }}
 */
export function importAll(json, { replace = false } = {}) {
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json);
    } catch {
      throw new Error("Import impossible : le fichier n'est pas un JSON valide.");
    }
  }
  if (!isPlainObject(data)) {
    throw new Error("Import impossible : le contenu n'est pas une sauvegarde de l'application.");
  }
  if (data.app !== undefined && data.app !== 'cyanocalc') {
    throw new Error("Import impossible : ce fichier ne provient pas de l'application de calcul cyanotype.");
  }
  const version = data.schemaVersion === undefined ? SCHEMA_VERSION : Number(data.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new Error('Import impossible : version de sauvegarde inconnue.');
  }
  if (version > SCHEMA_VERSION) {
    throw new Error("Import impossible : cette sauvegarde provient d'une version plus récente de l'application.");
  }
  const hasAny = 'settings' in data || 'calibrations' in data || 'journal' in data;
  if (!hasAny) {
    throw new Error('Import impossible : aucune donnée reconnue (réglages, calibrations ou journal).');
  }
  if (data.calibrations !== undefined && !Array.isArray(data.calibrations)) {
    throw new Error('Import impossible : la liste des calibrations est mal formée.');
  }
  if (data.journal !== undefined && !Array.isArray(data.journal)) {
    throw new Error('Import impossible : le journal est mal formé.');
  }

  let skipped = 0;
  const clean = (arr, fn) => (arr || []).map((x) => {
    const c = fn(x);
    if (!c) skipped++;
    return c;
  }).filter(Boolean);

  const cals = clean(data.calibrations, sanitizeCalibration);
  const entries = clean(data.journal, sanitizeEntry);

  const merge = (current, incoming) => {
    const map = new Map();
    if (!replace) current.forEach((x) => map.set(x.id, x));
    incoming.forEach((x) => map.set(x.id, x));
    return [...map.values()];
  };

  let settingsImported = false;
  if (isPlainObject(data.settings)) {
    settingsImported = saveSettings(data.settings) || loadSettings() !== null;
  } else if (replace) {
    rawRemove(KEYS.settings);
  }
  if (data.calibrations !== undefined || replace) {
    const next = merge(readCalibrations(), cals)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_CALIBRATIONS);
    writeJson(KEYS.calibrations, next);
  }
  if (data.journal !== undefined || replace) {
    const next = merge(readJournal(), entries)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, MAX_JOURNAL);
    writeJson(KEYS.journal, next);
  }
  return { settings: settingsImported, calibrations: cals.length, journal: entries.length, skipped };
}

/** Efface toutes les données de l'application (réglages, calibrations, journal). */
export function clearAll() {
  Object.values(KEYS).forEach(rawRemove);
}
