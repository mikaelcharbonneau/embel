// Guards for supabase/migrations (task B4). Run in CI on every pull request and push to main:
//
//   node scripts/ci/migration-guard.mjs [--base <git ref>]
//
// With --base the guards that compare against the base branch run too (a pull request may only
// ADD migration files). Without it only the checks on the current tree run. No network, no
// database: it reads the working tree and asks git for the diff.
//
//   names    file names match ^\d{14}_[a-z0-9_]+\.sql$ and versions strictly increase; a new
//            migration also sorts after every migration already on the base branch
//   history  no migration that exists on the base branch is modified, renamed or deleted
//   archive  nothing is added under supabase/archive (history only)
//   grants   every create [or replace] function in an ADDED migration is followed, in the same
//            file, by an explicit revoke (from public, anon or authenticated) and, for functions
//            in schema public, a grant execute. Functions in private schemas such as
//            fluid_private need the revoke only: they are never granted. Trigger functions are
//            exempt from the grant. Matching is by schema-qualified name, not argument list.
//   secrets  no postgres:// URL with a password, sb_secret_ key, sk- key or JWT in any migration
//
// Exit status 1 and one line per finding when anything fails. Findings never repeat the secret.
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
export const MIGRATIONS_DIR = "supabase/migrations";
export const ARCHIVE_DIR = "supabase/archive";
export const NAME_PATTERN = /^\d{14}_[a-z0-9_]+\.sql$/;
const REVOKE_ROLES = ["public", "anon", "authenticated"];

/** Blank out comments, string literals and dollar-quoted bodies, keeping every character
 * offset and newline in place so statement positions still map to lines. */
export function stripSql(sql) {
  const out = sql.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i],
      next = sql[i + 1];
    if (c === "-" && next === "-") {
      let end = sql.indexOf("\n", i);
      if (end < 0) end = sql.length;
      blank(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      let depth = 1,
        j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
    } else if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? " ");
      let j = i + 1;
      while (j < sql.length) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      blank(i + 1, j);
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      i = j + 1;
    } else if (c === "$") {
      const open = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (!open || /[\w$]/.test(sql[i - 1] ?? " ")) {
        i++;
        continue;
      }
      const close = sql.indexOf(open[0], i + open[0].length);
      const end = close < 0 ? sql.length : close;
      blank(i + open[0].length, end);
      i = close < 0 ? sql.length : close + open[0].length;
    } else i++;
  }
  return out.join("");
}

/** The sanitised statements of a file with the line each one starts on. */
export function statements(sql) {
  const clean = stripSql(sql),
    result = [];
  let start = 0;
  for (let i = 0; i <= clean.length; i++) {
    if (i === clean.length || clean[i] === ";") {
      const text = clean.slice(start, i);
      const lead = text.length - text.trimStart().length;
      if (text.trim()) result.push({ text: text.trim(), line: clean.slice(0, start + lead).split("\n").length });
      start = i + 1;
    }
  }
  return result;
}

const IDENT = '(?:"(?:[^"]|"")+"|[A-Za-z_][\\w$]*)';
const QUALIFIED = `${IDENT}(?:\\s*\\.\\s*${IDENT})?`;

/** schema.name in lower case without quotes; an unqualified name is in public. */
export function normalizeName(raw) {
  const parts = raw.trim().match(new RegExp(IDENT, "g")) ?? [];
  const clean = parts.map((part) =>
    part.startsWith('"') ? part.slice(1, -1).replaceAll('""', '"') : part.toLowerCase(),
  );
  return clean.length >= 2 ? `${clean[0]}.${clean[1]}` : `public.${clean[0] ?? ""}`;
}

/** The function names in "a(uuid), b.c(text, int)" (commas inside parentheses ignored). */
export function functionList(text) {
  const names = [],
    depth = { n: 0 };
  let current = "";
  for (const ch of text + ",") {
    if (ch === "(") depth.n++;
    if (ch === ")") depth.n--;
    if (ch === "," && depth.n === 0) {
      if (current.trim()) names.push(normalizeName(current.split("(")[0]));
      current = "";
    } else current += ch;
  }
  return names;
}

const rolesOf = (text) =>
  text
    .split(",")
    .map((role) => role.trim().toLowerCase().replace(/^"|"$/g, ""))
    .filter(Boolean);

/** Functions created, revoked and granted by one migration's SQL, in statement order. */
export function functionStatements(sql) {
  const created = [],
    revokes = [],
    grants = [];
  statements(sql).forEach((statement, index) => {
    const create = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?function\\s+(${QUALIFIED})\\s*\\(`, "i").exec(
      statement.text,
    );
    if (create) {
      created.push({
        name: normalizeName(create[1]),
        line: statement.line,
        index,
        trigger: /\breturns\s+trigger\b/i.test(statement.text),
      });
      return;
    }
    const revoke =
      /^revoke\s+(?:grant\s+option\s+for\s+)?(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|routine)\s+([\s\S]+?)\s+from\s+([\s\S]+?)(?:\s+(?:cascade|restrict))?$/i.exec(
        statement.text,
      );
    if (revoke) {
      revokes.push({ names: functionList(revoke[1]), roles: rolesOf(revoke[2]), index });
      return;
    }
    const grant =
      /^grant\s+(?:all(?:\s+privileges)?|execute)\s+on\s+(?:function|routine)\s+([\s\S]+?)\s+to\s+([\s\S]+?)(?:\s+with\s+grant\s+option)?$/i.exec(
        statement.text,
      );
    if (grant) grants.push({ names: functionList(grant[1]), roles: rolesOf(grant[2]), index });
  });
  return { created, revokes, grants };
}

/** Rule "grants": findings for one added migration. */
export function checkFunctionGrants(file, sql) {
  const { created, revokes, grants } = functionStatements(sql),
    findings = [];
  const seen = new Set();
  for (const fn of created) {
    if (seen.has(fn.name)) continue; // a later "or replace" of the same function is covered by the first check
    seen.add(fn.name);
    const after = (list) => list.filter((entry) => entry.index > fn.index && entry.names.includes(fn.name));
    if (!after(revokes).some((entry) => entry.roles.some((role) => REVOKE_ROLES.includes(role)))) {
      findings.push({
        rule: "grants",
        file,
        line: fn.line,
        message: `${fn.name} has no later "revoke ... on function ${fn.name}(...) from public" (or anon/authenticated) in this file; new functions must be private until granted explicitly`,
      });
    }
    if (fn.name.startsWith("public.") && !fn.trigger && !after(grants).length) {
      findings.push({
        rule: "grants",
        file,
        line: fn.line,
        message: `${fn.name} has no later "grant execute on function ${fn.name}(...) to <role>" in this file; a public function nobody can call is almost certainly a mistake`,
      });
    }
  }
  return findings;
}

const SECRET_PATTERNS = [
  ["a postgres connection URL with a password", /postgres(?:ql)?:\/\/[^\s:/@'"]+:[^\s@'"]+@/i],
  ["a Supabase secret key (sb_secret_)", /sb_secret_[A-Za-z0-9_-]{8,}/],
  ["an API key (sk-)", /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/],
  ["a JWT", /eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
];

/** Rule "secrets": one finding per line that looks like a credential (never printing it). */
export function checkSecrets(file, sql) {
  const findings = [];
  sql.split("\n").forEach((text, index) => {
    for (const [label, pattern] of SECRET_PATTERNS) {
      if (pattern.test(text))
        findings.push({
          rule: "secrets",
          file,
          line: index + 1,
          message: `looks like ${label}; migrations are public history, keep secrets out of them`,
        });
    }
  });
  return findings;
}

export const versionOf = (name) => name.slice(0, 14);

/** Rule "names": file names and ordering. addedNames are the files this pull request adds;
 * baseNames the migration files on the base branch (null when there is no base to compare). */
export function checkNames(names, { addedNames = [], baseNames = null } = {}) {
  const findings = [],
    sorted = [...names].sort();
  for (const name of sorted) {
    if (!NAME_PATTERN.test(name))
      findings.push({
        rule: "names",
        file: `${MIGRATIONS_DIR}/${name}`,
        message:
          "migration file names must match ^\\d{14}_[a-z0-9_]+\\.sql$ (a 14-digit timestamp version, then lower-case words with underscores)",
      });
  }
  const valid = sorted.filter((name) => NAME_PATTERN.test(name));
  for (let i = 1; i < valid.length; i++) {
    if (versionOf(valid[i]) === versionOf(valid[i - 1]))
      findings.push({
        rule: "names",
        file: `${MIGRATIONS_DIR}/${valid[i]}`,
        message: `version ${versionOf(valid[i])} is already used by ${valid[i - 1]}; versions must be unique and strictly increasing`,
      });
  }
  if (baseNames) {
    const baseValid = baseNames.filter((name) => NAME_PATTERN.test(name)).sort();
    const newest = baseValid.at(-1);
    for (const name of addedNames.filter((entry) => NAME_PATTERN.test(entry))) {
      if (newest && versionOf(name) <= versionOf(newest)) {
        findings.push({
          rule: "names",
          file: `${MIGRATIONS_DIR}/${name}`,
          message: `version ${versionOf(name)} is not after ${versionOf(newest)}, the newest migration on the base branch; rename it with a later timestamp so every database applies it last`,
        });
      }
    }
  }
  return findings;
}

/** Parse `git diff --name-status -z --no-renames` output into [{ status, file }]. */
export function parseNameStatus(output) {
  const parts = output.split("\0").filter(Boolean),
    changes = [];
  for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i][0], file: parts[i + 1] });
  return changes;
}

/** Rules "history" and "archive" from the diff against the base branch. */
export function checkChanges(changes) {
  const findings = [];
  for (const { status, file } of changes) {
    if (file.startsWith(`${MIGRATIONS_DIR}/`) && status !== "A") {
      const what = status === "D" ? "deleted or renamed" : "modified";
      findings.push({
        rule: "history",
        file,
        message: `${what}: a migration that exists on the base branch is already applied somewhere and must never change; add a new migration instead`,
      });
    }
    if (file.startsWith(`${ARCHIVE_DIR}/`) && status === "A") {
      findings.push({ rule: "archive", file, message: `${ARCHIVE_DIR} is history only; nothing may be added to it` });
    }
  }
  return findings;
}

/** Every guard over plain data, so tests need no git or file system.
 * files: { name: sql } for supabase/migrations; changes: parseNameStatus output or null;
 * baseNames: migration file names on the base branch or null. */
export function runGuards({ files, changes = null, baseNames = null }) {
  const added = changes
    ? changes
        .filter((change) => change.status === "A" && change.file.startsWith(`${MIGRATIONS_DIR}/`))
        .map((change) => path.posix.basename(change.file))
    : [];
  const findings = [...checkNames(Object.keys(files), { addedNames: added, baseNames: changes ? baseNames : null })];
  if (changes) findings.push(...checkChanges(changes));
  for (const [name, sql] of Object.entries(files)) {
    findings.push(...checkSecrets(`${MIGRATIONS_DIR}/${name}`, sql));
    if (added.includes(name)) findings.push(...checkFunctionGrants(`${MIGRATIONS_DIR}/${name}`, sql));
  }
  return findings;
}

export function formatFinding({ rule, file, line, message }) {
  return `[${rule}] ${file}${line ? `:${line}` : ""}: ${message}`;
}

async function git(root, args) {
  return (await run("git", args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

/** Read the tree and (with a base) the diff, then run every guard. */
export async function checkRepository(root, base = null) {
  const directory = path.join(root, MIGRATIONS_DIR);
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const files = {};
  for (const name of names) files[name] = await readFile(path.join(directory, name), "utf8");
  let changes = null,
    baseNames = null;
  if (base) {
    changes = parseNameStatus(
      await git(root, [
        "diff",
        "--name-status",
        "-z",
        "--no-renames",
        `${base}...HEAD`,
        "--",
        MIGRATIONS_DIR,
        ARCHIVE_DIR,
      ]),
    );
    baseNames = (await git(root, ["ls-tree", "-r", "--name-only", base, "--", `${MIGRATIONS_DIR}/`]))
      .split("\n")
      .filter(Boolean)
      .map((file) => path.posix.basename(file));
  }
  return {
    findings: runGuards({ files, changes, baseNames }),
    checked: names.length,
    added: changes?.filter((change) => change.status === "A").length ?? null,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseIndex = process.argv.indexOf("--base");
  const base = baseIndex > 0 ? process.argv[baseIndex + 1] : null;
  if (baseIndex > 0 && !base) {
    console.error("--base needs a git ref.");
    process.exit(2);
  }
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  try {
    const { findings, checked, added } = await checkRepository(root, base);
    if (findings.length) {
      for (const finding of findings) console.error(formatFinding(finding));
      console.error(`\n${findings.length} migration guard finding${findings.length === 1 ? "" : "s"}.`);
      process.exit(1);
    }
    console.log(
      `Migration guards passed: ${checked} migration file${checked === 1 ? "" : "s"} checked` +
        (base
          ? `, ${added} file${added === 1 ? "" : "s"} added against ${base}.`
          : " (no base given: history, ordering-against-base and function-grant checks skipped)."),
    );
  } catch (error) {
    console.error(`Migration guard could not run: ${error.message}`);
    process.exit(2);
  }
}
