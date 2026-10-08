import { describe, expect, it } from 'vitest';
import { logoCapabilitiesSchema, LOGO_CAPABILITIES_MAX_AGE_MS } from '../../src/domain/logo-capabilities';
const at='2026-10-07T03:00:00.000Z';
const value=()=>({ownerId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',projectId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',observedAt:at,operations:{
 'identity.logo_concept':{status:'unavailable'},'identity.logo_refine':{status:'unavailable'},'identity.logo_vectorize':{status:'available',expiresAt:'2026-10-07T03:00:30.000Z'},'identity.logo_directions':{status:'unavailable'},'identity.logo_export':{status:'unavailable'},
}});
describe('bounded separate logo capability snapshot',()=>{
 it('accepts a partial exact-operation hint bounded to thirty seconds',()=>{
  expect(LOGO_CAPABILITIES_MAX_AGE_MS).toBe(30_000);expect(logoCapabilitiesSchema.parse(value())).toEqual(value());
 });
 it('requires exactly the five operations and rejects policy, configuration or workspace fields',()=>{
  const missing=value();delete (missing.operations as Record<string,unknown>)['identity.logo_export'];
  for(const v of [missing,{...value(),policy:{}},{...value(),operations:{...value().operations,upload:{status:'available'}}},{...value(),operations:{...value().operations,'identity.logo_concept':{status:'available'}}},{...value(),operations:{...value().operations,'identity.logo_concept':{status:'unavailable',expiresAt:at}}}])expect(logoCapabilitiesSchema.safeParse(v).success).toBe(false);
 });
 it('rejects missing, malformed, nonpositive and overlong available expiries',()=>{
  for(const expiresAt of [null,'invalid',at,'2026-10-07T02:59:59Z','2026-10-07T03:00:30.001Z'])expect(logoCapabilitiesSchema.safeParse({...value(),operations:{...value().operations,'identity.logo_vectorize':{status:'available',expiresAt}}}).success).toBe(false);
  expect(logoCapabilitiesSchema.safeParse({...value(),observedAt:'invalid'}).success).toBe(false);
 });
});
