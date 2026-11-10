// Reads `supabase migration list --output-format json` on stdin and checks the history it shows.
//
//   supabase migration list --local --output-format json | node scripts/ci/migration-history.mjs applied
//   supabase migration list --linked --output-format json | node scripts/ci/migration-history.mjs release
//
// applied  (CI, fresh local database) every migration file is recorded as applied and the
//          database has no migration the repository lacks.
// release  (before pushing to production) the first migration (the baseline) is already
//          recorded there, production has no migration the repository lacks, and every
//          pending migration is newer than the newest one production has, so a push applies
//          them in order and never needs --include-all. Prints what a push would apply.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const present = value => typeof value === 'string' && value.trim() !== '';

/** Normalise the CLI's JSON (an object with "migrations", or the bare array) to
 * [{ local: version|null, remote: version|null }] in version order. */
export function parseMigrationList(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Input is not the JSON of "supabase migration list --output-format json".'); }
  const rows = Array.isArray(data) ? data : data?.migrations;
  if (!Array.isArray(rows)) throw new Error('Input has no "migrations" list.');
  return rows.map(row => ({ local: present(row.local) ? row.local.trim() : null, remote: present(row.remote) ? row.remote.trim() : null }))
    .sort((a, b) => (a.local ?? a.remote).localeCompare(b.local ?? b.remote));
}

/** Rows split into what is applied, pending (local only) and unknown to the repository (remote only). */
export function summarize(rows) {
  return {
    applied: rows.filter(row => row.local && row.remote).map(row => row.local),
    pending: rows.filter(row => row.local && !row.remote).map(row => row.local),
    remoteOnly: rows.filter(row => !row.local && row.remote).map(row => row.remote),
    firstLocal: rows.find(row => row.local)?.local ?? null,
  };
}

/** Problems for mode "applied" or "release"; an empty list means the check passed. */
export function checkHistory(rows, mode) {
  const { applied, pending, remoteOnly, firstLocal } = summarize(rows), problems = [];
  if (!firstLocal) problems.push('The repository has no migrations.');
  if (remoteOnly.length) problems.push(`The database has migrations the repository does not: ${remoteOnly.join(', ')}.`);
  if (mode === 'applied') {
    if (pending.length) problems.push(`Migrations not applied: ${pending.join(', ')}.`);
  } else if (mode === 'release') {
    if (firstLocal && !applied.includes(firstLocal)) problems.push(`The baseline ${firstLocal} is not recorded as applied there. Record it first (docs/baseline-release.md); pushing would replay it and fail.`);
    const newest = applied.at(-1);
    const older = newest ? pending.filter(version => version < newest) : [];
    if (older.length) problems.push(`Pending migrations older than the newest applied one (${newest}): ${older.join(', ')}. A push would refuse them; add them with a later version.`);
  } else problems.push(`Unknown mode "${mode}"; use applied or release.`);
  return problems;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  try {
    const rows = parseMigrationList(await readStdin());
    const problems = checkHistory(rows, mode);
    const { applied, pending } = summarize(rows);
    console.log(`${applied.length} applied, ${pending.length} pending${pending.length ? ': ' + pending.join(', ') : ''}.`);
    if (problems.length) { for (const problem of problems) console.error(problem); process.exit(1); }
    console.log(mode === 'applied' ? 'Every migration is recorded as applied.' : 'Release preflight passed.');
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
}
