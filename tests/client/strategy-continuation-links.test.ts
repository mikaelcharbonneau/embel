// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,createElement,useState} from 'react';import {createRoot,type Root} from 'react-dom/client';
import {ProjectEditorForm,type DraftPatch} from '@/components/workspace/project-editor';
import {accountProjectDraft} from '@/components/workspace/project-draft-adapter';
import {contextSnapshotSchema} from '@/domain/projects';
vi.mock('next/navigation',()=>({useRouter:()=>({push:vi.fn()})}));
let root:Root|null=null;afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;document.body.innerHTML='';window.history.replaceState(null,'','/');vi.unstubAllGlobals();});
it('opens the requested existing review widget from a continuation link without generating or losing context',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);const generate=vi.fn();
 const draft=accountProjectDraft({id:'d0000000-0000-4000-8000-000000000002',owner_id:'d0000000-0000-4000-8000-000000000001',current_revision:1,title:'Fictional brand',scope:'complete_brand',created_at:'2026-10-07T00:00:00Z',context:contextSnapshotSchema.parse({description:'Keep this original brief'})});
 function Harness(){const [value,set]=useState(draft);return createElement(ProjectEditorForm,{draft:value,storage:{kind:'account',saveLabel:'Saved',onUpdate:(patch:DraftPatch)=>{set(v=>({...v,...patch}));return false;},onStrategyRequested:generate}});}
 const host=document.createElement('div');document.body.append(host);root=createRoot(host);await act(async()=>root!.render(createElement(Harness)));
 await act(async()=>{window.history.replaceState(null,'','#strategy-positioning');window.dispatchEvent(new HashChangeEvent('hashchange'));});
 expect(host.querySelector('button[aria-label="Collapse positioning"]')).not.toBeNull();expect(host.textContent).toContain('Keep this original brief');expect(generate).not.toHaveBeenCalled();expect(host.querySelector('#strategy-brief')).not.toBeNull();
});
