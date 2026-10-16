// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
const f=vi.hoisted(()=>({session:{status:'signed_out',generation:1} as Record<string,unknown>,state:{} as Record<string,unknown>}));
vi.mock('@/components/workspace/account-session',()=>({useAccountSession:()=>({session:f.session,isCurrent:()=>true}),AccountStatus:()=>createElement('p',null,'Account status')}));
vi.mock('@/components/identity/logo-draft-memory-context',()=>({useLogoDraftMemory:()=>({hasUnsaved:()=>false})}));
vi.mock('@/components/identity/use-logo-workspace',()=>({useLogoWorkspace:()=>f.state}));
vi.mock('@/features/identity-directions/components/identity-directions-panel',()=>({IdentityDirectionsPanel:({controls}:{controls?:React.ReactNode})=>createElement('div',null,createElement('p',null,'Owned directions panel'),controls)}));
vi.mock('@/features/identity-deliverables/components/deliverables-panel',()=>({DeliverablesPanel:()=>createElement('p',null,'Owned deliverables panel')}));
vi.mock('@/components/identity/account-logo-inputs',()=>({AccountLogoInputs:()=>createElement('p',null,'Owned project fonts')}));
import {LogoOutputPage} from '@/components/identity/logo-output-page';
const id=(n:number)=>`d0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;let root:Root|null=null;afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';vi.unstubAllGlobals();});
async function mount(stage:'directions'|'deliverables'){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(LogoOutputPage,{projectId:id(2),stage})));return host;}
it('keeps private panels hidden until the matching owned workspace is verified',async()=>{f.session={status:'signed_out',generation:1};f.state={workspace:{ownerId:id(1),projectId:id(2)},client:{}};const host=await mount('directions');expect(host.textContent).not.toContain('Owned directions panel');});
it('does not display a previous owners workspace',async()=>{f.session={status:'ready',userId:id(1),generation:2};f.state={workspace:{ownerId:id(9),projectId:id(2)},client:{},error:null};const host=await mount('deliverables');expect(host.textContent).not.toContain('Owned deliverables panel');});
it.each(['directions','deliverables'] as const)('mounts %s with the verified workspace and bound client',async stage=>{f.session={status:'ready',userId:id(1),generation:2};f.state={workspace:{ownerId:id(1),projectId:id(2)},client:{},error:null};const host=await mount(stage);expect(host.textContent).toContain(`Owned ${stage} panel`);expect(host.querySelector('[aria-current="page"]')).not.toBeNull();});

it('shows saved font inputs alongside the owned visual identity controls',async()=>{f.session={status:'ready',userId:id(1),generation:2};f.state={workspace:{ownerId:id(1),projectId:id(2)},client:{},error:null};expect((await mount('directions')).textContent).toContain('Owned project fonts');});
