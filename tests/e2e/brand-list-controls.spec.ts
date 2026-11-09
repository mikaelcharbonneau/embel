import { expect, test, type Page, type Route } from '@playwright/test';
import { accountProjectDraft } from '../../src/components/workspace/project-draft-adapter';
import { contextSnapshotSchema } from '../../src/domain/projects';

// Synthetic read-only account API fixtures and device drafts. No live calls or project writes.
const owner='aaaaaaaa-7777-4777-8777-777777777777';
const id=(n:number)=>`cccccccc-7777-4777-8777-${String(n).padStart(12,'0')}`;
const row=(n:number)=>({id:id(n),owner_id:owner,scope:'complete_brand' as const,title:`Brand ${n}`,current_revision:1,created_at:`2026-10-05T12:00:00.${String(n).padStart(6,'0')}Z`,deleted_at:null,deletion_requested_at:null,deletion_state:'active' as const,lifecycle_version:0});
const rows=Array.from({length:125},(_,i)=>row(125-i));
async function reply(route:Route,body:unknown,status=200){await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});}
async function fixture(page:Page, projects=rows){
 const state={reads:0,status:200,writes:[] as string[]};
 await page.route('**/api/**',async route=>{
  const r=route.request(),url=new URL(r.url());if(r.method()!=='GET'){state.writes.push(url.pathname);return reply(route,{},405);}
  if(url.pathname==='/api/session')return reply(route,{user:{id:owner}});
  if(url.pathname==='/api/projects/page'){
   state.reads++;const cursor=url.searchParams.get('cursorId'),start=cursor?projects.findIndex(p=>p.id===cursor)+1:0,items=projects.slice(start,start+50),last=items.at(-1);
   return reply(route,{ownerId:owner,items,nextCursor:last&&start+50<projects.length?{id:last.id,createdAt:last.created_at}:null},state.status);
  }return reply(route,{},404);
 });return state;
}
const account=(page:Page)=>page.locator('.projects-page');
const browser=(page:Page)=>page.locator('.projects-page');
const cards=(section:ReturnType<typeof account>)=>section.locator('.project-card[data-storage=account]');
const browserCards=(page:Page)=>page.locator('.project-card[data-storage=browser]');
async function sortControl(page:Page){const panel=page.locator('.projects-control').filter({has:page.getByText('Sort',{exact:true})});if(!await panel.evaluate(node=>(node as HTMLDetailsElement).open))await page.getByText('Sort',{exact:true}).click();return page.getByRole('combobox',{name:'Sort projects',exact:true});}
test('brand controls fixture: alphabetical sorting never changes continuation anchors or stored membership',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(50);
 const sort=(await sortControl(page));await sort.selectOption('alphabetical');
 await expect(cards(account(page)).first()).toContainText('Brand 76');await account(page).getByRole('button',{name:'Load more projects',exact:true}).click();
 await expect(cards(account(page))).toHaveCount(100);await expect(cards(account(page)).first()).toContainText('Brand 26');
 await (await sortControl(page)).selectOption('created');await expect(cards(account(page)).first()).toContainText('Brand 125');expect(state.reads).toBe(2);expect(state.writes).toEqual([]);
});
test('brand controls fixture: later-page failure keeps sort plus all already-loaded cards',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(50);
 await (await sortControl(page)).selectOption('alphabetical');state.status=503;
 await account(page).getByRole('button',{name:'Load more projects',exact:true}).click();await expect(account(page).getByRole('alert')).toBeVisible();await expect(cards(account(page))).toHaveCount(50);
 state.status=200;await account(page).getByRole('button',{name:'Try loading projects again',exact:true}).click();await expect(cards(account(page))).toHaveCount(75);await expect(cards(account(page)).first()).toContainText('Brand 51');
});
test('brand controls fixture: project sorts never modify durable device drafts, including ones saved with retired project types',async({page},info)=>{
 const state=await fixture(page);const drafts=[
  {n:1,title:'Zulu draft',scope:'complete_brand',created:'2026-10-01T10:00:00Z',updated:'2026-10-05T10:00:00Z'},
  {n:2,title:'Alpha draft',scope:'naming_only',created:'2026-10-03T10:00:00Z',updated:'2026-10-04T10:00:00Z'},
  {n:3,title:'Middle draft',scope:'visual_identity_only',created:'2026-10-02T10:00:00Z',updated:'2026-10-03T10:00:00Z'},
 ].map(d=>({...accountProjectDraft({...row(d.n),title:d.title,context:contextSnapshotSchema.parse({description:'Synthetic manual brand brief.'})}),scope:d.scope,createdAt:d.created,updatedAt:d.updated}));
 const stored=JSON.stringify({version:1,drafts});await page.addInitScript(stored=>{localStorage.setItem('fluid.local-drafts.v1',stored);},stored);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(50);await expect(browserCards(page)).toHaveCount(0);
 const recovery=page.getByRole('region',{name:'Recover unsaved projects',exact:true});await expect(recovery.getByRole('radio')).toHaveCount(0);await recovery.getByRole('button',{name:'Recover unsaved projects',exact:true}).click();await expect(recovery.getByRole('radio')).toHaveCount(3);
 for(const title of ['Zulu draft','Alpha draft','Middle draft'])await expect(recovery.getByText(title,{exact:true})).toBeVisible();
 const sort=(await sortControl(page));await expect(sort).toHaveValue('created');await expect(cards(account(page)).first()).toContainText('Brand 125');
 await sort.selectOption('alphabetical');await expect(cards(account(page)).first()).toContainText('Brand 76');await expect(recovery.getByRole('radio')).toHaveCount(3);
 await page.getByRole('searchbox').fill('unmatched');await expect(cards(account(page))).toHaveCount(0);await expect(browser(page)).toContainText('No matching projects');await page.getByRole('searchbox').clear();await expect(cards(account(page))).toHaveCount(50);await expect(recovery.getByRole('radio')).toHaveCount(3);
 expect(await page.evaluate(()=>localStorage.getItem('fluid.local-drafts.v1'))).toBe(stored);expect(state.reads).toBe(1);expect(state.writes).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);await page.screenshot({path:info.outputPath('brand-controls.png'),fullPage:true,scale:'css'});
});

test('brand controls fixture: equivalent alphabetical titles use exact creation precision then UUID as stable ties',async({page})=>{
 const data=[{...row(4),title:'Same name',created_at:'2026-10-05T12:00:00.000002Z'},
  {...row(3),title:'Same name',created_at:'2026-10-05T12:00:00.000002Z'},
  {...row(8),title:'Same name',created_at:'2026-10-05T12:00:00.000001Z'}];
 const state=await fixture(page,data);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(3);
 await (await sortControl(page)).selectOption('alphabetical');
 await expect(cards(account(page)).nth(0).getByRole('link')).toHaveAttribute('href',`/brands/account/${id(4)}`);await expect(cards(account(page)).nth(1).getByRole('link')).toHaveAttribute('href',`/brands/account/${id(3)}`);await expect(cards(account(page)).nth(2).getByRole('link')).toHaveAttribute('href',`/brands/account/${id(8)}`);expect(state.reads).toBe(1);
});
test('brand controls fixture: a keyboard-operated sort control does not request or write new data',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(50);
 await expect(page.getByText('Filter',{exact:true})).toHaveCount(0);
 const sort=(await sortControl(page));await sort.focus();await sort.press('a');await sort.press('Enter');await expect(sort).toHaveValue('alphabetical');await expect(cards(account(page)).first()).toContainText('Brand 76');expect(state.reads).toBe(1);expect(state.writes).toEqual([]);
});
