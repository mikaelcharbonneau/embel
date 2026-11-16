import { createHash } from "node:crypto";
import sharp from "sharp";
import { expectProjectCanvas } from "./project-canvas-contract";
import { contextSnapshotSchema } from "../../src/domain/projects";
import { initializeGuidedInterview } from "../../src/domain/guided-interview";
import { DEFAULT_PROFILE_VALUES } from "../../src/domain/account-profile";
import { captureUiEvidence } from "./ui-evidence";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  syntheticLogoBatch,
  syntheticLogoWorkspace,
  syntheticResolvedLogoConcept,
  logoFixtureId as id,
} from "../fixtures/logo-creation";
import type { GenerationRun } from "../../src/domain/generations";
import type { LogoConceptBatch } from "../../src/domain/logo-jobs";
import type { LogoBriefDraft, LogoRasterSource, LogoWorkspaceV2 } from "../../src/domain/logo-workspace";
import { DEFAULT_LOGO_CONCEPT_TYPES } from "../../src/domain/logo-saved-inputs";
import { reviewedStrategy } from "../fixtures/reviewed-strategy";

// The Logo step of the brand conversation on the generation engine: /logo/engine says whether drawing is on
// and lists the runs, and one POST to /generations starts a run. Every /api call is answered here; nothing
// reaches a provider, a database or storage.
const source = syntheticResolvedLogoConcept(),
  projectId = source.input.projectId,
  url = `/brands/account/${projectId}?view=strategy#journey-logo`,
  base = `/api/projects/${projectId}/logo`;
type Scenario =
  | "empty"
  | "partial"
  | "drawing"
  | "uninitialized"
  | "save_uncertain"
  | "missing_name"
  | "inputs_failed"
  | "save_unavailable"
  | "engine_off";
type EngineStart = { kind: string; idempotencyKey: string; input: Record<string, unknown> };

/** A project whose Strategy and Voice are finished, so the conversation opens Identity. */
function finishedVoiceContext() {
  const started = initializeGuidedInterview(
      reviewedStrategy({ description: "Synthetic logo fixture. No live generation.", activity: "Tea shop" }),
    ),
    interview = started.intake.guidedInterview!;
  return contextSnapshotSchema.parse({
    ...started,
    selectedName: "Élan & Co",
    intake: {
      ...started.intake,
      guidedInterview: {
        ...interview,
        stage: "complete",
        turns: [
          ...interview.turns,
          { id: "slogan-turn", userMessageId: null, stage: "slogan", purpose: "propose", inputRevision: 1 },
        ],
      },
    },
  });
}

async function setup(page: Page, scenario: Scenario = "empty", savedSelection: LogoRasterSource | null = null) {
  const noBrief = ["uninitialized", "save_uncertain", "missing_name", "save_unavailable"].includes(scenario);
  // The app verifies every preview's bytes against its receipt, so the six concepts share one real picture.
  const png = await sharp({ create: { width: 32, height: 32, channels: 4, background: "#444444" } })
      .png()
      .toBuffer(),
    contentHash = createHash("sha256").update(png).digest("hex");
  const batch = structuredClone(
    syntheticLogoBatch(
      scenario === "uninitialized"
        ? Array.from({ length: 6 }, () => "succeeded" as const)
        : scenario === "drawing"
          ? Array.from({ length: 6 }, () => "running" as const)
          : undefined,
    ),
  );
  for (const slot of batch.slots)
    for (const preview of [slot.acceptedPreview, ...slot.attempts.map((attempt) => attempt.preview)]) {
      if (!preview) continue;
      preview.reference.contentHash = contentHash;
      preview.verification.contentHash = contentHash;
      preview.verification.byteLength = png.length;
    }
  let currentBrief = source.brief;
  let selectedConcept: LogoRasterSource | null = savedSelection;
  const foundation = syntheticLogoWorkspace();
  const batches = new Map<string, LogoConceptBatch>(scenario === "partial" ? [[batch.id, batch]] : []);
  // A round that is still working when the page opens: it has opened its set and drawn nothing yet.
  const drawingRun: GenerationRun = {
    id: id(700),
    kind: "logo.concepts",
    status: "running",
    credits: 6,
    errorCode: null,
    cancelRequested: false,
    createdAt: batch.createdAt,
    finishedAt: null,
    inputRevision: null,
    outputs: [{ key: "batch", output: { batchId: batch.id } }],
  };
  if (scenario === "drawing") batches.set(batch.id, { ...batch, requestKey: drawingRun.id });
  const saved: LogoWorkspaceV2 = {
    ...foundation,
    heads: {
      ...foundation.heads,
      workspaceRevision: noBrief ? 0 : 1,
      stageRevisions: {
        ...foundation.heads.stageRevisions,
        brief_references: noBrief ? 0 : 1,
        concepts: scenario === "partial" ? 1 : 0,
      },
    },
    stages: {
      ...foundation.stages,
      brief_references: noBrief ? null : { id: source.brief.id, revision: 1, stage: "brief_references" },
      concepts: scenario === "partial" ? { id: id(901), revision: 1, stage: "concepts" } : null,
    },
    capabilities: {
      ...foundation.capabilities,
      save:
        scenario === "save_unavailable"
          ? { status: "unavailable", reason: "Synthetic saving outage" }
          : { status: "available" },
      generate: { status: "available" },
    },
  };
  const preparedBrief: LogoBriefDraft = {
    name: source.brief.payload.name,
    activity: source.brief.payload.activity,
    audience: source.brief.payload.audience,
    personality: "Saved inspiration · catalog 2026-10-13.1 · selection 2: synthetic lettering guidance.",
    logoTypes: [...DEFAULT_LOGO_CONCEPT_TYPES],
  };
  const state = {
    owner: foundation.ownerId,
    /** Every start sent to the generation engine. */
    starts: [] as EngineStart[],
    runs: scenario === "drawing" ? [drawingRun] : ([] as GenerationRun[]),
    selections: [] as { requestKey: string; batchId: string; slotId: string; attemptId: string }[],
    inputReads: 0,
    saves: [] as { requestKey: string; brief: LogoBriefDraft }[],
    order: [] as string[],
    failInputReads: scenario === "inputs_failed",
    unhandledWrites: [] as string[],
    restoreSaving() {
      saved.capabilities.save = { status: "available" };
    },
    /** The engine finishes every run that is still working; the page learns it on its next check. */
    finishRuns() {
      state.runs = state.runs.map((run) =>
        run.status === "running" ? { ...run, status: "succeeded", finishedAt: new Date().toISOString() } : run,
      );
    },
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  await page.route("**/*", async (route) => {
    const target = new URL(route.request().url());
    if (target.hostname !== "127.0.0.1") return route.abort("blockedbyclient");
    if (!target.pathname.startsWith("/api/")) return route.continue();
    const path = target.pathname,
      request = route.request(),
      method = request.method();
    if (path === "/api/session") return json(route, { user: { id: state.owner } });
    if (path === "/api/account/profile")
      return json(route, {
        profile: {
          ownerId: foundation.ownerId,
          email: "fixture@example.invalid",
          revision: 0,
          updatedAt: null,
          values: DEFAULT_PROFILE_VALUES,
        },
      });
    if (path === "/api/credits")
      return json(route, { credits: { planId: "free", balance: 30, periodEnd: "2026-12-01T00:00:00Z" } });
    if (path === `/api/projects/${projectId}`)
      return json(route, {
        project: {
          id: projectId,
          owner_id: foundation.ownerId,
          title: "Élan & Co · local fixture",
          scope: "complete_brand",
          current_revision: 1,
          created_at: "2026-10-18T00:00:00Z",
          context: finishedVoiceContext(),
        },
      });
    // Strategy is finished and nothing of it runs: the conversation only needs to know its history was read.
    if (path === `/api/projects/${projectId}/strategy`)
      return json(route, {
        availability: { status: "unavailable", operations: [], reason: "worker_unavailable" },
        jobs: [],
      });
    if (path === `/api/projects/${projectId}/generations` && method === "GET") return json(route, { runs: [] });
    if (path === `/api/projects/${projectId}/generations` && method === "POST") {
      const body = request.postDataJSON() as EngineStart;
      state.starts.push(body);
      const run: GenerationRun = {
        id: id(700 + state.starts.length),
        kind: body.kind,
        status: "running",
        credits: body.kind === "logo.concepts" ? 6 : 1,
        errorCode: null,
        cancelRequested: false,
        createdAt: new Date().toISOString(),
        finishedAt: null,
        inputRevision: null,
        outputs: [],
      };
      // A first round opens its own set of concepts; a retry draws into the set it retries.
      if (body.kind === "logo.concepts") {
        if (body.input.operation !== "retry_failed")
          batches.set(batch.id, {
            ...batch,
            requestKey: run.id,
            createdAt: run.createdAt,
            slots: batch.slots.map((slot) => ({
              ...slot,
              attempts: slot.attempts.map((attempt) => ({ ...attempt, requestKey: run.id })),
            })),
          });
        run.outputs = [{ key: "batch", output: { batchId: batch.id } }];
      }
      state.runs.unshift(run);
      return json(route, { run });
    }
    if (path === `${base}/engine`) return json(route, { engine: scenario !== "engine_off", runs: state.runs });
    if (path === base) return json(route, saved);
    if (path === `${base}/saved-inputs`) {
      state.inputReads++;
      state.order.push("inputs");
      if (state.failInputReads) return json(route, {}, 503);
      return json(route, {
        ownerId: foundation.ownerId,
        projectId,
        projectRevision: 1,
        inspirationSelectionRevision: 2,
        inspirationCount: 2,
        references: [],
        uploadNotes: [],
        nameConflict: false,
        draft:
          scenario === "missing_name"
            ? null
            : noBrief
              ? preparedBrief
              : {
                  name: currentBrief.payload.name,
                  activity: currentBrief.payload.activity,
                  audience: currentBrief.payload.audience,
                  personality: currentBrief.payload.personality,
                  logoTypes: currentBrief.payload.logoTypes,
                },
      });
    }
    if ((path === `${base}/initialize` || path === `${base}/brief`) && method !== "GET") {
      const body = request.postDataJSON() as { requestKey: string; brief: LogoBriefDraft };
      state.saves.push(body);
      state.order.push("save");
      const revision = saved.heads.stageRevisions.brief_references + 1;
      currentBrief = {
        ...source.brief,
        revision,
        parentRevisionId: revision === 1 ? null : currentBrief.id,
        payload: { ...source.brief.payload, ...body.brief },
      };
      saved.heads = {
        ...saved.heads,
        workspaceRevision: saved.heads.workspaceRevision + 1,
        stageRevisions: { ...saved.heads.stageRevisions, brief_references: revision },
      };
      saved.stages.brief_references = { stage: "brief_references", id: currentBrief.id, revision };
      if (scenario === "save_uncertain") return route.abort("failed");
      return json(route, {
        ownerId: foundation.ownerId,
        projectId,
        requestKey: body.requestKey,
        workspace: saved,
        revision: currentBrief,
      });
    }
    if (path === `${base}/stages/brief_references/revisions/${currentBrief.id}`) return json(route, currentBrief);
    if (path === `${base}/reference-snapshots/${source.referenceSnapshot.id}`)
      return json(route, source.referenceSnapshot);
    const concepts = () => ({
      ...source.brief,
      createdAt: new Date().toISOString(),
      id: saved.stages.concepts?.id ?? id(901),
      revision: saved.heads.stageRevisions.concepts,
      parentRevisionId: saved.heads.stageRevisions.concepts > 1 ? id(899 + saved.heads.stageRevisions.concepts) : null,
      stage: "concepts",
      payload: { batchIds: [batch.id], selected: selectedConcept },
    });
    if (path === `${base}/concepts/selection` && method === "POST") {
      const body = request.postDataJSON() as { requestKey: string; batchId: string; slotId: string; attemptId: string };
      state.selections.push(body);
      selectedConcept = { kind: "concept", batchId: body.batchId, slotId: body.slotId, attemptId: body.attemptId };
      const revision = saved.heads.stageRevisions.concepts + 1;
      saved.heads = {
        ...saved.heads,
        workspaceRevision: saved.heads.workspaceRevision + 1,
        stageRevisions: { ...saved.heads.stageRevisions, concepts: revision },
      };
      saved.stages.concepts = { stage: "concepts", id: id(900 + revision), revision };
      return json(route, {
        ownerId: saved.ownerId,
        projectId: saved.projectId,
        requestKey: body.requestKey,
        workspace: saved,
        revision: concepts(),
      });
    }
    if (saved.stages.concepts && path === `${base}/stages/concepts/revisions/${saved.stages.concepts.id}`)
      return json(route, concepts());
    if (path === `${base}/batches`)
      return json(route, {
        ownerId: foundation.ownerId,
        projectId,
        items: [...batches.values()].map((item) => ({
          id: item.id,
          requestKey: item.requestKey,
          createdAt: item.createdAt,
        })),
        nextCursor: null,
      });
    if (path.startsWith(`${base}/batches/`)) {
      const found = batches.get(path.split("/").at(-1)!);
      return json(route, found ?? {}, found ? 200 : 404);
    }
    if (path === `${base}/raster-refinements`)
      return json(route, { ownerId: foundation.ownerId, projectId, items: [], nextCursor: null });
    if (/^\/api\/assets\/[^/]+\/preview$/u.test(path))
      return route.fulfill({ status: 200, contentType: "image/png", body: png });
    if (!["GET", "HEAD"].includes(method)) state.unhandledWrites.push(`${method} ${path}`);
    return json(route, {}, 404);
  });
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Logo", exact: true })).toBeAttached();
  return state;
}

/** Send in the conversation's reply box: its name says what it does at this step. */
const send = (page: Page, name: string) =>
  page.getByRole("form", { name: "Reply" }).getByRole("button", { name, exact: true });

test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));

test("the Logo step asks which logo types to draw and Send starts six concepts once, with no cost shown", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const f = await setup(page);
  const conversation = page.getByRole("region", { name: "Brand conversation" }),
    draw = send(page, "Draw six concepts");
  // Embel says what it will draw; the work area asks for the logo types and shows no invented results.
  await expect(conversation.getByRole("article", { name: "Embel response" }).last()).toContainText(
    "I’ll draw six concepts for Élan & Co",
  );
  await expect(page.getByRole("group", { name: "Which logo types should I explore?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Concept \d/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Explore six concepts", exact: true })).toHaveCount(0);
  await expect(draw).toBeEnabled();
  await expect(conversation).not.toContainText(/cost|estimat|\$/iu);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectProjectCanvas(page);
  expect(f.starts).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("generation-ready.png") });
  await draw.click();
  await expect.poll(() => f.starts.length).toBe(1);
  expect(f.starts[0]).toMatchObject({
    kind: "logo.concepts",
    input: { operation: "concepts", briefRevisionId: source.brief.id },
  });
  expect(JSON.stringify(f.starts[0])).not.toMatch(/cost|microusd|quote/iu);
  // While the run works the reply box offers Stop, so a second request cannot be sent.
  await expect(page.getByRole("button", { name: "Stop drawing", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(conversation).not.toContainText(/cost|estimat|\$/iu);
  expect(f.starts).toHaveLength(1);
  expect(f.saves).toHaveLength(0);
  expect(f.unhandledWrites).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("Enter on Send starts one request", async ({ page }) => {
  const f = await setup(page),
    draw = send(page, "Draw six concepts");
  await expect(draw).toBeEnabled();
  await draw.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => f.starts.length).toBe(1);
  await expect(page.getByRole("button", { name: "Stop drawing", exact: true })).toBeVisible();
  expect(f.starts).toHaveLength(1);
});

test("new logo work saves the prepared brief before one deliberate request, and its concepts survive a reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const f = await setup(page, "uninitialized");
  const draw = send(page, "Draw six concepts");
  await expect(draw).toBeEnabled();
  expect(f.order).toEqual(["inputs", "save"]);
  expect(f.saves).toHaveLength(1);
  expect(f.saves[0]!.brief).toMatchObject({
    name: "Élan & Co",
    activity: "Tea shop",
    audience: "Local readers",
    logoTypes: DEFAULT_LOGO_CONCEPT_TYPES,
  });
  expect(f.saves[0]!.brief.personality).toContain("selection 2");
  expect(f.starts).toHaveLength(0);
  await draw.click();
  await expect.poll(() => f.starts.length).toBe(1);
  expect(f.starts[0]).toMatchObject({ kind: "logo.concepts", input: { operation: "concepts" } });
  f.finishRuns();
  await page.reload();
  // No concept is chosen and the Logo stage has no saved revision: the set is found through its own history.
  await expect(page.getByRole("heading", { name: "Choose the concept you like most", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Concept [1-6]$/u })).toHaveCount(6);
  expect(f.saves).toHaveLength(1);
  expect(f.starts).toHaveLength(1);
  expect(f.unhandledWrites).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("failed saved-input loading can be refreshed in place without starting generation", async ({ page }) => {
  const f = await setup(page, "inputs_failed"),
    draw = send(page, "Draw six concepts"),
    refresh = page.getByRole("button", { name: "Refresh logo inputs", exact: true });
  await expect(refresh).toBeVisible();
  await expect(draw).toBeDisabled();
  expect(f.starts).toHaveLength(0);
  f.failInputReads = false;
  await refresh.click();
  await expect(draw).toBeEnabled();
  await expect(refresh).toHaveCount(0);
  expect(f.inputReads).toBeGreaterThan(1);
  expect(f.starts).toHaveLength(0);
  await draw.click();
  await expect.poll(() => f.starts.length).toBe(1);
});

test("restored saving refreshes the prepared inputs and enables a deliberate Send", async ({ page }) => {
  const f = await setup(page, "save_unavailable"),
    draw = send(page, "Draw six concepts");
  await expect(page.getByText(/Logo saving is unavailable/u)).toBeVisible();
  await expect(draw).toBeDisabled();
  expect(f.saves).toHaveLength(0);
  expect(f.starts).toHaveLength(0);
  f.restoreSaving();
  await page.getByRole("button", { name: "Refresh logo inputs", exact: true }).click();
  await expect(draw).toBeEnabled();
  expect(f.saves).toHaveLength(1);
  expect(f.starts).toHaveLength(0);
});

test("an unconfirmed first brief save is kept for checking and nothing can be drawn", async ({ page }) => {
  const f = await setup(page, "save_uncertain");
  await expect.poll(() => f.saves.length).toBe(1);
  await expect(page.getByText("We couldn’t confirm your logo brief was saved.", { exact: false })).toBeVisible();
  // Save recovery is shown in the Logo step itself.
  await expect(page.getByRole("button", { name: "Check original save", exact: true })).toBeVisible();
  await expect(send(page, "Draw six concepts")).toBeDisabled();
  expect(f.saves).toHaveLength(1);
  expect(f.starts).toHaveLength(0);
});

test("a project without a saved brand name is guided back before any logo write", async ({ page }) => {
  const f = await setup(page, "missing_name");
  await expect(
    page.getByText("Choose and save a brand name in your project before generating logo concepts.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open project to choose a name" })).toHaveAttribute(
    "href",
    `/brands/account/${projectId}?view=strategy`,
  );
  await expect(send(page, "Draw six concepts")).toBeDisabled();
  expect(f.inputReads).toBe(1);
  expect(f.saves).toHaveLength(0);
  expect(f.starts).toHaveLength(0);
});

test("while Logo drawing is switched off Send stays off and nothing starts", async ({ page }) => {
  const f = await setup(page, "engine_off"),
    draw = send(page, "Draw six concepts");
  // The saved logo types stay on screen; only drawing is held.
  await expect(page.getByRole("group", { name: "Which logo types should I explore?" })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Wordmark", exact: true })).toBeChecked();
  await expect(draw).toBeDisabled();
  await draw.click({ force: true });
  await page.getByRole("textbox", { name: "Message Embel" }).press("Enter");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(f.starts).toHaveLength(0);
  expect(f.unhandledWrites).toEqual([]);
});

test("a set with one failed concept keeps five to choose and retries only the failed one", async ({ page }) => {
  const f = await setup(page, "partial");
  await expect(page.getByText("5 of 6 concepts ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Concept [1-5]$/u })).toHaveCount(5);
  const retry = page.getByRole("button", { name: "Retry 1 failed concept", exact: true });
  await expect(retry).toBeEnabled();
  expect(f.starts).toHaveLength(0);
  await retry.click();
  await expect.poll(() => f.starts.length).toBe(1);
  expect(f.starts[0]).toMatchObject({
    kind: "logo.concepts",
    input: { operation: "retry_failed", sourceBatchId: id(60), failedSlotIds: [id(115)] },
  });
  await expect(page.getByRole("button", { name: /^Concept [1-5]$/u })).toHaveCount(5);
  expect(f.starts).toHaveLength(1);
});

test("clicking a concept chooses it in place and the choice is still there after a reload", async ({ page }) => {
  const f = await setup(page, "partial");
  const first = page.getByRole("button", { name: "Concept 1", exact: true }),
    second = page.getByRole("button", { name: "Concept 2", exact: true });
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Your logo", exact: true })).toBeVisible();
  // The chosen concept goes into the reply box, where Send continues to Creative direction.
  await expect(page.getByRole("list", { name: "In your reply" })).toContainText("Logo: Concept 1");
  await expect(send(page, "Continue to Creative direction")).toBeEnabled();
  expect(f.selections).toHaveLength(1);
  expect(f.selections[0]).toMatchObject({ batchId: id(60), slotId: id(110), attemptId: id(120) });
  expect(f.starts).toHaveLength(0);
  await page.reload();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await second.focus();
  await page.keyboard.press("Enter");
  await expect(second).toHaveAttribute("aria-pressed", "true");
  await expect(first).toHaveAttribute("aria-pressed", "false");
  expect(f.selections).toHaveLength(2);
  expect(f.starts).toHaveLength(0);
});

test("a message in the reply box changes the chosen concept with one request", async ({ page }) => {
  const batch = syntheticLogoBatch(),
    slot = batch.slots[1]!;
  const chosen: LogoRasterSource = {
    kind: "concept",
    batchId: batch.id,
    slotId: slot.id,
    attemptId: slot.attempts[0]!.id,
  };
  const f = await setup(page, "partial", chosen);
  await expect(page.getByRole("list", { name: "In your reply" })).toContainText("Logo: Concept 2");
  const message = page.getByRole("textbox", { name: "Message Embel" });
  await message.fill("Make the monogram more rounded and increase the inner spacing.");
  await send(page, "Send prompt").click();
  await expect.poll(() => f.starts.length).toBe(1);
  expect(f.starts[0]).toMatchObject({
    kind: "logo.refine",
    input: { source: chosen, instruction: "Make the monogram more rounded and increase the inner spacing." },
  });
  await expect(page.getByRole("button", { name: "Stop changing the logo", exact: true })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(f.selections).toHaveLength(0);
  expect(f.starts).toHaveLength(1);
});

test("six concepts being drawn show the drawing frame, with reduced motion too", async ({ page }, info) => {
  const f = await setup(page, "drawing");
  // Each concept being made is a drawing frame named after its concept; no shader runs.
  const frames = page.getByRole("img", { name: /^Concept [1-6] is being drawn$/u });
  await expect(frames).toHaveCount(6);
  expect(await frames.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")))).toEqual(
    [1, 2, 3, 4, 5, 6].map((n) => `Concept ${n} is being drawn`),
  );
  await expect(page.getByRole("heading", { name: "Drawing your concepts", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Concept \d/u })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Stop drawing", exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("logo-drawing-loading.png"), fullPage: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".e-media--drawing canvas")).toHaveCount(0);
  await expect(page.locator(".e-media--drawing")).toHaveCount(6);
  expect(f.starts).toHaveLength(0);
});
