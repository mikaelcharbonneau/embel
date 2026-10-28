import type { OwnerWorkerProcessDescriptor } from "./adapter";
import type { z } from "zod";
import type { ownerWorkerRuntimeSchema } from "./configuration";

export type OwnerWorkerArtifactAttestation=Readonly<{sourceRevision:string;sourceClean:boolean;artifactSha256:string;deploymentId:string;
 runtime:z.infer<typeof ownerWorkerRuntimeSchema>}>;
export type OwnerWorkerDatabaseSecret=Readonly<{databaseUrl:string;caPem:string}>;
export type OwnerWorkerProviderSecret=Readonly<{apiKey:string;model:string;modelVerificationReceipt:string}>;
export type OwnerWorkerProcessScope=Readonly<{descriptor:OwnerWorkerProcessDescriptor;attestation:OwnerWorkerArtifactAttestation}>;
/** Emitted only after the native restricted identity, exact stored authority and
 * fresh runtime readiness succeeded; never after parsing a descriptor alone. */
export type OwnerWorkerReadyNotice=Readonly<{workerId:string;roleOid:number;observedAt:string;storageSessionId:string|null}>;
