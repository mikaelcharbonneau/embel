import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountIdentityClient, identityObservation, IDENTITY_JSON_MAX_BYTES, IDENTITY_REQUEST_TIMEOUT_MS } from "@/components/identity/account-identity-client";
import { getIdentityFreshness, selectIdentitySystem, type RefineIdentityComponent } from "@/domain/project-identity";
import { fixtureAt, fixtureId, fixtureInput, fixtureOverview, fixtureOwner, fixtureProject, fixtureRefinement, fixtureSystem } from "./project-identity-fixtures";

const account = { status: "ready" as const, userId: fixtureOwner, generation: 1 };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function setup() {
  let current = true;
  const expire = vi.fn(), fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
  const client = createAccountIdentityClient(account, fixtureProject, () => current, expire);
  return { client, fetcher, expire, loseScope: () => { current = false; } };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("fenced Identity account client", () => {
  it("uses the exact strict overview query and same-origin private route", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(); fetcher.mockResolvedValue(json(overview));
    expect(await client.overview()).toEqual(overview);
    expect(fetcher).toHaveBeenCalledWith(`/api/projects/${fixtureProject}/identity?limit=20`, expect.objectContaining({ credentials: "same-origin", cache: "no-store", redirect: "error" }));
  });
  it("rejects an echoed query mismatch and foreign-project cursors before use", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview();
    fetcher.mockResolvedValue(json({ ...overview, systems: { ...overview.systems, query: { limit: 10 } } }));
    await expect(client.overview()).rejects.toMatchObject({ status: 502 });
    await expect(client.overview({ cursor: { projectId: fixtureId(999), id: fixtureId(10), createdAt: fixtureAt } })).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("ignores a delayed successful read after its account scope disappears", async () => {
    const { client, fetcher, loseScope } = setup();
    let resolve!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>(done => { resolve = done; }));
    const pending = client.overview(); loseScope(); resolve(json(fixtureOverview()));
    expect(await pending).toBeNull();
  });
  it("fences responses again after their body stream completes", async () => {
    const { client, fetcher, loseScope } = setup(); let stream!: ReadableStreamDefaultController<Uint8Array>;
    fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }), { headers: { "Content-Type": "application/json" } }));
    const pending = client.overview(); await Promise.resolve(); await Promise.resolve();
    loseScope(); stream.enqueue(new TextEncoder().encode(JSON.stringify(fixtureOverview()))); stream.close();
    expect(await pending).toBeNull();
  });
  it("expires only its verified scope on401 and never returns the response", async () => {
    const { client, fetcher, expire } = setup(); fetcher.mockResolvedValue(json({ error: "expired" }, 401));
    expect(await client.overview()).toBeNull(); expect(expire).toHaveBeenCalledWith(account);
  });
  it("rejects a structurally valid response from another owner before exposing it", async () => {
    const { client, fetcher, expire } = setup();
    const foreign = JSON.parse(JSON.stringify(fixtureOverview()).replaceAll(fixtureOwner, fixtureId(999)));
    fetcher.mockResolvedValue(json(foreign));
    expect(await client.overview()).toBeNull(); expect(expire).toHaveBeenCalledWith(account);
  });
  it("fails closed for malformed complete manifests and inaccessible resources", async () => {
    const { client, fetcher } = setup(), system = fixtureSystem();
    fetcher.mockResolvedValue(json({ ownerId: fixtureOwner, projectId: fixtureProject, system: { ...system, components: { logo: system.components.logo } }, currentBasis: { status: "available", basis: system.input.basis }, freshness: { status: "current", changed: [] } }));
    await expect(client.detail(system.id)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValue(json({}, 404)); await expect(client.detail(system.id)).rejects.toMatchObject({ status: 404 });
  });
  it("preserves all100 selected references and both full snapshots above4MiB", async () => {
    const { client, fetcher } = setup(), input = fixtureInput({ references: 100, maximal: true });
    const overview = fixtureOverview({ input, selected: true });
    const encoded = JSON.stringify(overview), bytes = new TextEncoder().encode(encoded).byteLength;
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024); expect(bytes).toBeLessThan(IDENTITY_JSON_MAX_BYTES);
    fetcher.mockResolvedValue(json(overview));
    const result = await client.overview();
    expect(result?.referenceSnapshot.selected).toHaveLength(100);
    expect(result?.currentSelection?.system.input.referenceSnapshot.selected).toHaveLength(100);
  });
  it("enforces actual streamed metadata bytes even without Content-Length", async () => {
    const { client, fetcher } = setup();
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 17; i++) controller.enqueue(chunk); controller.close(); } }), { headers: { "Content-Type": "application/json" } }));
    await expect(client.overview()).rejects.toMatchObject({ status: 502 });
  });
  it("rejects wrong preference value or revision receipts without claiming a save", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), preferences = { ...overview.currentBasis.status === "available" ? overview.currentBasis.basis.preferences : fixtureInput().preferences, notes: "New direction" };
    const reply = { session: { ownerId: fixtureOwner, projectId: fixtureProject, identityRevision: 0, currentSelectionId: null, currentPreferencesRevision: 1, createdAt: fixtureAt, updatedAt: fixtureAt },
      preferences: { ownerId: fixtureOwner, projectId: fixtureProject, revision: 1, preferences, createdAt: fixtureAt } };
    fetcher.mockResolvedValue(json(reply)); expect(await client.preferences({ expectedPreferencesRevision: 0, preferences })).toEqual(reply);
    fetcher.mockResolvedValue(json({ ...reply, preferences: { ...reply.preferences, preferences: { ...preferences, notes: "Other" } } }));
    await expect(client.preferences({ expectedPreferencesRevision: 0, preferences })).rejects.toMatchObject({ status: 502 });
  });
  it("posts only the frozen selection intent and validates all observed counters and exact system", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), system = fixtureSystem(), observed = identityObservation(overview);
    const input = { systemVersionId: system.id, expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: false };
    const selection = selectIdentitySystem({ actorId: fixtureOwner, projectId: fixtureProject, system, currentInput: system.input, previousSelection: null, identityRevision: 0, request: input, selectionId: fixtureId(700), now: fixtureAt });
    const reply = { session: { ownerId: fixtureOwner, projectId: fixtureProject, identityRevision: 1, currentSelectionId: selection.id, currentPreferencesRevision: 0, createdAt: fixtureAt, updatedAt: fixtureAt }, currentSelection: { selection, system, freshness: getIdentityFreshness(system.input.basis, { status: "available", basis: observed.basis }) } };
    fetcher.mockResolvedValue(json(reply)); expect(await client.select(input, observed, system)).toEqual(reply);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual(input);
    await expect(client.select({ ...input, expectedReferenceRevision: 2 }, observed, system)).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(json({ ...reply, currentSelection: { ...reply.currentSelection, system: { ...system, components: { ...system.components, logo: { ...system.components.logo, direction: "Wrong immutable version" } } } } }));
    await expect(client.select(input, observed, system)).rejects.toMatchObject({ status: 502 });
  });
  it("validates refinement against the exact fetched base and original observation", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), base = fixtureSystem(), observed = identityObservation(overview);
    const input: RefineIdentityComponent = { baseSystemVersionId: base.id, component: "colors", expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0,
      acceptEarlierBasis: false, input: { swatches: [{ key: "primary", name: "Berry", hex: "#AA2255" }], usageNotes: "Edited locally" }, idempotencyKey: "local-refinement-fixture" };
    const reply = fixtureRefinement(overview, base, input); fetcher.mockResolvedValue(json(reply));
    expect(await client.refine(input, observed, base)).toEqual(reply);
    const forged = structuredClone(reply); forged.system.components.logo.direction = "Unrequested replacement";
    fetcher.mockResolvedValue(json(forged)); await expect(client.refine(input, observed, base)).rejects.toMatchObject({ status: 502 });
  });
  it("accepts an exact old refinement replay without inventing a current head", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), base = fixtureSystem();
    const input: RefineIdentityComponent = { baseSystemVersionId: base.id, component: "typography", expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0,
      acceptEarlierBasis: false, input: { styles: [{ key: "body", role: "Body", family: "Edited Fixture Family", weight: 500, style: "normal" }], usageNotes: "Manual specification" }, idempotencyKey: "local-replay-fixture-1" };
    const reply = fixtureRefinement(overview, base, input); fetcher.mockResolvedValue(json(reply));
    const result = await client.refine(input, identityObservation(overview), base);
    expect(result?.selection.identityRevision).toBe(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch stale acknowledgments against unseen reference/preferences counters", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), base = fixtureSystem(), observed = identityObservation(overview);
    const input = { systemVersionId: base.id, expectedProjectRevision: 1, expectedReferenceRevision: 2, expectedPreferencesRevision: 0, expectedIdentityRevision: 0, acceptEarlierBasis: true };
    await expect(client.select(input, observed, base)).rejects.toThrow();
    await expect(client.select({ ...input, expectedReferenceRevision: 1, expectedPreferencesRevision: 1 }, observed, base)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("actual private Identity files", () => {
  it("creates a preview URL only after matching MIME and real SHA256 bytes, then revokes it", async () => {
    const { client, fetcher } = setup(), bytes = new Uint8Array([137, 80, 78, 71]);
    const digest = await crypto.subtle.digest("SHA-256", bytes), contentHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:local-fixture"), revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    fetcher.mockResolvedValue(new Response(bytes, { headers: { "Content-Type": "image/png" } }));
    const preview = await client.preview({ ...fixtureSystem().board.asset, contentHash });
    expect(preview?.url).toBe("blob:local-fixture"); expect(create).toHaveBeenCalledOnce();
    client.dispose(); expect(revoke).toHaveBeenCalledWith("blob:local-fixture");
  });
  it("rejects altered bytes and never treats SVG MIME as an inline preview", async () => {
    const { client, fetcher } = setup(); const create = vi.spyOn(URL, "createObjectURL");
    fetcher.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    await expect(client.preview(fixtureSystem().board.asset)).rejects.toMatchObject({ status: 502 });
    await expect(client.preview(fixtureSystem().productionFiles[0]!.asset)).rejects.toMatchObject({ status: 422 });
    expect(create).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("binds download replies to the exact version/hash/MIME and safe transient URL", async () => {
    const { client, fetcher } = setup(), asset = fixtureSystem().productionFiles[0]!.asset;
    const reply = { url: "https://storage.example.test/private-local-fixture", versionId: asset.versionId, contentHash: asset.contentHash, mimeType: asset.mimeType, expiresInSeconds: 60 };
    fetcher.mockResolvedValue(json(reply)); expect(await client.download(asset)).toEqual(reply);
    fetcher.mockResolvedValue(json({ ...reply, versionId: fixtureId(999) })); await expect(client.download(asset)).rejects.toMatchObject({ status: 502 });
    fetcher.mockResolvedValue(json({ ...reply, url: "https://user:password@storage.example.test/file" })); await expect(client.download(asset)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects a foreign-project file before any transport call", async () => {
    const { client, fetcher } = setup();
    expect(await client.preview({ ...fixtureSystem().board.asset, projectId: fixtureId(999) })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds preview concurrency and cancels queued work when disposed", async () => {
    const { client, fetcher } = setup();
    fetcher.mockImplementation((_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = Array.from({ length: 5 }, () => client.preview(fixtureSystem().board.asset));
    await Promise.resolve(); await Promise.resolve(); expect(fetcher).toHaveBeenCalledTimes(3);
    client.dispose(); expect(await Promise.all(pending)).toEqual([null, null, null, null, null]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("checks the account again after hashing before creating an object URL", async () => {
    const { client, fetcher, loseScope } = setup(); let finish!: (value: ArrayBuffer) => void;
    vi.spyOn(crypto.subtle, "digest").mockImplementation(() => new Promise<ArrayBuffer>(resolve => { finish = resolve; }));
    const create = vi.spyOn(URL, "createObjectURL");
    fetcher.mockResolvedValue(new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "image/png" } }));
    const pending = client.preview(fixtureSystem().board.asset);
    await vi.waitFor(() => expect(finish).toBeDefined()); loseScope(); finish(new Uint8Array(32).buffer);
    expect(await pending).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
});


describe("Identity interruption and receipt edges", () => {
  it.each(["selection", "preferences", "refinement"] as const)("bounds a stalled %s acknowledgement without replaying the mutation", async kind => {
    vi.useFakeTimers();
    const { client, fetcher, expire } = setup(), overview = fixtureOverview(), system = fixtureSystem(), observation = identityObservation(overview);
    let finish!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>(resolve => { finish = resolve; }));
    const revisions = { expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0 };
    const pending = kind === "selection" ? client.select({ ...revisions, systemVersionId: system.id, acceptEarlierBasis: false }, observation, system)
      : kind === "preferences" ? client.preferences({ expectedPreferencesRevision: 0, preferences: system.input.preferences })
        : client.refine({ ...revisions, baseSystemVersionId: system.id, component: "colors", acceptEarlierBasis: false,
          input: { swatches: [{ key: "primary", name: "Berry", hex: "#AA2255" }], usageNotes: "Manual" }, idempotencyKey: "local-timeout-refinement" }, observation, system);
    const rejected = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(IDENTITY_REQUEST_TIMEOUT_MS);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(client.current()).toBe(true); expect(expire).not.toHaveBeenCalled();
    finish(json({ error: "Late response" }, 401)); await Promise.resolve(); await Promise.resolve();
    expect(client.current()).toBe(true); expect(expire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds an unfinished mutation body and releases its stream", async () => {
    vi.useFakeTimers();
    const { client, fetcher } = setup(), cancel = vi.fn();
    fetcher.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "Content-Type": "application/json" } }));
    const pending = client.preferences({ expectedPreferencesRevision: 0, preferences: fixtureSystem().input.preferences });
    const rejected = expect(pending).rejects.toMatchObject({ status: 408 });
    await vi.advanceTimersByTimeAsync(IDENTITY_REQUEST_TIMEOUT_MS); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("settles a disposed mutation even if its transport ignores cancellation", async () => {
    vi.useFakeTimers();
    const { client, fetcher } = setup(); fetcher.mockReturnValue(new Promise<Response>(() => {}));
    const pending = client.preferences({ expectedPreferencesRevision: 0, preferences: fixtureSystem().input.preferences });
    client.dispose();
    expect(await pending).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  });
  it("checks every independent refinement counter and predecessor in the actual receipt", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), base = fixtureSystem(), observation = identityObservation(overview);
    const input: RefineIdentityComponent = { baseSystemVersionId: base.id, component: "colors", expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0,
      acceptEarlierBasis: false, input: { swatches: [{ key: "primary", name: "Berry", hex: "#AA2255" }], usageNotes: "Manual" }, idempotencyKey: "local-four-head-fixture" };
    const reply = fixtureRefinement(overview, base, input);
    for (const key of ["projectRevision", "referenceRevision", "preferencesRevision", "identityRevision"] as const) {
      const corrupt = structuredClone(reply); corrupt.selection[key] += 1; fetcher.mockResolvedValue(json(corrupt));
      await expect(client.refine(input, observation, base)).rejects.toMatchObject({ status: 502 });
    }
    const corrupt = structuredClone(reply); corrupt.selection.previousSelectionId = fixtureId(991); fetcher.mockResolvedValue(json(corrupt));
    await expect(client.refine(input, observation, base)).rejects.toMatchObject({ status: 502 });
  });
  it("rejects mismatched before data even when the after data matches the submitted edit", async () => {
    const { client, fetcher } = setup(), overview = fixtureOverview(), base = fixtureSystem();
    const input: RefineIdentityComponent = { baseSystemVersionId: base.id, component: "colors", expectedProjectRevision: 1, expectedReferenceRevision: 1, expectedPreferencesRevision: 0, expectedIdentityRevision: 0,
      acceptEarlierBasis: false, input: { swatches: [{ key: "primary", name: "Berry", hex: "#AA2255" }], usageNotes: "Manual" }, idempotencyKey: "local-before-data-fixture" };
    const reply = structuredClone(fixtureRefinement(overview, base, input)); reply.change.before.usageNotes = "Invented prior value";
    fetcher.mockResolvedValue(json(reply)); await expect(client.refine(input, identityObservation(overview), base)).rejects.toMatchObject({ status: 502 });
  });
  it("allows a maximally escaped valid preference mutation without truncating its notes", async () => {
    const { client, fetcher } = setup(), preferences = { ...fixtureInput().preferences, notes: "\u0000".repeat(2000), avoidanceNotes: "\u0001".repeat(2000) };
    fetcher.mockResolvedValue(json({ session: { ownerId: fixtureOwner, projectId: fixtureProject, identityRevision: 0, currentSelectionId: null, currentPreferencesRevision: 1, createdAt: fixtureAt, updatedAt: fixtureAt },
      preferences: { ownerId: fixtureOwner, projectId: fixtureProject, revision: 1, preferences, createdAt: fixtureAt } }));
    expect((await client.preferences({ expectedPreferencesRevision: 0, preferences }))?.preferences.preferences).toEqual(preferences);
    const body = String(fetcher.mock.calls[0]![1]?.body); expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(24000); expect(JSON.parse(body).preferences).toEqual(preferences);
  });
  it("never exposes delayed signed download URLs after a session transition", async () => {
    const { client, fetcher, loseScope } = setup(), asset = fixtureSystem().productionFiles[0]!.asset; let resolve!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>(done => { resolve = done; })); const pending = client.download(asset); loseScope();
    resolve(json({ url: "https://storage.example.test/private-local-fixture", versionId: asset.versionId, contentHash: asset.contentHash, mimeType: asset.mimeType, expiresInSeconds: 60 })); expect(await pending).toBeNull();
  });
  it("enforces actual streamed private file byte limits before hashing or exposing a URL", async () => {
    const { client, fetcher } = setup(), create = vi.spyOn(URL, "createObjectURL"), digest = vi.spyOn(crypto.subtle, "digest");
    const chunk = new Uint8Array(1024 * 1024);
    fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 51; i++) controller.enqueue(chunk); controller.close(); } }), { headers: { "Content-Type": "image/png" } }));
    await expect(client.preview(fixtureSystem().board.asset)).rejects.toMatchObject({ status: 502 }); expect(digest).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
});

it("defaults absent save availability to unavailable when reading legacy overview data", async () => {
  const { client, fetcher } = setup(), overview = fixtureOverview(); const legacy = { ...overview } as Partial<typeof overview>; delete legacy.saveAvailability;
  fetcher.mockResolvedValue(json(legacy)); expect((await client.overview())?.saveAvailability).toEqual({ status: "unavailable", reason: "trusted_transaction_unavailable" });
});
