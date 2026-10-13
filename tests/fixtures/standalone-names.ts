import { chatGPTNamingPolicySchema } from "../../src/domain/naming-jobs";
import { standaloneNamesJobSchema, standaloneNamesResultSchema, standaloneNamesWorkerInputSchema } from "../../src/domain/standalone-names";
// Synthetic fixtures only. No provider call or real generated name is used.
export const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const jobId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const lease = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const brief = { description: "Synthetic fixture: a ceramics workshop", direction: "Warm and short", language: "English" };
export const policy = chatGPTNamingPolicySchema.parse({ version: 1, billingMode: "chatgpt_subscription", handlerVersion: "naming-chatgpt-v1", registrationId: "fixture-standalone-registration", model: "fixture-model",
  limits: { maxInputBytes: 131072, maxOutputBytes: 262144, deadlineMs: 240000, maxObservedWebSearchCalls: 0, maxRequestsPerHour: 20, maxQueuedJobs: 3 } });
export const proposal = { value: "Fixture Clay", rationale: "Synthetic proposal rationale", caution: null };
export function resultFixture() { return standaloneNamesResultSchema.parse({ version: 1, provider: "openai", billingMode: "chatgpt_subscription", model: policy.model, responseId: "fixture-response", requestId: "fixture-request", generatedAt: "2026-10-13T12:00:00Z", usage: null, candidates: [proposal], rejectedCount: 0 }); }
export function jobFixture(state: "queued" | "running" | "succeeded" = "queued") { return standaloneNamesJobSchema.parse({ id: jobId, ownerId: owner, brief, refinement: null, depth: 0, state, errorCode: null, createdAt: "2026-10-13T12:00:00Z", finishedAt: state === "succeeded" ? "2026-10-13T12:01:00Z" : null, result: state === "succeeded" ? resultFixture() : null, likedIndexes: [], savedIndexes: [] }); }
export function workerFixture() { return standaloneNamesWorkerInputSchema.parse({ job: jobFixture("running"), leaseToken: lease, policy }); }
export const intent = { brief, refinement: null, idempotencyKey: "fixture-standalone-request", acceptedPolicyIdentity: "a".repeat(64), acceptSubscriptionUsage: true as const };
