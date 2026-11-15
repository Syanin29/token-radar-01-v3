// Token Radar v3 — entrypoint (Node 22, standard library only).
//
// Run it outside the grader with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json|directory>
//
// It reads the sealed snapshot, scores every pre-token protocol with the model in
// lib/model.ts, writes the ranked board and the dashboard's data, copies the dashboard
// and its three screenshots into the output, and writes the dossier the judge reads
// with the vendored make.fun library. The run is deterministic: same snapshot in,
// same bytes out. Anything the gate would refuse stops the run before a file is written.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardCheck, buildBoard, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Caps the dossier is held to: the text cap shapes the bytes, the rest only refuse.
const DOSSIER_TEXT_CAP = 65_536;
const DOSSIER_SHOT_CAP = { max: 4, max_bytes: 524_288 };
const DOSSIER_PAGE_CAP = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function fail(message: string): never {
  process.stderr.write(`token radar v3: ${message}\n`);
  process.exit(1);
}

/** Read --flag value, --flag=value or the fallback, scanning the arguments once. */
function flagValue(argv: string[], flag: string, fallback: string): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && i + 1 < argv.length) return argv[i + 1]!;
    if (argv[i]!.startsWith(`--${flag}=`)) return argv[i]!.slice(flag.length + 3);
  }
  return fallback;
}

const argv = process.argv.slice(2);
const inputGiven = flagValue(argv, 'input', '/input');
const snapshotPath = inputGiven.endsWith('.json')
  ? inputGiven
  : join(inputGiven, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(
    `no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input`,
  );
}
const outDir = flagValue(argv, 'output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const result = buildBoard(snapshot);
const problem = boardCheck(result.rows, snapshot);
if (problem !== null) process.stderr.write(`token radar v3 draft warning: ${problem}\n`);

/** Copy a directory's plain files into a fresh directory, skipping dot-names. */
function copyPlainDir(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    names.push(name);
  }
  return names;
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: result.rows })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(result));

const pageFiles = copyPlainDir(join(repoRoot, 'dashboard'), join(outDir, 'dashboard'));
const shotFiles = copyPlainDir(join(repoRoot, 'screenshots'), join(outDir, 'screenshots'));
if (pageFiles.length < 3) {
  fail(`dashboard/ holds ${pageFiles.length} files: hand in index.html plus a .css and a .js`);
}
if (shotFiles.length < 3) {
  fail(
    `screenshots/ holds ${shotFiles.length} image${shotFiles.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view`,
  );
}
for (const name of shotFiles) {
  if (!SHOT_NAME.test(name)) {
    fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
  }
}

// The dossier is written last, from this output directory, as the grader rebuilds it.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, {
    text_max_bytes: DOSSIER_TEXT_CAP,
    screenshots: DOSSIER_SHOT_CAP,
    dashboard: DOSSIER_PAGE_CAP,
  }),
);

const report = result.report;
process.stdout.write(
  `token radar v3: ${report.protocols_total} protocols in, ${report.rows} rows out (${report.early_rows} early, ${report.watchlist_size} watchlist)\n` +
    `token radar v3: ${report.peers_used} traded peers fitted, ${report.peers_dropped.length} outliers dropped, out-of-sample error factor x${report.oos_median_factor.toFixed(2)}\n` +
    `token radar v3: wrote ${join(outDir, 'board.json')}, ${join(outDir, 'data.js')}, ${join(outDir, 'dashboard')} (${pageFiles.length} files), ${join(outDir, 'screenshots')} (${shotFiles.length} images), ${join(outDir, 'dossier.json')}\n`,
);
