import "server-only";
import type { StandalonePayloadCodec, StandaloneTool } from "@/domain/standalone-workspaces";
import { standalonePayloadCodec as domains } from "@/features/domain-workspace/account-codec";
import { standalonePayloadCodec as handles } from "@/features/handles-workspace/account-codec";
import { standalonePayloadCodec as trademarks } from "@/features/trademark-workspace/account-codec";

/** Deliberately closed registry: user input cannot register or choose an arbitrary codec. */
const codecs: Readonly<Record<StandaloneTool, StandalonePayloadCodec>> = Object.freeze({
  domains, handles, trademarks,
});
export const standaloneCodec = (tool: StandaloneTool): StandalonePayloadCodec => codecs[tool];
