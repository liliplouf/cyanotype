#!/usr/bin/env node
// Batterie de tests : lance toutes les suites tests/*.test.mjs avec node:test,
// affiche un résumé et écrit reports/test-report.json + reports/test-history.json
// (lus par le tableau de bord d'avancement).
import { run } from 'node:test';
import { readdirSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = join(root, 'tests');
const reportsDir = join(root, 'reports');
const label = process.argv[2] || 'manuel';

const files = readdirSync(testsDir)
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => join(testsDir, f));

const perFile = new Map(files.map((f) => [f, { pass: 0, fail: 0, skip: 0, durationMs: 0 }]));
const failures = [];
const started = Date.now();

const stream = run({ files, concurrency: true });
stream.on('data', () => {});
stream.on('test:pass', (e) => count(e, 'pass'));
stream.on('test:fail', (e) => count(e, 'fail'));
await new Promise((resolve) => stream.on('end', resolve));

function count(e, kind) {
  // On ne compte que les tests « feuilles » (pas les describe ni le fichier lui-même).
  if (e.details?.type === 'suite' || !e.file || e.name === e.file) return;
  const s = perFile.get(e.file) ?? perFile.set(e.file, { pass: 0, fail: 0, skip: 0, durationMs: 0 }).get(e.file);
  if (e.skip || e.todo) s.skip++;
  else s[kind]++;
  s.durationMs += e.details?.duration_ms ?? 0;
  if (kind === 'fail') {
    failures.push({
      suite: basename(e.file, '.test.mjs'),
      test: e.name,
      message: String(e.details?.error?.cause?.message ?? e.details?.error?.message ?? '').slice(0, 300),
    });
  }
}

const suites = [...perFile].map(([file, s]) => ({
  suite: basename(file, '.test.mjs'),
  fichier: relative(root, file),
  reussis: s.pass,
  echecs: s.fail,
  ignores: s.skip,
  duree_ms: Math.round(s.durationMs * 10) / 10,
}));
const total = suites.reduce((a, s) => ({ pass: a.pass + s.reussis, fail: a.fail + s.echecs }), { pass: 0, fail: 0 });
const at = new Date().toISOString();

mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, 'test-report.json'), JSON.stringify({ at, label, suites, failures }, null, 2));
writeFileSync(join(reportsDir, 'suites.json'), JSON.stringify(suites, null, 2));

const historyPath = join(reportsDir, 'test-history.json');
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : [];
history.push({ at, etape: label, reussis: total.pass, echecs: total.fail, duree_ms: Date.now() - started });
writeFileSync(historyPath, JSON.stringify(history, null, 2));

for (const s of suites) {
  console.log(`${s.echecs ? '✗' : '✓'} ${s.suite.padEnd(12)} ${String(s.reussis).padStart(3)} réussis  ${s.echecs} échec(s)`);
}
for (const f of failures) console.log(`  ✗ [${f.suite}] ${f.test}\n      ${f.message}`);
console.log(`\nTotal : ${total.pass} réussis, ${total.fail} échec(s) — rapport dans reports/`);
process.exit(total.fail ? 1 : 0);
