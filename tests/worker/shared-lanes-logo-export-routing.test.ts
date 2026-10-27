import { afterEach,describe,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
import {createLogoDeliverablesService,LogoExportAdmissionUncertainError} from "../../src/features/identity-deliverables/server/persistence";
import type {IdentityAssetStore} from "../../src/server/data/identity-asset-store";
import type {AuthenticatedContext} from "../../src/server/auth/context";
import {syntheticLogoWorkspace,logoFixtureId as id} from "../fixtures/logo-creation";
const workspace=syntheticLogoWorkspace(),intent={requestKey:id(810),expected:workspace.heads,approvedLogoId:id(811),directionApprovalId:id(812),variantSetId:id(813),pngLongEdge:512,socialSelections:[]};
afterEach(()=>vi.unstubAllEnvs());
describe("advanced export web admission routing (inert owned RPC port)",()=>{
 it.each([false,true])("keeps the exact export request while shared mode is %s",async shared=>{
  vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED",shared?"true":"false");
  const receipt={ownerId:workspace.ownerId,projectId:workspace.projectId,requestKey:intent.requestKey,operation:"identity.logo_export",batchId:null,jobIds:[id(815)],inputHash:"a".repeat(64)};
  const rpc=vi.fn(async()=>({data:receipt,error:null})),auth={userId:workspace.ownerId,client:{rpc}} as unknown as AuthenticatedContext;
  const result=await createLogoDeliverablesService({assets:{} as IdentityAssetStore}).requestLogoExport(auth,workspace.projectId,intent);
  expect(result).toEqual(receipt);expect(rpc).toHaveBeenCalledExactlyOnceWith(shared?"shared_logo_operation":"request_logo_export",
   {p_project_id:workspace.projectId,p_input:intent,...shared?{p_kind:"export"}:{}});
 });
 it("retains uncertain shared admission without retrying a historical RPC",async()=>{
  vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED","true");
  const rpc=vi.fn(async()=>{throw Error("inert acknowledgement lost");}),auth={userId:workspace.ownerId,client:{rpc}} as unknown as AuthenticatedContext;
  await expect(createLogoDeliverablesService({assets:{} as IdentityAssetStore}).requestLogoExport(auth,workspace.projectId,intent)).rejects.toBeInstanceOf(LogoExportAdmissionUncertainError);
  expect(rpc).toHaveBeenCalledTimes(1);expect(rpc.mock.calls[0]).toEqual(["shared_logo_operation",{p_project_id:workspace.projectId,p_input:intent,p_kind:"export"}]);
 });
});
