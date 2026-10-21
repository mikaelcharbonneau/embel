import { z } from "zod";
import { apiTextDispatchMessageSchema, type ApiTextDispatchMessage } from "../src/domain/api-text-dispatch";
import type { OpenAITransportResponse } from "../src/server/ai/openai-transport";
import type { JobDatabase } from "./postgres-store";
import type { BackgroundResponseJournal, BackgroundResponseState } from "./strategy-background-response";

const identity = z.string().regex(/^resp_[A-Za-z0-9_-]{1,194}$/u);
const requestId = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u).nullable();
const terminalResponse = z.strictObject({ body: z.unknown(), requestId }).nullable();
const stateSchema = z.strictObject({
  dispatchState: z.enum(["not_dispatched", "dispatching", "accepted", "rejected"]),
  responseId: identity.nullable(), terminalResponse,
  rejectionReason: z.enum(["provider_rejected", "observer_stopped", "cancelled"]).optional(),
  cancelRequested: z.boolean(), executionDeadlineAt: z.number().int().nonnegative().safe(),
  observationDeadlineAt: z.number().int().nonnegative().safe(),
}).superRefine((state, context) => {
  if (state.executionDeadlineAt > state.observationDeadlineAt ||
      (state.dispatchState === "accepted") !== (state.responseId !== null) ||
      (state.terminalResponse !== null && state.responseId === null)) context.addIssue({code:"custom",message:"Invalid persisted background state"});
});

/** Only the existing descriptor gateway may implement this contract. The
 * caller cannot choose an owner, extend a deadline, swap a response identity,
 * or submit arbitrary SQL. Server-side ownership and lease checks remain
 * mandatory. This adapter does not enable background execution by itself. */
export class ApiTextBackgroundJournal implements BackgroundResponseJournal {
  private readonly message: ApiTextDispatchMessage;
  private readonly lease: string;
  private readonly stepKey: string;
  constructor(private readonly database: JobDatabase, message: ApiTextDispatchMessage, binding: {jobId:string;leaseToken:string;stepKey:string}) {
    this.message=apiTextDispatchMessageSchema.parse(message);
    if(binding.jobId!==this.message.jobId) throw new Error("Background job mismatch");
    this.lease=z.uuid().parse(binding.leaseToken);
    this.stepKey=z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/u).parse(binding.stepKey);
  }
  private async call(action: string, payload: unknown = null): Promise<unknown> {
    const result=await this.database.query("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result",
      [JSON.stringify(this.message),"background",JSON.stringify([this.lease,this.stepKey,action,payload])]);
    if(result.rows.length!==1) throw new Error("Background journal unavailable");
    const reply=z.strictObject({jobId:z.uuid(),stepKey:z.string(),value:z.unknown()}).parse(result.rows[0]?.result);
    if(reply.jobId!==this.message.jobId || reply.stepKey!==this.stepKey) throw new Error("Background journal binding mismatch");
    return reply.value;
  }
  async load(): Promise<BackgroundResponseState> { return stateSchema.parse(await this.call("load")); }
  async beginDispatch(): Promise<boolean> { return z.boolean().parse(await this.call("begin")); }
  async recordRejection(id:string|null,reason:"provider_rejected"|"observer_stopped"|"cancelled"="provider_rejected"):Promise<void> {
    const value={requestId:requestId.parse(id),reason:z.enum(["provider_rejected","observer_stopped","cancelled"]).parse(reason)};
    if(await this.call("reject",value)!==true) throw new Error("Background rejection not recorded");
  }
  async recordHandle(id:string):Promise<void> {
    if(await this.call("handle",identity.parse(id))!==true) throw new Error("Background identity not recorded");
  }
  async recordTerminal(response:OpenAITransportResponse):Promise<void> {
    const value=z.strictObject({body:z.json(),requestId}).parse(response);
    z.object({id:identity,status:z.enum(["completed","failed","cancelled","incomplete"])}).parse(value.body);
    if(Buffer.byteLength(JSON.stringify(value),"utf8")>1_050_000) throw new Error("Background terminal response exceeds limit");
    if(await this.call("terminal",value)!==true) throw new Error("Background terminal response not recorded");
  }
}

/** The raw database is used only for the existing descriptor gateway. All
 * ordinary job operations use the descriptor-bound database adapter. */
export async function backgroundControl(database:JobDatabase,message:ApiTextDispatchMessage,action:"profile"|"claim"|"yield"|"redrive",payload:unknown=null):Promise<unknown> {
 const result=await database.query("select public.api_text_dispatch_action($1::jsonb,$2,$3::jsonb) as result",[JSON.stringify(message),"background_control",JSON.stringify([action,payload])]);
 if(result.rows.length!==1)throw new Error("Background control unavailable");
 return result.rows[0]?.result;
}
