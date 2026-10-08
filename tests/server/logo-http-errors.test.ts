import {describe,expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {logoErrorResponse} from '../../src/server/http/logo-errors';
import {LogoVectorError} from '../../src/features/logo-vector/model/errors';
import {ApiError} from '../../src/server/http/errors';
describe('bounded logo HTTP failures',()=>{
 it('maps locked edits to conflict without returning private exception text',async()=>{
  const r=logoErrorResponse(new LogoVectorError('locked_component_changed','private asset detail'));
  expect(r.status).toBe(409);expect(await r.json()).toEqual({error:{code:'conflict',message:'This request conflicts with the current state.'}});
 });
 it('distinguishes invalid edits from unavailable or mismatched sources',()=>{
  expect(logoErrorResponse(new LogoVectorError('unsupported_edit','detail')).status).toBe(422);
  expect(logoErrorResponse(new LogoVectorError('font_rights_required','detail')).status).toBe(422);
  for(const code of ['source_mismatch','engine_unavailable','timeout'] as const)expect(logoErrorResponse(new LogoVectorError(code,'detail')).status).toBe(503);
 });
 it('preserves normal API failures and sanitizes unknown errors',async()=>{
  expect(logoErrorResponse(new ApiError('not_found')).status).toBe(404);
  const r=logoErrorResponse(new Error('raw private source'));expect(r.status).toBe(500);expect(JSON.stringify(await r.json())).not.toContain('raw private source');
 });
});
