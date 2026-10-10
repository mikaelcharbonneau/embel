import { expect, test, type Page, type Route } from '@playwright/test';
import { accountProjectDraft } from '../../src/components/workspace/project-draft-adapter';
import { contextSnapshotSchema } from '../../src/domain/projects';

// Synthetic read-only account API fixtures and device drafts. No live calls or project writes.
const owner='aaaaaaaa-7777-4777-8777-777777777777';
const id=(n:number)=>`cccccccc-7777-4777-8777-${String(n).padStart(12,'0')}`;
const row=(n:number)=>({id:id(n),owner_id:owner,scope:n<=50?'complete_brand':'naming_only',title:`Brand ${n}`,current_revision:1,created_at:`2026-10-05T12:00:00.${String(n).padStart(6,'0')}Z`});
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
async function scopeControl(page:Page){const panel=page.locator('.projects-control').filter({has:page.getByText('Filter',{exact:true})});if(!await panel.evaluate(node=>(node as HTMLDetailsElement).open))await page.getByText('Filter',{exact:true}).click();return page.getByRole('combobox',{name:'Filter projects by scope',exact:true});}
async function sortControl(page:Page){const panel=page.locator('.projects-control').filter({has:page.getByText('Sort',{exact:true})});if(!await panel.evaluate(node=>(node as HTMLDetailsElement).open))await page.getByText('Sort',{exact:true}).click();return page.getByRole('combobox',{name:'Sort projects',exact:true});}
test('brand controls fixture: a scope with no loaded matches retains continuation until older matching projects arrive',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(account(page)).toContainText('50 account projects loaded');
 await (await scopeControl(page)).selectOption('complete_brand');await expect(cards(account(page))).toHaveCount(0);
 await expect(account(page)).toContainText('No matching projects');await account(page).getByRole('button',{name:'Load more account projects',exact:true}).click();
 await expect(account(page)).toContainText('100 account projects loaded');await expect(cards(account(page))).toHaveCount(25);
 await account(page).getByRole('button',{name:'Load more account projects',exact:true}).click();await expect(cards(account(page))).toHaveCount(50);await expect(account(page)).toContainText('125 account projects loaded');
 await expect(account(page)).toContainText('Search, filters and sorting apply to loaded projects');expect(state.reads).toBe(3);expect(state.writes).toEqual([]);
});
test('brand controls fixture: alphabetical sorting never changes continuation anchors or stored membership',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(account(page)).toContainText('50 account projects loaded');
 const sort=(await sortControl(page));await sort.selectOption('alphabetical');
 await expect(cards(account(page)).first()).toContainText('Brand 76');await account(page).getByRole('button',{name:'Load more account projects',exact:true}).click();
 await expect(account(page)).toContainText('100 account projects loaded');await expect(cards(account(page)).first()).toContainText('Brand 26');
 await (await sortControl(page)).selectOption('created');await expect(cards(account(page)).first()).toContainText('Brand 125');expect(state.reads).toBe(2);expect(state.writes).toEqual([]);
});
test('brand controls fixture: later-page failure keeps scope and sort plus all already-loaded cards',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(account(page)).toContainText('50 account projects loaded');
 await (await scopeControl(page)).selectOption('naming_only');await (await sortControl(page)).selectOption('alphabetical');state.status=503;
 await account(page).getByRole('button',{name:'Load more account projects',exact:true}).click();await expect(account(page).getByRole('alert')).toBeVisible();await expect(cards(account(page))).toHaveCount(50);
 state.status=200;await account(page).getByRole('button',{name:'Try loading account projects again',exact:true}).click();await expect(cards(account(page))).toHaveCount(75);await expect(cards(account(page)).first()).toContainText('Brand 51');
});
test('brand controls fixture: scope and project sorts never modify durable device drafts',async({page},info)=>{
 const state=await fixture(page);const drafts=[
  {n:1,title:'Zulu draft',scope:'complete_brand' as const,created:'2026-10-01T10:00:00Z',updated:'2026-10-05T10:00:00Z'},
  {n:2,title:'Alpha draft',scope:'naming_only' as const,created:'2026-10-03T10:00:00Z',updated:'2026-10-04T10:00:00Z'},
  {n:3,title:'Middle draft',scope:'visual_identity_only' as const,created:'2026-10-02T10:00:00Z',updated:'2026-10-03T10:00:00Z'},
 ].map(d=>({...accountProjectDraft({...row(d.n),scope:d.scope,title:d.title,context:contextSnapshotSchema.parse({description:'Synthetic manual brand brief.'})}),createdAt:d.created,updatedAt:d.updated}));
 const stored=JSON.stringify({version:1,drafts});await page.addInitScript(stored=>{localStorage.setItem('fluid.local-drafts.v1',stored);},stored);await page.goto('/brands');await expect(browserCards(page)).toHaveCount(3);
 const sort=(await sortControl(page));await expect(sort).toHaveValue('updated');await expect(browserCards(page).first()).toContainText('Zulu draft');
 await sort.selectOption('created');await expect(browserCards(page).first()).toContainText('Alpha draft');await sort.selectOption('alphabetical');await expect(browserCards(page).first()).toContainText('Alpha draft');
 await (await scopeControl(page)).selectOption('visual_identity_only');await expect(browserCards(page)).toHaveCount(1);await expect(browserCards(page).first()).toContainText('Middle draft');
 await page.getByRole('searchbox').fill('unmatched');await expect(browserCards(page)).toHaveCount(0);await expect(browser(page)).toContainText('No matching projects');await page.getByRole('searchbox').clear();
 expect(await page.evaluate(()=>localStorage.getItem('fluid.local-drafts.v1'))).toBe(stored);expect(state.writes).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);await page.screenshot({path:info.outputPath('brand-controls.png'),fullPage:true,scale:'css'});
});

test('brand controls fixture: equivalent alphabetical titles use exact creation precision then UUID as stable ties',async({page})=>{
 const data=[{...row(4),title:'Same name',created_at:'2026-10-05T12:00:00.000002Z'},
  {...row(3),title:'Same name',created_at:'2026-10-05T12:00:00.000002Z'},
  {...row(8),title:'Same name',created_at:'2026-10-05T12:00:00.000001Z'}];
 const state=await fixture(page,data);await page.goto('/brands');await expect(cards(account(page))).toHaveCount(3);
 await (await sortControl(page)).selectOption('alphabetical');
 await expect(cards(account(page)).nth(0)).toHaveAttribute('href',`/brands/account/${id(4)}`);await expect(cards(account(page)).nth(1)).toHaveAttribute('href',`/brands/account/${id(3)}`);await expect(cards(account(page)).nth(2)).toHaveAttribute('href',`/brands/account/${id(8)}`);expect(state.reads).toBe(1);
});
test('brand controls fixture: keyboard-operated scope and sort controls do not request or write new data',async({page})=>{
 const state=await fixture(page);await page.goto('/brands');await expect(account(page)).toContainText('50 account projects loaded');
 const scope=(await scopeControl(page));await scope.focus();await expect(scope).toBeFocused();await scope.press('v');await scope.press('Enter');await expect(scope).toHaveValue('visual_identity_only');await expect(cards(account(page))).toHaveCount(0);
 await scope.selectOption('all');await expect(scope).toHaveValue('all');await expect(cards(account(page))).toHaveCount(50);
 const sort=(await sortControl(page));await sort.focus();await sort.press('a');await sort.press('Enter');await expect(sort).toHaveValue('alphabetical');await expect(cards(account(page)).first()).toContainText('Brand 76');expect(state.reads).toBe(1);expect(state.writes).toEqual([]);
});
