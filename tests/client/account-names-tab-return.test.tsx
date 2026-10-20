// @vitest-environment jsdom
import { act, createElement, Fragment, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NamesWorkspace } from "@/components/naming/names-workspace";
import { createAccountNamesMemory } from "@/components/naming/account-names-memory";
import { accountNamesPageSchema, createBrandFromProjectNameResponseSchema, nameIdentityKey, namingStrategyBasis, namingStrategyKey, type AccountNameEntry, type AccountNamesPage } from "@/domain/project-naming";
import { initialNamingView } from "@/components/naming/use-project-naming";
import { createEmptyNamesWorkspace, namesWorkspaceSchema } from "@/domain/names-workspace";
import { accountProjectSchema } from "@/domain/project-api";
import type { VerifiedAccount } from "@/components/workspace/account-session";

const mock = vi.hoisted(() => ({ session: null as VerifiedAccount | { status: "checking" | "signed_out"; generation: number } | null,
  memory: null as ReturnType<typeof createAccountNamesMemory> | null, current: vi.fn(), expire: vi.fn(), navigate: vi.fn() }));
vi.mock("@/components/workspace/account-session", () => ({ useAccountSession: () => ({ session: mock.session, namesDrafts: mock.memory, isCurrent: mock.current, expire: mock.expire }), AccountStatus: () => createElement("p", {}, "Verify account") }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mock.navigate }) }));
vi.mock("@/components/naming/standalone-names-assistant", () => ({ StandaloneNamesAssistant: () => null }));
vi.mock("@/features/names-assistant", () => ({ NamesAssistant: () => null }));

const owner = "aaaaaaaa-1111-4111-8111-111111111111", projectId = "bbbbbbbb-1111-4111-8111-111111111111", when = "2026-10-20T12:00:00Z";
const id = (n: number) => `cccccccc-1111-4111-8111-${String(n).padStart(12, "0")}`;
const project = accountProjectSchema.parse({ id: projectId, owner_id: owner, title: "Private project", scope: "naming_only", current_revision: 1, created_at: when, context: { description: "Synthetic Naming tab-return fixture" } });
function row(n: number): AccountNameEntry {
  const value = `Account ${n}`, createdAt = new Date(Date.parse(when) + n * 1000).toISOString();
  return { candidate: { id: id(n), ownerId: owner, projectId, value, identityKey: nameIdentityKey(value), rationale: `Private rationale ${n}`, contextRevision: 1, strategyBasis: namingStrategyBasis(project.context), strategyKey: namingStrategyKey(project.context), createdAt,
    origin: { kind: "local_import", ownerId: owner, projectId, candidateId: id(n), contextRevision: 1, source: { id: id(n), value, origin: "manual", history: [], createdAt }, capturedContext: project.context } },
    retention: { ownerId: owner, projectId, candidateId: id(n), revision: 1, favorite: true, saved: true, updatedAt: when }, project: { id: projectId, owner_id: owner, title: project.title, scope: "naming_only", current_revision: 1, created_at: when }, currentSelection: false, earlierContext: false };
}
function page(items = [row(1), row(2)], more = false): AccountNamesPage { const last = items.at(-1)?.candidate; return accountNamesPageSchema.parse({ ownerId: owner, items, nextCursor: more && last ? { id: last.id, createdAt: last.createdAt } : null }); }
function promotion(entry: AccountNameEntry) {
  const newId = id(901), candidateId = id(902), selectionId = id(903), source = entry.candidate;
  const promoted = { ...project, id: newId, scope: "complete_brand", title: source.value, context: { ...project.context, selectedName: source.value, intake: { suppliedName: source.value } } };
  return createBrandFromProjectNameResponseSchema.parse({ project: promoted,
    session: { ownerId: owner, projectId: newId, revision: 1, currentPreferencesVersion: 0, latestBatchSequence: 0, currentSelectionId: selectionId, viewRevision: 1, viewState: initialNamingView, createdAt: when, updatedAt: when },
    currentSelection: { candidate: { ...source, id: candidateId, projectId: newId, origin: { kind: "account_copy", authorship: "user_supplied", sourceProjectId: projectId, sourceCandidateId: source.id, sourceContextRevision: 1, root: source.origin, history: [] } },
      selection: { id: selectionId, ownerId: owner, projectId: newId, candidateId, projectRevision: 1, previousSelectionId: null, acceptedEarlierContext: false, createdAt: when } } });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, read: (path: string, init: RequestInit) => Promise<Response>, mutation: (path: string, init: RequestInit) => Promise<Response>;
let onCommit: (() => void) | null;
function CommitProbe() { useLayoutEffect(() => { onCommit?.(); }); return null; }
function tree() { return createElement(Fragment, null, createElement(NamesWorkspace), createElement(CommitProbe)); }
const requests = () => fetcher.mock.calls.filter(([path]) => String(path).startsWith("/api/names?"));
const writes = () => fetcher.mock.calls.filter(([path, init]) => String(path).startsWith(`/api/projects/`) && init.method !== "GET");
const library = () => host.querySelector<HTMLElement>('[aria-label="Account names library"]')!;
const cards = () => [...library().querySelectorAll<HTMLElement>('.project-naming-card')];
const button = (text: string, within: ParentNode = host) => [...within.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === text || node.textContent?.trim() === text)!;
async function render() { await act(async () => root.render(tree())); await tick(); }
async function tick(ms = 0) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function click(text: string, within: ParentNode = host) { const node = button(text, within); expect(node, text).toBeDefined(); await act(async () => node.click()); }
async function input(node: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })); }); }
async function select(node: HTMLSelectElement, value: string) { await act(async () => { node.value = value; node.dispatchEvent(new Event('change', { bubbles: true })); }); }
function memory() { const value = createAccountNamesMemory(); value.bind(mock.session?.status === 'ready' ? mock.session : null); return value; }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); Element.prototype.scrollIntoView = vi.fn();
  mock.session = { status: 'ready', userId: owner, generation: 1 }; mock.current = vi.fn((account: VerifiedAccount) => mock.session?.status === 'ready' && account.userId === mock.session.userId && account.generation === mock.session.generation);
  mock.expire = vi.fn(); mock.navigate.mockReset();
  onCommit = null;
  read = async () => Response.json(page()); mutation = async () => new Response(null, { status: 503 });
  const workspace = createEmptyNamesWorkspace(); workspace.ui.tab = 'library';
  workspace.candidates.push({ source: { id: id(800), value: 'Local retained', origin: 'manual', history: [], createdAt: when }, context: project.context, runId: null, explanation: 'Added manually', favorite: true, saved: true });
  namesWorkspaceSchema.parse(workspace);
  fetcher = vi.fn(async (path: string, init: RequestInit) => {
    if (path === '/api/names/workspace') { const body = init.body ? JSON.parse(String(init.body)) : null; return Response.json({ ownerId: mock.session?.status === 'ready' ? mock.session.userId : owner, workspace: { id: id(700), ownerId: mock.session?.status === 'ready' ? mock.session.userId : owner, revision: body ? body.expectedRevision + 1 : 1, payload: body?.payload ?? workspace, createdAt: when, updatedAt: when } }); }
    if (path.startsWith('/api/names?')) return read(path, init);
    return mutation(path, init);
  });
  vi.stubGlobal('fetch', fetcher); mock.memory = memory(); host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); mock.memory?.clear(); host.remove(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('shows retained account rows immediately on tab return, keeps both toolbars and focus, but awaits fresh action authority', async () => {
  await render(); expect(cards()).toHaveLength(2);
  await input(host.querySelector<HTMLInputElement>('.names-search input')!, 'Local');
  await select(host.querySelector<HTMLSelectElement>('[aria-label="Filter names"]')!, 'saved');
  await select(host.querySelector<HTMLSelectElement>('[aria-label="Name source"]')!, 'manual');
  await input(library().querySelector('input')!, 'Account');
  await select(library().querySelector('select')!, projectId);
  await click('History'); const before = requests().length; await tick(15_000); expect(requests()).toHaveLength(before);
  expect(host.querySelector('[aria-label="Account names library"]')).toBeNull();
  const held = deferred<Response>(); read = async () => held.promise;
  const libraryTab = button('Library'); libraryTab.focus();
  await click('Library');
  expect(document.activeElement).toBe(libraryTab);
  expect(cards()).toHaveLength(2); expect(library().textContent).toContain('Checking saved account names');
  expect(library().textContent).toContain('last checked');
  expect(host.querySelector<HTMLInputElement>('.names-search input')!.value).toBe('Local');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Filter names"]')!.value).toBe('saved');
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Name source"]')!.value).toBe('manual');
  const field = library().querySelector<HTMLInputElement>('input')!, projectFilter = library().querySelector<HTMLSelectElement>('select')!, retainedCard = cards()[0];
  expect(field.value).toBe('Account'); expect(projectFilter.value).toBe(projectId); field.focus();
  for (const node of library().querySelectorAll<HTMLButtonElement>('.project-naming-card button')) expect(node.disabled).toBe(true);
  await click('Create brand', retainedCard); expect(writes()).toHaveLength(0);
  const updated = { ...row(1), retention: { ...row(1).retention, revision: 2, favorite: false } };
  await act(async () => held.resolve(Response.json(page([updated, row(2)]))));
  expect(cards()[0]).toBe(retainedCard); expect(library().querySelector('input')).toBe(field); expect(document.activeElement).toBe(field);
  expect(button('Favorite Account 1', library()).disabled).toBe(false); expect(mock.navigate).not.toHaveBeenCalled();
});

it('retains a failed return snapshot without enabling writes or pagination and retries the fresh first page', async () => {
  read = async () => Response.json(page(undefined, true)); await render(); await click('History');
  read = async () => new Response(null, { status: 503 }); await click('Library'); await tick();
  expect(cards()).toHaveLength(2); expect(library().textContent).toContain('last checked');
  expect(button('Create brand', library()).disabled).toBe(true); expect(button('Load more account names', library()).disabled).toBe(true);
  expect(button('Check account names', library())).toBeDefined();
  read = async () => Response.json(page([row(3)])); await click('Check account names', library()); await tick();
  expect(cards()).toHaveLength(1); expect(library().textContent).toContain('Account 3'); expect(library().textContent).not.toContain('Account 1');
  expect(button('Create brand', library()).disabled).toBe(false); expect(requests().at(-1)![0]).toBe('/api/names?limit=100'); expect(writes()).toHaveLength(0);
});

it('does not expose or dispatch an old cursor from a retained multi-page display', async () => {
  read = async path => Response.json(page(path.includes('cursorId') ? [row(3), row(4)] : [row(1), row(2)], true));
  await render(); await click('Load more account names', library()); expect(cards()).toHaveLength(4);
  await click('History'); const held = deferred<Response>(); read = async () => held.promise; await click('Library');
  expect(cards()).toHaveLength(4); const count = requests().length;
  expect(button('Load more account names', library()).disabled).toBe(true); await click('Load more account names', library()); expect(requests()).toHaveLength(count);
  expect(requests().at(-1)![0]).toBe('/api/names?limit=100');
  await act(async () => held.resolve(Response.json(page([row(11), row(12)], true))));
  read = async () => Response.json(page([row(13)])); await click('Load more account names', library());
  const url = new URL(requests().at(-1)![0], 'https://fixture.invalid'); expect(url.searchParams.get('cursorId')).toBe(id(12)); expect(url.searchParams.get('cursorId')).not.toBe(id(4));
  expect(cards().map(card => card.querySelector('h3')?.textContent)).toEqual(['Account 11', 'Account 12', 'Account 13']);
});

it.each(['checking', 'signed_out'] as const)('hides snapshot data immediately during %s and never restores it for a new generation', async status => {
  await render(); await click('History');
  await act(async () => { mock.memory!.bind(null); mock.session = { status, generation: 2 }; root.render(tree()); });
  expect(host.textContent).not.toContain('Account 1'); expect(host.textContent).not.toContain('Private project'); expect(host.querySelector('[aria-label="Account names library"]')).toBeNull();
  const held = deferred<Response>(); read = async () => held.promise;
  mock.session = { status: 'ready', userId: owner, generation: 2 }; mock.memory!.bind(mock.session); await render();
  await click('Library');
  expect(host.querySelector('[aria-label="Account names library"]')).not.toBeNull(); expect(cards()).toHaveLength(0);
  expect(library().textContent).toContain('Loading your account names');
  await act(async () => held.resolve(Response.json(page([row(5)])))); expect(library().textContent).toContain('Account 5'); expect(library().textContent).not.toContain('Account 1');
});

it.each(['callbacks', 'names memory'] as const)('replaces the exact provider-client %s even when the old client remains current for the same owner/generation', async change => {
  await render(); await click('History');
  const oldCurrent = mock.current; oldCurrent.mockImplementation(() => true);
  const old = deferred<Response>(); read = async () => old.promise; await click('Library');
  const current = deferred<Response>(); read = async () => current.promise;
  if (change === 'callbacks') { mock.current = vi.fn(() => true); mock.expire = vi.fn(); }
  else { await act(async () => { const previous = mock.memory; mock.memory = memory(); previous!.clear(); }); }
  await render();
  expect(cards()).toHaveLength(0); expect(library().textContent).toContain('Loading your account names');
  await act(async () => old.resolve(Response.json(page([row(99)])))); expect(cards()).toHaveLength(0);
  await act(async () => current.resolve(Response.json(page([row(7)])))); expect(library().textContent).toContain('Account 7'); expect(library().textContent).not.toContain('Account 99');
  await click('History'); const next = deferred<Response>(); read = async () => next.promise; await click('Library');
  expect(cards()).toHaveLength(1); expect(library().textContent).toContain('Account 7'); await act(async () => next.resolve(Response.json(page([row(7)]))));
});

it('discards the retained account list for a confirmed different owner', async () => {
  await render(); await click('History');
  const other = 'dddddddd-1111-4111-8111-111111111111';
  const held = deferred<Response>(); read = async () => held.promise;
  await act(async () => { mock.session = { status: 'ready', userId: other, generation: 2 }; mock.memory!.bind(mock.session); }); await render();
  expect(cards()).toHaveLength(0); expect(host.textContent).not.toContain('Account 1'); expect(host.textContent).not.toContain('Private project');
  await act(async () => held.resolve(Response.json({ ownerId: other, items: [], nextCursor: null })));
  expect(cards()).toHaveLength(0); expect(mock.navigate).not.toHaveBeenCalled();
});

it.each(['retention', 'promotion'] as const)('client replacement stops a pending %s even if the prior provider still reports current', async kind => {
  await render(); const held = deferred<Response>(); mock.current.mockImplementation(() => true);
  let oldSignal!: AbortSignal;
  mutation = async (_path, init) => { oldSignal = init.signal as AbortSignal; return held.promise; };
  await click(kind === 'retention' ? 'Unfavorite Account 1' : 'Create brand', cards()[0]);
  const fresh = deferred<Response>(); read = async () => fresh.promise;
  onCommit = () => expect(oldSignal.aborted).toBe(true);
  mock.current = vi.fn(() => true); mock.expire = vi.fn(); await render(); expect(cards()).toHaveLength(0);
  onCommit = null;
  const updated = { ...row(1), retention: { ...row(1).retention, revision: 2, favorite: false } };
  await act(async () => held.resolve(Response.json(kind === 'retention' ? { entry: { candidate: updated.candidate, retention: updated.retention } } : promotion(row(1)))));
  expect(cards()).toHaveLength(0); expect(mock.navigate).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  await act(async () => fresh.resolve(Response.json(page([row(6)])))); expect(library().textContent).toContain('Account 6'); expect(library().textContent).not.toContain('Account 1');
});

it.each(['retention', 'promotion'] as const)('invalidates at %s start, aborts on tab exit and ignores an abort-disregarding late reply', async kind => {
  await render(); const held = deferred<Response>(); let signal!: AbortSignal;
  mutation = async (_path, init) => { signal = init.signal as AbortSignal; return held.promise; };
  await click(kind === 'retention' ? 'Unfavorite Account 1' : 'Create brand', cards()[0]);
  expect(writes()).toHaveLength(1); const body = writes()[0]![1].body;
  await click('History'); expect(signal.aborted).toBe(true);
  const fresh = deferred<Response>(); read = async () => fresh.promise; await click('Library');
  expect(cards()).toHaveLength(0); expect(library().textContent).toContain('Loading your account names');
  const updated = { ...row(1), retention: { ...row(1).retention, revision: 2, favorite: false } };
  await act(async () => held.resolve(Response.json(kind === 'retention' ? { entry: { candidate: updated.candidate, retention: updated.retention } } : promotion(row(1)))));
  expect(cards()).toHaveLength(0); expect(mock.navigate).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1); expect(writes()[0]![1].body).toBe(body);
  await act(async () => fresh.resolve(Response.json(page([row(8)])))); expect(library().textContent).toContain('Account 8'); expect(library().textContent).not.toContain('Account 1');
});

it('does not resurrect invalidated display rows after a failed uncertain mutation or a later UI edit', async () => {
  await render(); await click('Unfavorite Account 1', cards()[0]);
  expect(library().textContent).toContain('favorite change could not be confirmed'); expect(cards()).toHaveLength(2);
  await input(library().querySelector('input')!, 'Account'); await click('History');
  const held = deferred<Response>(); read = async () => held.promise; await click('Library');
  expect(cards()).toHaveLength(0); expect(writes()).toHaveLength(1);
  await act(async () => held.resolve(Response.json(page())));
});

it('does not let a late pre-mutation GET refill the snapshot or roll back acknowledged retention', async () => {
  await render(); await click('Unfavorite Account 1', cards()[0]);
  const old = deferred<Response>(); read = async () => old.promise; await click('Check account names', library());
  const updated = { ...row(1), retention: { ...row(1).retention, revision: 2, favorite: false } };
  mutation = async () => Response.json({ entry: { candidate: updated.candidate, retention: updated.retention } });
  await click('Unfavorite Account 1', cards()[0]); expect(button('Favorite Account 1', library())).toBeDefined();
  await act(async () => old.resolve(Response.json(page()))); expect(button('Favorite Account 1', library())).toBeDefined();
  await click('History'); const fresh = deferred<Response>(); read = async () => fresh.promise; await click('Library'); expect(cards()).toHaveLength(0);
  await act(async () => fresh.resolve(Response.json(page([updated]))));
});

it('distinguishes a verified empty return snapshot from a never-loaded account list', async () => {
  const first = deferred<Response>(); read = async () => first.promise; await render();
  expect(library().textContent).toContain('Loading your account names'); expect(library().textContent).not.toContain('Keep the names that matter');
  await act(async () => first.resolve(Response.json(page([])))); expect(library().textContent).toContain('Keep the names that matter');
  await click('History'); const second = deferred<Response>(); read = async () => second.promise; await click('Library');
  expect(library().textContent).toContain('Keep the names that matter'); expect(library().textContent).toContain('last checked'); expect(library().textContent).toContain('Checking saved account names');
  await act(async () => second.resolve(Response.json(page([]))));
});
