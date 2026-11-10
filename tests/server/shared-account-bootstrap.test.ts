import { afterEach,beforeEach,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const ports=vi.hoisted(()=>({create:vi.fn(),logo:vi.fn()}));
vi.mock("@/server/shared-account/runtime",()=>({createSharedAccountHttpRuntime:ports.create}));
vi.mock("@/server/shared-account/logo-runtime",()=>({createSharedLogoHttpRuntime:ports.logo}));
import { startSharedAccountHttpServices,stopSharedAccountHttpServices,resolveSharedLogoRequestServices,acquireSharedAccountIdentity as acquireAccountIdentityRuntime,acquireSharedAccountHome as acquireAccountHomeAttachmentService } from "@/server/shared-account/bootstrap";
import type { AuthenticatedContext } from "@/server/auth/context";
const a={userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",client:{}} as AuthenticatedContext;
const b={userId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",client:{}} as AuthenticatedContext;
beforeEach(async()=>{
 await stopSharedAccountHttpServices();vi.resetAllMocks();
 vi.stubEnv("EMBEL_SHARED_ACCOUNT_HTTP_ENABLED","true");
 ports.logo.mockReturnValue(null);
});
afterEach(async()=>{await stopSharedAccountHttpServices();vi.unstubAllEnvs();});
it("reuses finite factories while forwarding each verified request",async()=>{
 const identity=vi.fn(async()=>({configured:true,value:null,release:async()=>{}})),home=vi.fn(async()=>({configured:true,value:null,release:async()=>{}})),close=vi.fn(async()=>{});
 ports.create.mockReturnValue({acquireIdentity:identity,acquireHome:home,close});
 expect(startSharedAccountHttpServices()).toBe("installed");
 await acquireAccountIdentityRuntime(a);await acquireAccountIdentityRuntime(b);await acquireAccountHomeAttachmentService(a);
 expect(ports.create).toHaveBeenCalledOnce();expect(identity).toHaveBeenNthCalledWith(1,a,undefined);expect(identity).toHaveBeenNthCalledWith(2,b,undefined);
 expect(home).toHaveBeenCalledExactlyOnceWith(a,undefined);
 await stopSharedAccountHttpServices();expect(close).toHaveBeenCalledOnce();
});
it("keeps invalid shared configuration unavailable",async()=>{
ports.create.mockImplementation(()=>{throw Error("credential-bearing setup error");});
 expect(startSharedAccountHttpServices()).toBe("unavailable");
 expect(await acquireAccountIdentityRuntime(a)).toMatchObject({configured:true,value:null});
 expect(await acquireAccountHomeAttachmentService(b)).toMatchObject({configured:true,value:null});
 
});
it("keeps independently configured Logo services available when another shared lane is unavailable",async()=>{
 const resolve=vi.fn(async()=>null),close=vi.fn(async()=>{});
 ports.create.mockImplementation(()=>{throw Error("invalid Identity configuration");});ports.logo.mockReturnValue({resolve,close});
 expect(startSharedAccountHttpServices()).toBe("installed");
 expect(await acquireAccountIdentityRuntime(a)).toMatchObject({configured:true,value:null});
 expect(await resolveSharedLogoRequestServices(b,"cccccccc-cccc-4ccc-8ccc-cccccccccccc")).toBeNull();
 expect(resolve).toHaveBeenCalledExactlyOnceWith(b,"cccccccc-cccc-4ccc-8ccc-cccccccccccc",undefined);
 await stopSharedAccountHttpServices();expect(close).toHaveBeenCalledOnce();
});
