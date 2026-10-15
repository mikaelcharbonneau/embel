// Historical fixtures stop before this upgrade to test its pinned predecessors.
export const API_TEXT_MULTI_ACCOUNT_MIGRATION = "20261013190236_api_text_multi_account.sql";

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function migrationKey(name: string): string {
  const match = /^(?:local)?(\d{14}_[a-z0-9_]+\.sql)$/.exec(name);
  if (!match) throw new Error(`Unrecognized fixture migration filename: ${name}`);
  return match[1]!;
}

/** LOCAL TESTS ONLY. The historical `local` marker is not a timestamp: replay
 * both filename forms chronologically while preserving their exact filenames.
 * Apply the same ordering to cutoffs so historical fixtures exclude later SQL. */
export function fixtureMigrationNames(names: readonly string[], before?: string): string[] {
  const cutoff = before === undefined ? undefined : migrationKey(before);
  return names.filter(name => name.endsWith(".sql"))
    .map(name => ({ name, key: migrationKey(name) }))
    .filter(({ key }) => cutoff === undefined || key < cutoff)
    .sort((a, b) => compare(a.key, b.key) || compare(a.name, b.name))
    .map(({ name }) => name);
}
