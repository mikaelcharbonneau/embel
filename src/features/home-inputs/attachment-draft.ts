import { attachmentPolicySchema, type AttachmentPolicy, type DraftAttachment } from "@/domain/attachments";
export type HomeAttachmentAvailability = { status: "available" } | { status: "unavailable"; reason: string };
/** Metadata preflight only. A filename or browser MIME label never verifies bytes. */
export function validateAttachmentSelection(files: readonly File[], existing: readonly DraftAttachment[], value: AttachmentPolicy): { accepted: File[]; errors: { name: string; code: "count" | "file_bytes" | "total_bytes" | "mime" }[] } {
 const policy = attachmentPolicySchema.parse(value), accepted: File[] = [], errors: { name: string; code: "count" | "file_bytes" | "total_bytes" | "mime" }[] = [];
 let bytes = existing.reduce((total, item) => total + item.byteLength, 0);
 for (const file of files) {
  const reject = (code: (typeof errors)[number]["code"]) => errors.push({ name: file.name, code });
  if (existing.length + accepted.length >= policy.maxFiles) { reject("count"); continue; }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > policy.maxFileBytes) { reject("file_bytes"); continue; }
  if (!policy.allowedMimeTypes.some(type => type === file.type)) { reject("mime"); continue; }
  if (bytes + file.size > policy.maxTotalBytes) { reject("total_bytes"); continue; }
  accepted.push(file); bytes += file.size;
 }
 return { accepted, errors };
}
