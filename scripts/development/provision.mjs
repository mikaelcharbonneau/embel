// Local deployment settings for a database built from supabase/migrations: the shared
// HTTP target row and the passwords and registry rows of the three restricted web logins
// the baseline creates (Home attachments, Creative direction writes, Logo uploads).
// Loopback Docker stack only; never production.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DevelopmentError, localDockerEnvironment, migrationSources, privateDirectory, readOptional, repositoryRoot, settingsFor, writeState } from './config.mjs';

export const sqlLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
const q = sqlLiteral;

/** The web lanes and their login roles. The names are production's; a local stack sets
 * its own passwords (no password leaves the machine, and the baseline sets none). */
export const HTTP_LANES = Object.freeze([
 { lane: 'identity', roleName: 'embel_shared_http_identity_prod_v1', registry: 'shared_http_principals' },
 { lane: 'home', roleName: 'embel_shared_http_home_prod_v1', registry: 'shared_http_principals' },
 { lane: 'logo', roleName: 'embel_shared_http_logo_prod_v1', registry: 'shared_logo_http_principals' },
]);

function command(binary, args, env, input) {
 return new Promise((resolve, reject) => {
  const child = spawn(binary, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.on('error', () => {}); // psql may reject a guard before consuming its input.
  const timer = setTimeout(() => child.kill('SIGTERM'), 180_000);
  child.on('error', () => { clearTimeout(timer); reject(new DevelopmentError('Local provisioning command could not start.')); });
  child.on('close', code => {
   clearTimeout(timer);
   if (code === 0) resolve(output.trim());
   else {
    // Never expose a SQL statement, credential, CLI status or URL in errors.
    const diagnostic = errors.match(/ERROR:\s+([a-z][a-z_]{5,90})(?:\s|$)/)?.[1];
    reject(new DevelopmentError('Local provisioning failed' + (diagnostic ? ' (' + diagnostic + ')' : '') + '. Private command output withheld.'));
   }
  });
  child.stdin.end(input ?? '');
 });
}

/** This checkout's loopback database, reached through the CLI's own container. */
export async function developmentDatabase(root = repositoryRoot) {
 if (Object.keys(process.env).some(key => key === 'VERCEL' || key.startsWith('VERCEL_'))) throw new DevelopmentError('Use a development shell without hosted Vercel markers.');
 const settings = await settingsFor(root), state = path.join(root, '.embel-dev');
 if (!await readOptional(path.join(state, 'settings.json'))) throw new DevelopmentError('Run npm run dev:up first.');
 let endpoint = process.env.DOCKER_CONTEXT ? null : process.env.DOCKER_HOST;
 if (!endpoint) {
  const context = process.env.DOCKER_CONTEXT || await command('docker', ['context', 'show'], process.env);
  endpoint = JSON.parse(await command('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], process.env));
 }
 const environment = localDockerEnvironment(endpoint), container = 'supabase_db_' + settings.projectId;
 const inspect = JSON.parse(await command('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', container], environment));
 if (!inspect['5432/tcp']?.length || inspect['5432/tcp'].some(p => !['127.0.0.1', '::1'].includes(p.HostIp) || p.HostPort !== String(settings.dbPort))) throw new DevelopmentError('Provisioning requires this checkout’s loopback-only database.');
 const sql = source => command('docker', ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], environment, "set search_path='';\n" + source);
 const installed = (await sql('select version from supabase_migrations.schema_migrations order by version;')).split(/\r?\n/);
 const migrations = await migrationSources(root);
 if (JSON.stringify(installed) !== JSON.stringify(migrations.map(m => m.staged.slice(0, 14)))) throw new DevelopmentError('Local migration history differs from this checkout.');
 return { settings, state, sql };
}

/** The shared HTTP target: production's check pins a development origin to the default
 * API port, so a checkout on another port widens it to any loopback port first. This is
 * the one deliberate local difference from the baseline. */
export function developmentTargetSql(origin) {
 if (!/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(origin)) throw new DevelopmentError('Invalid local API origin.');
 return `do $$ begin
  if exists(select 1 from fluid_private.shared_http_target where mode<>'development' or origin<>${q(origin)}) then raise exception 'portable_target_changed'; end if;
  if ${q(origin)}<>'http://127.0.0.1:54321' and not exists(select 1 from fluid_private.shared_http_target) then
   alter table fluid_private.shared_http_target drop constraint shared_http_target_check;
   alter table fluid_private.shared_http_target add constraint shared_http_target_check check(
    mode='hosted' and origin~'^https://[a-z0-9]{20}\\.supabase\\.co$'
    or mode='development' and origin~'^http://127\\.0\\.0\\.1:[0-9]{4,5}$' and split_part(origin,':',3)::integer between 1024 and 65535);
  end if;
 end $$;
 insert into fluid_private.shared_http_target(mode,origin) select 'development',${q(origin)} where not exists(select 1 from fluid_private.shared_http_target);`;
}

const httpFunctions = lane => lane === 'logo' ? ['shared_logo_http_principal()', 'execute_shared_logo_request(text,text,jsonb,jsonb)']
 : ['shared_account_http_principal()', ...(lane === 'home' ? ['execute_shared_home_request(text,text,jsonb,jsonb)'] : ['prepare_shared_identity_request(text,uuid,jsonb,boolean)', 'commit_shared_identity_request(uuid,jsonb,jsonb)', 'finish_shared_identity_request()'])];
const password = () => randomBytes(36).toString('base64url');

/** Installs the local target row and the three web logins' passwords and registry rows,
 * records them in .embel-dev/shared/provisioning.json and proves each login works. */
export async function provisionDevelopmentSchema(root = repositoryRoot) {
 const db = await developmentDatabase(root);
 const directory = path.join(db.state, 'shared'); await privateDirectory(directory);
 const file = path.join(directory, 'provisioning.json');
 const existing = await readOptional(file);
 const supabaseOrigin = 'http://127.0.0.1:' + db.settings.apiPort;
 const databaseUrl = (role, secret) => `postgresql://${role}:${secret}@127.0.0.1:${db.settings.dbPort}/postgres?sslmode=disable`;
 const target = { deploymentId: db.settings.projectId, applicationOrigin: 'http://127.0.0.1:' + db.settings.webPort, supabaseOrigin, databaseHost: '127.0.0.1', databasePort: db.settings.dbPort };
 const stored = existing ? JSON.parse(existing) : null;
 if (stored && (stored.version !== 3 || JSON.stringify(stored.target) !== JSON.stringify(target) || stored.httpPrincipals?.length !== 3)) throw new DevelopmentError('Stored local principal configuration belongs to a different target. Remove .embel-dev/shared after npm run dev:down.');
 const data = stored ?? { version: 3, target, httpPrincipals: HTTP_LANES.map(({ lane, roleName }) => ({ lane, roleName, roleOid: null, databaseUrl: databaseUrl(roleName, password()) })) };
 // Persist before use, so an interruption can resume the same credentials.
 await writeState(file, JSON.stringify(data, null, 2) + '\n');
 const statements = ['begin; select pg_advisory_xact_lock(743182914);', developmentTargetSql(supabaseOrigin)];
 for (const principal of data.httpPrincipals) {
  const lane = HTTP_LANES.find(entry => entry.lane === principal.lane);
  if (!lane || principal.roleName !== lane.roleName) throw new DevelopmentError('Stored local principal identity is invalid.');
  const url = new URL(principal.databaseUrl);
  if (url.hostname !== '127.0.0.1' || url.port !== String(target.databasePort) || decodeURIComponent(url.username) !== lane.roleName || url.pathname !== '/postgres' || !/^[A-Za-z0-9_-]{48}$/.test(url.password)) throw new DevelopmentError('Stored local principal credential is invalid.');
  statements.push(`do $$ begin
   if not exists(select 1 from pg_roles where rolname=${q(lane.roleName)} and rolcanlogin and not rolinherit and not rolsuper and not rolbypassrls) then raise exception 'baseline_login_missing'; end if;
   if exists(select 1 from fluid_private.${lane.registry} where lane=${q(lane.lane)} and role_name<>${q(lane.roleName)}) then raise exception 'portable_principal_changed'; end if;
  end $$;
  alter role ${lane.roleName} password ${q(url.password)};
  grant usage on schema public to ${lane.roleName};
  grant execute on function ${httpFunctions(lane.lane).map(f => 'public.' + f).join(',')} to ${lane.roleName};
  insert into fluid_private.${lane.registry}(lane,role_name,role_oid,enabled)
   select ${q(lane.lane)},rolname,oid,true from pg_roles where rolname=${q(lane.roleName)} on conflict(lane) do nothing;`);
 }
 statements.push("notify pgrst,'reload schema'; commit;");
 await db.sql(statements.join('\n'));
 const roles = JSON.parse(await db.sql(`select json_object_agg(rolname,oid) from pg_roles where rolname in(${data.httpPrincipals.map(p => q(p.roleName)).join(',')});`));
 for (const principal of data.httpPrincipals) principal.roleOid = Number(roles[principal.roleName]);
 await writeState(file, JSON.stringify(data, null, 2) + '\n');
 await verifyDevelopmentPrincipals(data);
 return data;
}

export async function verifyDevelopmentPrincipals(data) {
 for (const principal of data.httpPrincipals) {
  const client = new pg.Client({ connectionString: principal.databaseUrl, connectionTimeoutMillis: 10_000 });
  try {
   await client.connect();
   const response = await client.query('select public.' + (principal.lane === 'logo' ? 'shared_logo_http_principal()' : 'shared_account_http_principal()') + ' as value');
   const value = response.rows[0]?.value;
   if (value?.lane !== principal.lane || value.roleName !== principal.roleName || value.roleOid !== principal.roleOid || value.origin !== data.target.supabaseOrigin) throw new Error('principal differs');
  } catch { throw new DevelopmentError('A local restricted principal failed real database login or authority verification.'); }
  finally { await client.end().catch(() => {}); }
 }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 try { const data = await provisionDevelopmentSchema(); console.log(JSON.stringify({ schema: 'provisioned and verified', web: data.httpPrincipals.map(s => s.lane) })); }
 catch (error) { console.error(error instanceof DevelopmentError ? error.message : 'Local schema provisioning failed; private diagnostics withheld.'); process.exitCode = 1; }
}
