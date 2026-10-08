import "server-only";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import type { ChatGPTModel } from "../ai/chatgpt-transport";

const MAX_FILE_BYTES = 65_536;
const registrationIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
const slugSchema = z.string().min(1).max(150).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
const recordSchema = z.strictObject({
  ownerId: z.uuid(), registrationId: registrationIdSchema, slug: slugSchema,
  displayName: z.string().trim().min(1).max(200).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)),
  verifiedAt: z.iso.datetime(),
  evidence: z.strictObject({ type: z.literal("response.completed"), model: slugSchema }),
}).refine(record => record.evidence.model === record.slug, { message: "Verified model mismatch" });

export const verifiedModelDocumentSchema = z.strictObject({ version: z.literal(1), models: z.array(recordSchema).max(100) })
  .refine(document => new Set(document.models.map(record => JSON.stringify([record.ownerId, record.registrationId, record.slug]))).size === document.models.length,
    { message: "Duplicate verified model" });

function isMissing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function unavailable(): never { throw new Error("verified_model_store_unavailable"); }
function owns(uid: number) { return !process.getuid || uid === process.getuid(); }

/** Reads administrator-recorded evidence of a completed request for an omitted
 * catalog model. This is historical evidence, never a promise of current access:
 * the current OAuth session and provider still authorize every inference call.
 * Construction is inert; no client endpoint writes records or probes models. */
export class FileVerifiedChatGPTModelStore {
  readonly directory: string;
  constructor(directory = resolve(process.cwd(), ".local-fluid"), private readonly now = Date.now) {
    this.directory = resolve(directory);
  }

  private async root() {
    let checkedDirectory = this.directory;
    if (process.platform === "darwin") {
      // Only the OS-controlled aliases are accepted; never canonicalize a link
      // supplied inside the checkout or protected application directory.
      for (const alias of ["/tmp", "/var"]) {
        if (checkedDirectory === alias || checkedDirectory.startsWith(`${alias}/`)) {
          const target = await realpath(alias);
          if (target !== `/private${alias}`) unavailable();
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
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) unavailable();
      if ((index === parts.length - 1 || (privateRoot >= 0 && index >= privateRoot)) &&
          ((stat.mode & 0o7777) !== 0o700 || !owns(stat.uid))) unavailable();
    }
    return lstat(checkedDirectory);
  }

  async list(ownerId: string, registrationId: string): Promise<ChatGPTModel[]> {
    if (!z.uuid().safeParse(ownerId).success || !registrationIdSchema.safeParse(registrationId).success) unavailable();
    let file: FileHandle | undefined;
    try {
      const directory = await this.root();
      file = await open(join(this.directory, "verified-models.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || !owns(stat.uid) || stat.size > MAX_FILE_BYTES) unavailable();
      // A fixed-size read stays bounded even if a file grows after fstat.
      const content = Buffer.alloc(MAX_FILE_BYTES + 1);
      let bytes = 0;
      while (bytes < content.byteLength) {
        const read = await file.read(content, bytes, content.byteLength - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      if (bytes > MAX_FILE_BYTES) unavailable();
      const currentDirectory = await this.root();
      const currentFile = await lstat(join(this.directory, "verified-models.json"));
      if (directory.dev !== currentDirectory.dev || directory.ino !== currentDirectory.ino ||
          currentFile.isSymbolicLink() || stat.dev !== currentFile.dev || stat.ino !== currentFile.ino ||
          stat.size !== currentFile.size || stat.mtimeMs !== currentFile.mtimeMs || stat.ctimeMs !== currentFile.ctimeMs) unavailable();
      const parsed = verifiedModelDocumentSchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content.subarray(0, bytes))));
      if (!parsed.success || parsed.data.models.some(record => Date.parse(record.verifiedAt) > this.now())) unavailable();
      return parsed.data.models.filter(record => record.ownerId === ownerId && record.registrationId === registrationId)
        .map(record => ({ slug: record.slug, displayName: record.displayName }));
    } catch (error) {
      if (isMissing(error)) return [];
      return unavailable();
    } finally { await file?.close(); }
  }
}
