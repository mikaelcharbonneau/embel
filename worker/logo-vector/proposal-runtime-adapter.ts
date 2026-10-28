import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { moneySchema, type ClaimedJob } from '../../src/domain/jobs';
import { logoHashSchema, logoUuidSchema } from '../../src/domain/logo-vector';
import { logoVectorProposalJobInputSchema, logoVectorProposalReservation } from '../../src/domain/logo-vector-proposal-jobs';
import type { LogoVectorProposalWorkerPorts } from '../../src/domain/logo-vector-proposal-evidence';
import type { OpenAIResponsesTransport } from '../../src/server/ai/openai-transport';
import { createLogoVectorProposalProvider } from '../../src/features/logo-vector/server/proposal-provider';
import { resolveLogoVectorProposalConfiguration, type LogoVectorProposalConfiguration } from '../../src/features/logo-vector/server/proposal-policy';
import type { LogoVectorProposalHandlerDependencies } from '../handlers/logo-vector-proposals';

/** Separate passive descriptor. Deliberately not registered in the existing
 * five-lane LogoWorkerCapability parser or any host. */
export type LogoVectorProposalCapability=Readonly<import('../logo-vector-proposal-capability').LegacyLogoVectorProposalCapability|import('../logo-vector-proposal-capability').UncappedLogoVectorProposalCapability>;
export type LogoVectorProposalRuntimeAdapterInput = {
 ownerId: string; policyIdentity: string; configuration: LogoVectorProposalConfiguration;
 ports: LogoVectorProposalWorkerPorts | null; transport?: OpenAIResponsesTransport; apiKey?: string;
 acceptingWork?: () => boolean;
};
export type LogoVectorProposalRuntimeAdapter = Readonly<{ capability: LogoVectorProposalCapability; proposals: Readonly<LogoVectorProposalHandlerDependencies> }>;
const claimSchema = z.strictObject({ id: logoUuidSchema, ownerId: logoUuidSchema, projectId: logoUuidSchema, operation: z.literal('identity.logo_vector_propose'), input: logoVectorProposalJobInputSchema,
 inputRevision: z.number().int().positive(), leaseToken: logoUuidSchema, status: z.literal('running'), reservedCostMicrousd: moneySchema, actualCostMicrousd: z.literal(0) });
const unavailable = () => new Error('The exact vector proposal runtime is unavailable.');

/** Pure composition of explicit already-authorized ports. No I/O, environment
 * discovery, timers, pool, Storage/font capabilities or readiness registration.
 * The concrete SQL/DAL port implementation and activation are separate work. */
export function createLogoVectorProposalRuntimeAdapter(input:LogoVectorProposalRuntimeAdapterInput&{configuration:LogoVectorProposalConfiguration&{textPolicy:import('../../src/domain/logo-vector-proposal-jobs').LegacyLogoVectorProposalTextPolicy}}):Readonly<{capability:Readonly<import('../logo-vector-proposal-capability').LegacyLogoVectorProposalCapability>;proposals:Readonly<LogoVectorProposalHandlerDependencies>}>|null;
export function createLogoVectorProposalRuntimeAdapter(input?:LogoVectorProposalRuntimeAdapterInput|null):LogoVectorProposalRuntimeAdapter|null;
export function createLogoVectorProposalRuntimeAdapter(input: LogoVectorProposalRuntimeAdapterInput | null = null): LogoVectorProposalRuntimeAdapter | null {
 if (!input) return null;
 try {
  const ownerId = logoUuidSchema.parse(input.ownerId), policyIdentity = logoHashSchema.parse(input.policyIdentity);
  const configuration = resolveLogoVectorProposalConfiguration(input.configuration);
  if (!configuration || !input.ports || ['loadInput', 'assertReady', 'recordResponse', 'stageProposal'].some(key => typeof input.ports?.[key as keyof LogoVectorProposalWorkerPorts] !== 'function') || input.acceptingWork !== undefined && typeof input.acceptingWork !== 'function') return null;
  const provider = createLogoVectorProposalProvider({ configuration, transport: input.transport, apiKey: input.apiKey, acceptingWork: input.acceptingWork });
  if (!provider) return null;
  const policy = configuration.textPolicy;
  const basis={operation:configuration.operation,policyIdentity,handlerVersion:policy.handlerVersion,provider:'openai' as const,model:policy.model,engine:null};
  const capability:LogoVectorProposalCapability=policy.version===1?Object.freeze({...basis,maxCostMicrousd:policy.maximumCostMicrousd,textPolicy:policy})
   :Object.freeze({...basis,spendControl:'uncapped' as const,textPolicy:policy});
  // Capture and bind functions once; caller mutation cannot switch the ports.
  const loadInput = input.ports.loadInput.bind(input.ports), assertReady = input.ports.assertReady.bind(input.ports), recordResponse = input.ports.recordResponse.bind(input.ports), stageProposal = input.ports.stageProposal.bind(input.ports);
  const snapshot = (raw: ClaimedJob) => {
   const job = claimSchema.parse(raw), frozen = job.input;
   if (job.ownerId !== ownerId || frozen.ownerId !== ownerId || frozen.projectId !== job.projectId || frozen.policyIdentity !== policyIdentity || !isDeepStrictEqual(frozen.textPolicy, policy) || job.reservedCostMicrousd !== logoVectorProposalReservation(policy)) throw unavailable();
   return job;
  };
  const proposals: LogoVectorProposalHandlerDependencies = {
   provider,
   async loadInput(raw, signal) { signal.throwIfAborted(); const job = snapshot(raw); const resolved = await loadInput(job, signal); signal.throwIfAborted(); snapshot(raw); return resolved; },
   async assertReady(raw, signal) { signal.throwIfAborted(); const job = snapshot(raw); await assertReady(job, signal); signal.throwIfAborted(); snapshot(raw); },
   // These calls intentionally do not recheck work admission or cancellation.
   // Persistence must independently fence original dispatch authority/lease and
   // retain expense even when the host has stopped taking new work.
   recordResponse(raw, observation) { return recordResponse(snapshot(raw), observation); },
   stageProposal(raw, result, receipt) { return stageProposal(snapshot(raw), result, receipt); },
  };
  return Object.freeze({ capability, proposals: Object.freeze(proposals) });
 } catch { return null; }
}
