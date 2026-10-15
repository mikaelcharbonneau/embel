import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { hostIdSchema, issuedClientIdSchema, LocalChatGPTError, OPENAI_ISSUER } from "./oauth";

const epoch = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const secret = z.string().min(1).max(32_768).refine(value => !/[\s\u0000-\u001f\u007f]/u.test(value));
const tokensSchema = z.strictObject({
  accessToken: secret.nullable(), refreshToken: secret.nullable(), idToken: secret,
  scopes: z.array(z.string().min(1).max(200)).max(100), expiresAt: epoch.nullable(), earliestRefreshAt: epoch.nullable(), receivedAt: epoch,
}).refine(value => (value.accessToken === null) === (value.expiresAt === null) && new Set(value.scopes).size === value.scopes.length);

export const credentialRecordSchema = z.strictObject({
  version: z.literal(1), registrationId: z.string().regex(/^[a-f0-9]{64}$/), ownerId: z.uuid(),
  issuer: z.literal(OPENAI_ISSUER), subject: z.string().min(1).max(512), clientId: issuedClientIdSchema,
  email: z.string().max(320).nullable(), hostId: hostIdSchema, tokens: tokensSchema.nullable(), updatedAt: epoch,
}).refine(record => record.registrationId === registrationIdFor(record), { message: "Registration identity binding mismatch" });
export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

export function registrationIdFor(identity: { ownerId: string; issuer: string; clientId: string; subject: string }): string {
  return createHash("sha256").update(JSON.stringify([identity.ownerId, identity.issuer, identity.clientId, identity.subject])).digest("hex");
}

export interface ChatGPTCredentialStore {
  getHostId(): Promise<string>;
  list(ownerId: string): Promise<CredentialRecord[]>;
  read(ownerId: string, registrationId: string): Promise<CredentialRecord | null>;
  write(record: CredentialRecord): Promise<void>;
  withLock<T>(registrationId: string, action: () => Promise<T>): Promise<T>;
}

function isMissing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function safeStoreError(error: unknown): never {
  if (error instanceof LocalChatGPTError) throw error;
  throw new LocalChatGPTError("credential_store_unavailable");
}
function assertIdentifier(value: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new LocalChatGPTError("registration_not_found");
}

/** Construction is inert. Files are touched only by an explicit method call.
 * This is Embel's own approved storage; it never reads Codex or browser credentials. */
export class FileChatGPTCredentialStore implements ChatGPTCredentialStore {
  readonly directory: string;
  constructor(directory = resolve(process.cwd(), ".local-fluid", "credentials")) { this.directory = resolve(directory); }

  private async root(create: boolean) {
    try {
      // macOS system aliases are root-controlled. Resolve only these known aliases;
      // never canonicalize an application-controlled link into an approved path.
      let checkedDirectory = this.directory;
      if (process.platform === "darwin") {
        for (const alias of ["/tmp", "/var"]) {
          if (checkedDirectory === alias || checkedDirectory.startsWith(`${alias}/`)) {
            const target = await realpath(alias);
            if (target !== `/private${alias}`) throw new LocalChatGPTError("credential_store_unavailable");
            checkedDirectory = target + checkedDirectory.slice(alias.length);
            break;
          }
        }
      }
      const prefix = parse(checkedDirectory).root;
      const parts = checkedDirectory.slice(prefix.length).split(sep).filter(Boolean);
      const privateRoot = parts.indexOf(".local-fluid");
      let current = prefix;
      for (let index = 0; index < parts.length; index++) {
        current = join(current, parts[index]!);
        let stat;
        try { stat = await lstat(current); }
        catch (error) {
          if (!isMissing(error)) throw error;
          if (!create) return false;
          // Create each checked component independently; recursive mkdir would
          // follow an untrusted .local-fluid symlink before we could reject it.
          try { await mkdir(current, { mode: 0o700 }); }
          catch (creationError) {
            if (!(creationError instanceof Error && "code" in creationError && creationError.code === "EEXIST")) throw creationError;
          }
          stat = await lstat(current);
        }
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LocalChatGPTError("credential_store_unavailable");
        const protectedDirectory = index === parts.length - 1 || (privateRoot >= 0 && index >= privateRoot);
        if (protectedDirectory && ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid()))) {
          throw new LocalChatGPTError("credential_store_unavailable");
        }
      }
      return true;
    } catch (error) {
      if (!create && isMissing(error)) return false;
      safeStoreError(error);
    }
  }

  private async readJson(name: string): Promise<unknown | null> {
    if (!await this.root(false)) return null;
    let file: FileHandle | undefined;
    try {
      file = await open(join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 262_144 ||
          (process.getuid && stat.uid !== process.getuid())) throw new LocalChatGPTError("credential_store_unavailable");
      return JSON.parse(await file.readFile({ encoding: "utf8" }));
    } catch (error) {
      if (isMissing(error)) return null;
      safeStoreError(error);
    } finally { await file?.close(); }
  }

  private async atomicWrite(name: string, value: unknown) {
    await this.root(true);
    const target = join(this.directory, name);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    let file: FileHandle | undefined;
    try {
      try {
        const existing = await lstat(target);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || (existing.mode & 0o777) !== 0o600 ||
            (process.getuid && existing.uid !== process.getuid())) throw new LocalChatGPTError("credential_store_unavailable");
      } catch (error) { if (!isMissing(error)) throw error; }
      const content = JSON.stringify(value);
      if (Buffer.byteLength(content, "utf8") > 262_144) throw new LocalChatGPTError("credential_store_unavailable");
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(content, { encoding: "utf8" });
      await file.sync();
      await file.close(); file = undefined;
      await this.root(false);
      await rename(temporary, target);
      const directory = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { safeStoreError(error); }
    finally { await file?.close(); await unlink(temporary).catch(() => {}); }
  }

  async getHostId() {
    return this.withLock("installation", async () => {
      const existing = await this.readJson("host.json");
      if (existing !== null) {
        const parsed = z.strictObject({ version: z.literal(1), hostId: hostIdSchema }).safeParse(existing);
        if (!parsed.success) throw new LocalChatGPTError("credential_store_unavailable");
        return parsed.data.hostId;
      }
      const hostId = `urn:uuid:${randomUUID()}`;
      await this.atomicWrite("host.json", { version: 1, hostId });
      return hostId;
    });
  }

  async list(ownerId: string) {
    if (!z.uuid().safeParse(ownerId).success) throw new LocalChatGPTError("registration_not_found");
    if (!await this.root(false)) return [];
    try {
      const records: CredentialRecord[] = [];
      for (const name of await readdir(this.directory)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const record = await this.read(ownerId, name.slice(0, -5));
        if (record) records.push(record);
      }
      return records.sort((a, b) => a.registrationId.localeCompare(b.registrationId));
    } catch (error) { safeStoreError(error); }
  }

  async read(ownerId: string, registrationId: string) {
    assertIdentifier(registrationId);
    const raw = await this.readJson(`${registrationId}.json`);
    if (raw === null) return null;
    const parsed = credentialRecordSchema.safeParse(raw);
    if (!parsed.success || parsed.data.registrationId !== registrationId) throw new LocalChatGPTError("credential_store_unavailable");
    return parsed.data.ownerId === ownerId ? parsed.data : null;
  }

  async write(record: CredentialRecord) {
    const parsed = credentialRecordSchema.safeParse(record);
    if (!parsed.success) throw new LocalChatGPTError("credential_store_unavailable");
    await this.atomicWrite(`${record.registrationId}.json`, parsed.data);
  }

  async withLock<T>(registrationId: string, action: () => Promise<T>): Promise<T> {
    if (registrationId !== "installation") assertIdentifier(registrationId);
    await this.root(true);
    const path = join(this.directory, `${registrationId}.lock`);
    let handle: FileHandle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new LocalChatGPTError("credential_store_busy");
      safeStoreError(error);
    }
    const held = await handle.stat();
    try {
      // Never automatically steal a stale lock: a crashed refresh may have rotated
      // the remote token before its replacement reached disk. Recovery is explicit.
      await handle.writeFile(JSON.stringify({ version: 1, pid: process.pid }));
      return await action();
    } finally {
      await handle.close();
      try {
        const current = await lstat(path);
        if (current.dev === held.dev && current.ino === held.ino) await unlink(path);
      } catch (error) { if (!isMissing(error)) safeStoreError(error); }
    }
  }
}
