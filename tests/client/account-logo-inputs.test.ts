// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';import {act,createElement} from 'react';import {createRoot,type Root} from 'react-dom/client';
const f=vi.hoisted(()=>({current:true,props:null as Record<string,unknown>|null,session:{}}));
vi.mock('@/components/workspace/account-session',()=>({useAccountSession:()=>({isCurrent:()=>f.current,expire:()=>{},logoInputSession:f.session})}));
vi.mock('@/features/logo-inputs/components/logo-inputs-panel',()=>({LogoInputsPanel:(props:Record<string,unknown>)=>{f.props=props;return createElement('p',null,`Input panel ${props.mode}`);}}));
import {AccountLogoInputs} from '@/components/identity/account-logo-inputs';
import {createAccountLogoClient} from '@/components/identity/account-logo-client';import {syntheticLogoWorkspace} from '../fixtures/logo-creation';
let root:Root|null=null;afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';f.current=true;f.props=null;vi.unstubAllGlobals();});
async function mount(foreign=false,canWrite=false){vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const workspace=syntheticLogoWorkspace(),account={status:'ready' as const,userId:workspace.ownerId,generation:1};const client=createAccountLogoClient(account,workspace.projectId,()=>f.current,()=>{});const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(AccountLogoInputs,{account,workspace:foreign?{...workspace,ownerId:'99000000-0000-4000-8000-000000000099'}:workspace,client,mode:'fonts',canWrite})));return {host,account,workspace};}
it('mounts the owner-bound inputs panel with provider-lifetime session and current capability',async()=>{const {host,account}=await mount();expect(host.textContent).toContain('Input panel fonts');expect(f.props).toMatchObject({session:f.session,account,canWrite:false,mode:'fonts'});});
it('hides a foreign workspace',async()=>{expect((await mount(true)).host.textContent).not.toContain('Input panel');});
it('hides inputs after session verification expires',async()=>{f.current=false;expect((await mount()).host.textContent).not.toContain('Input panel');});

it('keeps existing selection editing separate from unavailable upload capability',async()=>{await mount(false,true);expect(f.props?.canWrite).toBe(true);});
