import 'server-only';
import { z } from 'zod';
import { attachedProjectDraftReceiptSchema, ownedAttachmentRefSchema, requestLookupSchema } from '@/domain/attachments';
import type { AuthenticatedContext } from '@/server/auth/context';
import type { IdentityConnectionFactory } from '@/server/data/identity-transaction';
import { ApiError } from '@/server/http/errors';
import { homeAttachmentReservationSchema, type HomeAttachmentBackend } from './index';
const bindingSchema = z.strictObject({ ownerId: z.uuid(), roleName: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/), roleOid: z.number().int().positive().max(4_294_967_295) });
const principalSchema = z.strictObject({ role_name: z.string(), role_oid: z.coerce.number().int().positive(), owner_id: z.uuid() });
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const p = schema.safeParse(raw); if (!p.success) throw new ApiError('integration_unavailable'); return p.data; }
function active(signal?: AbortSignal) { if (signal?.aborted) throw new ApiError('integration_unavailable'); }
function databaseError(error: unknown): ApiError {
 if (error instanceof ApiError) return error;
 const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
 if (code === 'P0002') return new ApiError('not_found');
 if (['23505','40001','PT409'].includes(code)) return new ApiError('conflict');
 if (['22023','22P02','23514','23502'].includes(code)) return new ApiError('invalid_input');
 return new ApiError('integration_unavailable');
}
/** The factory never provisions a login or reads credentials. Its injected pool
 * must supply dedicated owner-bound logins; each operation checks real identity
 * before its fixed SQL call, and every SQL function checks it independently. */
export function createPostgresHomeAttachmentBackend(owned: IdentityConnectionFactory | null): HomeAttachmentBackend {
 async function call(auth: AuthenticatedContext, sql: string, parameters: unknown[], signal?: AbortSignal): Promise<unknown> {
  active(signal); if (!owned) throw new ApiError('integration_unavailable');
  const owner = z.uuid().safeParse(auth.userId); if (!owner.success) throw new ApiError('unauthenticated');
  const lease = await owned.acquire(owner.data.toLowerCase(), signal); let discard = false;
  try {
   const binding = parse(bindingSchema, lease.binding); if (binding.ownerId !== owner.data.toLowerCase()) throw new ApiError('not_found'); active(signal);
   const result = await lease.connection.query('SELECT session_user::text AS role_name, pg_catalog.to_regrole(session_user)::oid::bigint AS role_oid, fluid_private.home_attachment_owner() AS owner_id');
   const principal = parse(principalSchema, result.rows[0]);
   if (principal.owner_id !== binding.ownerId) throw new ApiError('not_found');
   if (principal.role_name !== binding.roleName || principal.role_oid !== binding.roleOid) throw new ApiError('integration_unavailable'); active(signal);
   const response = await lease.connection.query(sql, parameters); active(signal); return parse(z.strictObject({ value: z.unknown() }), response.rows[0]).value;
  } catch (e) { discard = true; throw databaseError(e); }
  finally { try { await lease.connection.release(discard); } catch { try { await lease.connection.discard(); } finally { throw new ApiError('integration_unavailable'); } } }
 }
 async function rpc(auth: AuthenticatedContext, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  active(signal);
  try { const response = await auth.client.rpc(name, args); if (response.error) throw response.error; active(signal); return response.data; }
  catch (e) { throw databaseError(e); }
 }
 return {
  async prepare(auth, input, length, signal) { return parse(homeAttachmentReservationSchema, await call(auth, 'SELECT fluid_private.prepare_home_attachment($1::jsonb,$2::bigint) AS value', [JSON.stringify(input), length], signal)); },
  async lookup(auth, key, signal) { return parse(homeAttachmentReservationSchema.nullable(), await call(auth, 'SELECT fluid_private.lookup_home_attachment($1::uuid) AS value', [key], signal)); },
  async observe(auth, id, observation, signal) { return parse(ownedAttachmentRefSchema, await call(auth, 'SELECT fluid_private.observe_home_attachment($1::uuid,$2::jsonb) AS value', [id, JSON.stringify(observation)], signal)); },
  async resolve(auth, ids, signal) { return parse(z.array(homeAttachmentReservationSchema).max(5), await call(auth, 'SELECT fluid_private.resolve_home_attachments($1::uuid[]) AS value', [ids], signal)); },
  async save(auth, input, signal) { return parse(attachedProjectDraftReceiptSchema, await rpc(auth, 'save_attached_home_project', { p_input: input, p_context_text: JSON.stringify(input.project.context) }, signal)); },
  async lookupProject(auth, key, signal) { return parse(requestLookupSchema(attachedProjectDraftReceiptSchema), await rpc(auth, 'read_attached_home_project_request', { p_request_key: key }, signal)); },
 };
}
