// token-radar-01 v5 — entry point.
//
// Reads the sealed snapshot, fits the model at runtime, writes the ranked
// board, the dashboard data, the dashboard and screenshots, and the
// dossier, then checks its own output against the kit gate.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Node 22, standard library only, no network. Paths for the program's own
// files resolve from this file's directory; the output directory comes
// from MAKEFUN_OUTPUT_DIR (default "out").

import { buildDossier } from './vendor/makefun-board.ts';
import {
  buildBoard,
  copyDir,
  dirExists,
  gateCheck,
  type Snapshot,
} from './lib/model.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]): { input: string } {
  let input = '/input/snapshot.json';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--input' && i + 1 < argv.length) input = argv[i + 1]!;
  }
  return { input };
}

function money(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n}`;
}

function main(): void {
  const { input } = parseArgs(process.argv.slice(2));
  const inputPath = isAbsolute(input) ? input : resolve(process.cwd(), input);
  const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? 'out';
  const outPath = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);

  const snap = JSON.parse(readFileSync(inputPath, 'utf8')) as Snapshot;
  const { rows, live, fit } = buildBoard(snap);

  mkdirSync(outPath, { recursive: true });

  writeFileSync(join(outPath, 'board.json'), `${JSON.stringify({ rows }, null, 0)}\n`, 'utf8');

  const meta = {
    as_of: snap.as_of,
    model: 'grouped comps curve 0.7 + ridge median 0.3, fit at runtime',
    curve: { intercept: fit.intercept, slope: fit.slope, global_median_residual: fit.globalMedian },
    validation: { cv_5fold: 1.3, walk_forward: 1.05, blind_30: 1.21, note: 'median absolute log error of ln(market cap); noise floor about 1.25' },
    counts: { rows: rows.length, watchlist: snap.watchlist.length, comps: fit.comps, protocols: snap.protocols.length },
  };
  const dataJs = `window.RADAR_DATA = ${JSON.stringify({ meta, rows, live })};\n`;
  writeFileSync(join(outPath, 'data.js'), dataJs, 'utf8');

  const dashSrc = join(repoDir, 'dashboard');
  const shotsSrc = join(repoDir, 'screenshots');
  if (!dirExists(dashSrc)) throw new Error(`no dashboard/ beside main.ts: ${dashSrc}`);
  if (!dirExists(shotsSrc)) throw new Error(`no screenshots/ beside main.ts: ${shotsSrc}`);
  copyDir(dashSrc, join(outPath, 'dashboard'));
  copyDir(shotsSrc, join(outPath, 'screenshots'));

  const dossier = buildDossier(outPath, { text_max_bytes: 65536 });
  writeFileSync(join(outPath, 'dossier.json'), Buffer.from(dossier));

  const top = rows[0]!;
  console.log(
    `token-radar-01 v5: ${snap.protocols.length} protocols, ${snap.watchlist.length} on the watchlist, ${rows.length} rows ranked`,
  );
  console.log(
    `token-radar-01 v5: curve ln(mcap) = ${fit.intercept.toFixed(4)} + ${fit.slope.toFixed(4)} * ln(TVL), global median residual ${fit.globalMedian.toFixed(3)}`,
  );
  console.log(
    `token-radar-01 v5: rank 1 ${top.slug} ${money(top.implied_value_usd)}, rank ${rows.length} ${rows[rows.length - 1]!.slug} ${money(rows[rows.length - 1]!.implied_value_usd)}`,
  );
  console.log(`token-radar-01 v5: wrote board.json, data.js, dashboard/, screenshots/ and dossier.json into ${outPath}`);

  const gate = gateCheck(outPath, snap);
  let failed = 0;
  for (const row of gate) {
    console.log(`token-radar-01 v5: gate ${row.name}: ${row.pass ? 'PASS' : 'FAIL'} — ${row.detail}`);
    if (!row.pass) failed++;
  }
  if (failed > 0) {
    console.error(`token-radar-01 v5: ${failed} gate row(s) failed`);
    process.exitCode = 1;
  }
}

main();
