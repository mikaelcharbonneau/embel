import 'server-only';
import { createHash } from 'node:crypto';
import { stageHomeAttachmentInputSchema, type StageHomeAttachmentInput } from '@/domain/attachments';
import { inspectIdentityRaster } from '@/server/data/identity-asset-store';
import { ApiError } from '@/server/http/errors';
const MAX_FILE_BYTES = 10_485_760;
const invalid = () => new ApiError('invalid_input');
/** Bounded byte-envelope screening only, never PDF validity or safe-decoding
 * proof. PDF admission stays unavailable until total decoded-memory bounds are
 * enforceable. No PDF.js, decompressor, subprocess or native renderer is invoked. */
function preflightPdfEnvelope(bytes: Uint8Array): void {
 const source = Buffer.from(bytes).toString('latin1').replace(/#([\da-f]{2})/giu, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
 if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/u.test(source) || !/%%EOF\s*$/u.test(source) || /\/(?:Encrypt|ObjStm|JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|EmbeddedFiles|Filespec|RichMedia|XFA|AcroForm|SubmitForm|ImportData|GoToR|GoToE|URI|Rendition|Movie|Sound|Collection)\b/u.test(source)) throw invalid();
}
export async function validateHomeAttachmentBytes(input: StageHomeAttachmentInput, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
 if (signal?.aborted) throw new ApiError('integration_unavailable');
 if (!stageHomeAttachmentInputSchema.safeParse(input).success || !(bytes instanceof Uint8Array) || !bytes.byteLength) throw invalid();
 if (bytes.byteLength > MAX_FILE_BYTES) throw new ApiError('body_too_large');
 if (createHash('sha256').update(bytes).digest('hex') !== input.contentHash) throw invalid();
 if (input.mimeType === 'text/plain') {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid(); }
  // Reject the opening prefix in one pass; never rescan a suffix looking for
  // a closing angle bracket on untrusted multi-megabyte text.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /<\s*[!/?a-z]/iu.test(text) || /^\s*(?:%PDF-|PK\u0003\u0004|\{\\rtf)/u.test(text)) throw invalid();
 } else if (input.mimeType === 'application/pdf') {
  preflightPdfEnvelope(bytes);
  throw new ApiError('integration_unavailable');
 }
 else {
  try { await inspectIdentityRaster(bytes, input.mimeType, signal); } catch { throw signal?.aborted ? new ApiError('integration_unavailable') : invalid(); }
 }
 if (signal?.aborted) throw new ApiError('integration_unavailable');
}
