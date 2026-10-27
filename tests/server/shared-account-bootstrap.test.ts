import { afterEach,beforeEach,expect,it,vi } from "vitest";
vi.mock("server-only",()=>({}));
const ports=vi.hoisted(()=>({create:vi.fn(),logo:vi.fn(),legacyIdentity:vi.fn(),legacyHome:vi.fn()}));
vi.mock("@/server/shared-account/runtime",()=>({createSharedAccountHttpRuntime:ports.create}));
vi.mock("@/server/shared-account/logo-runtime",()=>({createSharedLogoHttpRuntime:ports.logo}));
vi.mock("@/server/runtime/account-http-services",()=>({createAccountHttpRuntimeFromConfiguration:vi.fn(),resolveAccountIdentityRuntime:ports.legacyIdentity,resolveAccountHomeAttachmentService:ports.legacyHome}));
import { startSharedAccountHttpServices,stopSharedAccountHttpServices,resolveSharedLogoRequestServices } from "@/server/shared-account/bootstrap";
import { acquireAccountIdentityRuntime,acquireAccountHomeAttachmentService } from "@/server/runtime/account-http-binding-source";
import type { AuthenticatedContext } from "@/server/auth/context";
const a={userId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",client:{}} as AuthenticatedContext;
const b={userId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",client:{}} as AuthenticatedContext;
beforeEach(async()=>{
 await stopSharedAccountHttpServices();vi.resetAllMocks();
 vi.stubEnv("EMBEL_SHARED_WORKERS_ENABLED","true");vi.stubEnv("EMBEL_SHARED_ACCOUNT_HTTP_ENABLED","true");
 vi.stubEnv("EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED","false");
 ports.logo.mockReturnValue(null);
});
afterEach(async()=>{await stopSharedAccountHttpServices();vi.unstubAllEnvs();});
it("reuses finite factories while forwarding each verified request and never enters the old owner registry",async()=>{
 const identity=vi.fn(async()=>({configured:true,value:null,release:async()=>{}})),home=vi.fn(async()=>({configured:true,value:null,release:async()=>{}})),close=vi.fn(async()=>{});
 ports.create.mockReturnValue({acquireIdentity:identity,acquireHome:home,close});
 expect(startSharedAccountHttpServices()).toBe("installed");
 await acquireAccountIdentityRuntime(a);await acquireAccountIdentityRuntime(b);await acquireAccountHomeAttachmentService(a);
 expect(ports.create).toHaveBeenCalledOnce();expect(identity).toHaveBeenNthCalledWith(1,a,undefined);expect(identity).toHaveBeenNthCalledWith(2,b,undefined);
 expect(home).toHaveBeenCalledExactlyOnceWith(a,undefined);expect(ports.legacyIdentity).not.toHaveBeenCalled();expect(ports.legacyHome).not.toHaveBeenCalled();
 await stopSharedAccountHttpServices();expect(close).toHaveBeenCalledOnce();
});
it("keeps invalid shared configuration unavailable even if the old owner source flag is also set",async()=>{
 vi.stubEnv("EMBEL_ACCOUNT_HTTP_SOURCE_ENABLED","true");ports.create.mockImplementation(()=>{throw Error("credential-bearing setup error");});
 expect(startSharedAccountHttpServices()).toBe("unavailable");
 expect(await acquireAccountIdentityRuntime(a)).toMatchObject({configured:true,value:null});
 expect(await acquireAccountHomeAttachmentService(b)).toMatchObject({configured:true,value:null});
 expect(ports.legacyIdentity).not.toHaveBeenCalled();expect(ports.legacyHome).not.toHaveBeenCalled();
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
