// token-radar-01, entry radar-2: the fitted launch radar.
//
// Run shape (the kit's contract, kept exactly): read the sealed snapshot, fit the value model
// on its trading protocols, validate it on the half of them each fit never saw, rank the
// launch candidates, and write into the output directory — board.json, the dashboard's data
// script beside the page, copies of dashboard/ and screenshots/, and dossier.json from the
// vendored library, written last because the scorer rebuilds it from the same output and
// compares bytes. Two runs of this program on the same snapshot write the same bytes: the
// model is a fixed function of the snapshot, and nothing here reads a clock or a network.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));

/** The dossier's caps, as the scorer's reference states them. */
const DOSSIER_TEXT_MAX = 65_536;
const DOSSIER_SHOTS = { max: 4, max_bytes: 524_288 };
const DOSSIER_DASHBOARD = { max_files: 400, max_bytes: 4_194_304 };
const SHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** Read `--name value` or `--name=value` from the arguments, else the fallback. */
function flag(name: string, fallback: string): string {
  const args = process.argv.slice(2);
  const at = args.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < args.length) return args[at + 1]!;
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

function fail(message: string): never {
  process.stderr.write(`launch radar: ${message}\n`);
  process.exit(2);
}

const inputArg = flag('input', '/input');
const inputPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputPath)) fail(`no snapshot at ${inputPath}: pass --input <snapshot.json|directory> or mount the sealed /input`);
const outDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) fail(`the model wrote a board the gate refuses: ${issue}`);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataScript(radar));

/** Copy a directory's regular files across, skipping dot names; returns the names copied. */
function copyTree(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const names: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    names.push(name);
  }
  return names;
}

const pageFiles = copyTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const shots = copyTree(join(root, 'screenshots'), join(outDir, 'screenshots'));
if (shots.length < 3) fail(`screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view`);
for (const name of shots) {
  if (!SHOT_NAME.test(name)) fail(`screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters`);
}

// Written last, from the finished output, as the scorer will rebuild it.
writeFileSync(
  join(outDir, 'dossier.json'),
  buildDossier(outDir, { text_max_bytes: DOSSIER_TEXT_MAX, screenshots: DOSSIER_SHOTS, dashboard: DOSSIER_DASHBOARD }),
);

const d = radar.diagnostics;
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols, ${radar.counts.pre_token} record no token, ${board.length} launch candidates ranked, ${radar.counts.live} trading protocols fitted\n` +
    `launch radar: held-out median error x${d.pooled_median_factor} (folds x${d.folds[0]!.heldout_median_factor} and x${d.folds[1]!.heldout_median_factor}); wrote board.json, data.js, dashboard/ (${pageFiles.length} files), screenshots/ (${shots.length}) and dossier.json in ${outDir}\n`,
);
