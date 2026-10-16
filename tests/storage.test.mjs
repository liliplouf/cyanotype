import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadSettings, saveSettings, listCalibrations, saveCalibration, deleteCalibration,
  computeCalibrationFactor, listJournal, addJournalEntry, deleteJournalEntry,
  exportAll, importAll, useStorage, clearAll, isPersistent, STORAGE_PREFIX, SCHEMA_VERSION,
} from '../js/storage.js';

class FakeStorage {
  constructor() { this.m = new Map(); }
  get length() { return this.m.size; }
  key(i) { return [...this.m.keys()][i] ?? null; }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

beforeEach(() => {
  delete globalThis.localStorage;
  useStorage(undefined); // auto-détection
  clearAll();
});

test('Node sans localStorage : fallback mémoire, aucune exception', () => {
  assert.equal(isPersistent(), false);
  assert.equal(loadSettings(), null);
  saveSettings({ chemistry: 'classic', glass: 'none' });
  assert.deepEqual(loadSettings(), { chemistry: 'classic', glass: 'none' });
  assert.deepEqual(listCalibrations(), []);
  assert.deepEqual(listJournal(), []);
});

test('réglages : copie défensive, entrées invalides ignorées', () => {
  const s = { a: 1, nested: { b: 2 } };
  saveSettings(s);
  s.nested.b = 99;
  assert.equal(loadSettings().nested.b, 2);
  assert.equal(saveSettings(null), false);
  assert.equal(saveSettings([1, 2]), false);
  assert.equal(saveSettings('x'), false);
  assert.equal(loadSettings().a, 1);
});

test('localStorage réel : clés préfixées cyanocalc:v1: et version du schéma', () => {
  const ls = new FakeStorage();
  globalThis.localStorage = ls;
  assert.equal(isPersistent(), true);
  assert.equal(saveSettings({ x: 1 }), true);
  saveCalibration({ name: 'A', factor: 1.2 });
  addJournalEntry({ result: 'good' });
  const keys = [...ls.m.keys()];
  assert.ok(keys.length >= 4);
  assert.ok(keys.every((k) => k.startsWith(STORAGE_PREFIX)), keys.join());
  assert.equal(STORAGE_PREFIX, 'cyanocalc:v1:');
  assert.equal(ls.getItem('cyanocalc:v1:schema'), String(SCHEMA_VERSION));
  assert.deepEqual(JSON.parse(ls.getItem('cyanocalc:v1:settings')), { x: 1 });
  // Données corrompues → valeurs par défaut sans exception
  ls.setItem('cyanocalc:v1:settings', '{oops');
  ls.setItem('cyanocalc:v1:calibrations', '"pas un tableau"');
  ls.setItem('cyanocalc:v1:journal', '[{"id":"z","result":"bizarre"}, 42, null]');
  assert.equal(loadSettings(), null);
  assert.deepEqual(listCalibrations(), []);
  const j = listJournal();
  assert.equal(j.length, 1);
  assert.equal(j[0].result, null);
});

test('localStorage qui lève (mode privé / quota) : fallback mémoire', () => {
  const boom = () => { throw new Error('QuotaExceededError'); };
  globalThis.localStorage = { getItem: boom, setItem: boom, removeItem: boom, key: boom, length: 0 };
  assert.equal(isPersistent(), false);
  assert.doesNotThrow(() => saveSettings({ y: 2 }));
  assert.deepEqual(loadSettings(), { y: 2 });
  const c = saveCalibration({ name: 'B', factor: 0.9 });
  assert.equal(listCalibrations()[0].id, c.id);
  assert.doesNotThrow(() => clearAll());
});

test('localStorage dont seul setItem lève (quota dépassé) : la session garde les données', () => {
  const ls = new FakeStorage();
  globalThis.localStorage = ls;
  saveSettings({ v: 1 });
  ls.setItem = () => { throw new Error('QuotaExceededError'); };
  assert.equal(saveSettings({ v: 2 }), false);
  assert.equal(loadSettings().v, 2); // la copie mémoire fait foi pour la session
});

test('calibrations : création, ids uniques, mise à jour, suppression', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(saveCalibration({ name: `C${i}`, factor: 1 + i / 100 }).id);
  assert.equal(ids.size, 50);
  clearAll();

  const a = saveCalibration({ name: 'Été, papier Arches', factor: 1.25, notes: 'verre float' });
  assert.equal(typeof a.id, 'string');
  assert.equal(a.name, 'Été, papier Arches');
  assert.equal(a.factor, 1.25);
  assert.equal(a.notes, 'verre float');
  assert.ok(!Number.isNaN(Date.parse(a.createdAt)));
  const b = saveCalibration({ factor: '0.8' });
  assert.match(b.name, /^Calibration du /);
  assert.equal(b.factor, 0.8);
  assert.equal(listCalibrations().length, 2);

  const a2 = saveCalibration({ id: a.id, name: 'Renommée', factor: 1.3 });
  assert.equal(a2.id, a.id);
  assert.equal(a2.createdAt, a.createdAt);
  assert.equal(listCalibrations().length, 2);
  assert.equal(listCalibrations().find((c) => c.id === a.id).name, 'Renommée');

  assert.throws(() => saveCalibration({ name: 'x', factor: 0 }), /Facteur de calibration invalide/);
  assert.throws(() => saveCalibration({ name: 'x', factor: 'abc' }), /invalide/);
  assert.throws(() => saveCalibration({ name: 'x', factor: -2 }), /invalide/);

  assert.equal(deleteCalibration(a.id), true);
  assert.equal(deleteCalibration(a.id), false);
  assert.deepEqual(listCalibrations().map((c) => c.id), [b.id]);
});

test('calibrations : triées de la plus récente à la plus ancienne', () => {
  saveCalibration({ name: 'vieille', factor: 1, createdAt: '2025-01-01T00:00:00Z' });
  saveCalibration({ name: 'récente', factor: 1, createdAt: '2026-05-01T00:00:00Z' });
  assert.deepEqual(listCalibrations().map((c) => c.name), ['récente', 'vieille']);
});

test('computeCalibrationFactor', () => {
  assert.equal(computeCalibrationFactor(12, 10), 1.2);
  assert.equal(computeCalibrationFactor(5, 10), 0.5);
  assert.equal(computeCalibrationFactor(10, 3), 3.333);
  assert.equal(computeCalibrationFactor(0, 10), 1);
  assert.equal(computeCalibrationFactor(10, 0), 1);
  assert.equal(computeCalibrationFactor(NaN, 10), 1);
  assert.equal(computeCalibrationFactor(10, Infinity), 1);
  assert.equal(computeCalibrationFactor(1000, 1), 20); // borné
  assert.equal(computeCalibrationFactor('15', '10'), 1.5);
});

test('journal : ajout, normalisation, tri, suppression', () => {
  const e1 = addJournalEntry({
    date: new Date('2026-07-01T10:00:00Z'), place: 'Arles', settings: { chemistry: 'classic' },
    predictedMinutes: 10, actualMinutes: 12, result: 'good', notes: 'beau bleu',
  });
  assert.equal(typeof e1.id, 'string');
  assert.equal(e1.date, '2026-07-01T10:00:00.000Z');
  assert.equal(e1.result, 'good');
  assert.deepEqual(e1.settings, { chemistry: 'classic' });
  const e2 = addJournalEntry({ date: '2026-08-01T10:00:00Z', result: 'over', predictedMinutes: 'x', place: { label: 'Paris', lat: 48.8, lon: 2.3 } });
  assert.equal(e2.predictedMinutes, null);
  assert.deepEqual(e2.place, { label: 'Paris', lat: 48.8, lon: 2.3 });
  const e3 = addJournalEntry({ result: 'nimporte' });
  assert.equal(e3.result, null);
  assert.ok(!Number.isNaN(Date.parse(e3.date)));
  // id fourni en double → régénéré
  const e4 = addJournalEntry({ id: e1.id, date: '2020-01-01T00:00:00Z', result: 'under' });
  assert.notEqual(e4.id, e1.id);
  assert.doesNotThrow(() => addJournalEntry(null));

  const list = listJournal();
  assert.equal(list.length, 5);
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1].date >= list[i].date);
  assert.equal(new Set(list.map((x) => x.id)).size, 5);

  assert.equal(deleteJournalEntry(e2.id), true);
  assert.equal(deleteJournalEntry(e2.id), false);
  assert.equal(listJournal().length, 4);
});

test('export / import : aller-retour, fusion et remplacement', () => {
  saveSettings({ chemistry: 'new_ware' });
  const c = saveCalibration({ name: 'C', factor: 1.1 });
  const j = addJournalEntry({ date: '2026-06-01T12:00:00Z', result: 'good', actualMinutes: 9 });
  const dump = exportAll();
  const parsed = JSON.parse(dump);
  assert.equal(parsed.app, 'cyanocalc');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.calibrations.length, 1);

  clearAll();
  assert.equal(loadSettings(), null);
  const r = importAll(dump);
  assert.deepEqual(r, { settings: true, calibrations: 1, journal: 1, skipped: 0 });
  assert.deepEqual(loadSettings(), { chemistry: 'new_ware' });
  assert.equal(listCalibrations()[0].id, c.id);
  assert.equal(listJournal()[0].id, j.id);

  // Fusion : pas de doublon, nouveaux éléments ajoutés
  importAll(dump);
  assert.equal(listCalibrations().length, 1);
  importAll({ calibrations: [{ id: 'autre', name: 'Autre', factor: 2, createdAt: '2026-01-01T00:00:00Z' }] });
  assert.equal(listCalibrations().length, 2);
  assert.deepEqual(loadSettings(), { chemistry: 'new_ware' }); // réglages intacts

  // Remplacement
  importAll({ schemaVersion: 1, calibrations: [{ id: 'seule', name: 'S', factor: 1.5 }], journal: [] }, { replace: true });
  assert.deepEqual(listCalibrations().map((x) => x.id), ['seule']);
  assert.deepEqual(listJournal(), []);
  assert.equal(loadSettings(), null);
});

test('import : validation et messages en français', () => {
  saveSettings({ keep: true });
  assert.throws(() => importAll('{pas du json'), /JSON valide/);
  assert.throws(() => importAll('[1,2]'), /n'est pas une sauvegarde/);
  assert.throws(() => importAll('42'), /n'est pas une sauvegarde/);
  assert.throws(() => importAll({ app: 'autre', settings: {} }), /ne provient pas/);
  assert.throws(() => importAll({ schemaVersion: 2, settings: {} }), /plus récente/);
  assert.throws(() => importAll({ schemaVersion: 'abc', settings: {} }), /version/);
  assert.throws(() => importAll({ foo: 1 }), /aucune donnée/);
  assert.throws(() => importAll({ calibrations: 'x' }), /calibrations est mal formée/);
  assert.throws(() => importAll({ journal: {} }), /journal est mal formé/);
  assert.deepEqual(loadSettings(), { keep: true }); // rien n'a été modifié

  const r = importAll({ calibrations: [{ name: 'ok', factor: 1.2 }, { name: 'ko', factor: -1 }, 'x', null] });
  assert.equal(r.calibrations, 1);
  assert.equal(r.skipped, 3);
  assert.equal(listCalibrations().length, 1);
  assert.equal(typeof listCalibrations()[0].id, 'string'); // id généré
});

test('useStorage : injection d’un Storage et retour au mode mémoire', () => {
  const ls = new FakeStorage();
  useStorage(ls);
  saveSettings({ z: 3 });
  assert.equal(JSON.parse(ls.getItem('cyanocalc:v1:settings')).z, 3);
  useStorage(null);
  assert.equal(isPersistent(), false);
  assert.equal(loadSettings(), null);
});
