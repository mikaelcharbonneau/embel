import { expect, test, type Page } from "@playwright/test";
import { setupVectorProposalUi } from "../fixtures/logo-vector-proposal-ui";
import { captureUiEvidence } from "./ui-evidence";
import { checkNormalAccount } from "./account-check";

function panel(page: Page) { return page.getByRole("region", { name: "AI vector edit suggestions", exact: true }); }
async function review(page: Page) {
  const target = panel(page); await expect(target.getByRole("textbox", { name: "Requested vector change", exact: true })).toBeEnabled();
  await target.getByRole("textbox", { name: "Requested vector change", exact: true }).fill("Use a muted blue on the selected symbol.");
  await expect(target.getByRole("button", { name: "Review AI suggestion request", exact: true })).toBeEnabled();
  await target.getByRole("button", { name: "Review AI suggestion request", exact: true }).click();
  await expect(target.getByRole("region", { name: "Review AI suggestion request", exact: true })).toContainText("Use a muted blue on the selected symbol.");
}
async function start(page: Page) { await review(page); await panel(page).getByRole("button", { name: "Request AI suggestion", exact: true }).click(); }

test("vector proposal fixture: explicit uncapped request and candidate application keep approval separate", async ({ page }) => {
  const f = await setupVectorProposalUi(page), target = panel(page);
  await expect(page.getByRole("heading", { name: "Approved logo", exact: true })).toBeVisible(); expect(f.admissions).toHaveLength(0);
  await review(page); expect(f.admissions).toHaveLength(0); expect(f.applications).toHaveLength(0);
  await target.getByRole("button", { name: "Request AI suggestion", exact: true }).click(); await expect.poll(() => f.admissions.length).toBe(1);
  expect(f.admissions[0]).not.toHaveProperty("acceptedMaxCostMicrousd"); expect(f.base.workspace.approvedLogo).toEqual(f.originalApproval);
  const key = f.admissions[0]!.requestKey; f.finish(key);
  await target.getByRole("button", { name: "Check original suggestion request", exact: true }).click();
  await expect(target.getByRole("region", { name: "Saved AI vector suggestion", exact: true })).toContainText("Synthetic suggestion: use #334455");
  await expect(target.getByRole("button", { name: "Apply as vector candidate", exact: true })).toBeEnabled(); expect(f.applications).toHaveLength(0);
  await target.getByRole("button", { name: "Apply as vector candidate", exact: true }).click(); await expect.poll(() => f.applications.length).toBe(1);
  await expect(page.getByRole("heading", { name: "Review required", exact: true })).toBeVisible(); expect(f.base.workspace.approvedLogo).toEqual(f.originalApproval);
  await expect(page.getByRole("button", { name: "Accept this vector", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Accept this vector", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Approved logo", exact: true })).toBeVisible(); expect(f.base.workspace.approvedLogo?.vectorRevisionId).not.toBe(f.originalApproval.vectorRevisionId);
  expect(f.admissions).toHaveLength(1); expect(f.applications).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("vector proposal fixture: lost admission acknowledgment and full reload recover the actual pending request", async ({ page }) => {
  const f = await setupVectorProposalUi(page); f.loseAdmissionAck = true; await start(page);
  await expect(panel(page)).toContainText("Original AI request retained"); expect(f.admissions).toHaveLength(1);
  const original = structuredClone(f.admissions[0]!); await page.reload();
  await expect(panel(page).getByRole("region", { name: "Pending vector suggestions", exact: true })).toBeVisible();
  await expect(panel(page).getByRole("button", { name: "Review AI suggestion request", exact: true })).toBeDisabled();
  await panel(page).getByRole("button", { name: "Check saved request", exact: true }).click();
  expect(f.admissions).toHaveLength(1); expect(f.lookups.at(-1)).toEqual(original);
  await panel(page).getByRole("button", { name: "Stop further work", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "Stop requested", exact: true })).toBeDisabled();
  await expect(panel(page)).toContainText("Provider outcomes and charges remain unresolved"); expect(f.closures[0]).toEqual(original); expect(f.admissions).toHaveLength(1);
});

test("vector proposal fixture: a missing original remains retained until exact server closure", async ({ page }) => {
  const f = await setupVectorProposalUi(page, { legacy: true }); f.refuseAdmission = true; await review(page);
  await expect(panel(page).getByRole("region", { name: "Review AI suggestion request", exact: true })).toContainText("Accepted maximum");
  await panel(page).getByRole("button", { name: "Request AI suggestion", exact: true }).click(); await expect(panel(page)).toContainText("Original AI request retained");
  const original = f.admissions[0]!; expect(original).toHaveProperty("acceptedMaxCostMicrousd", 122880);
  await panel(page).getByRole("button", { name: "Check original suggestion request", exact: true }).click(); await expect(panel(page)).toContainText("Original AI request retained");
  expect(f.admissions).toHaveLength(1); await panel(page).getByRole("button", { name: "Stop original suggestion request", exact: true }).click();
  await expect(panel(page)).toContainText("closed before admission"); expect(f.closures).toEqual([original]); expect(f.base.workspace.approvedLogo).toEqual(f.originalApproval);
});

test("vector proposal fixture: lost zero-AI application acknowledgment reads the original receipt without regeneration", async ({ page }) => {
  const f = await setupVectorProposalUi(page); await start(page); await expect.poll(() => f.admissions.length).toBe(1); f.finish(f.admissions[0]!.requestKey);
  await panel(page).getByRole("button", { name: "Check original suggestion request", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "Apply as vector candidate", exact: true })).toBeEnabled(); f.loseApplyAck = true;
  await panel(page).getByRole("button", { name: "Apply as vector candidate", exact: true }).click();
  await expect(panel(page)).toContainText("Original candidate application retained");
  const original = structuredClone(f.applications[0]!);
  await checkNormalAccount(page); await expect(panel(page)).toContainText("Original candidate application retained");
  await panel(page).getByRole("button", { name: "Check original candidate application", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review required", exact: true })).toBeVisible(); await expect(page.getByRole("button", { name: "Accept this vector", exact: true })).toBeEnabled();
  expect(f.applications).toEqual([original]); expect(f.admissions).toHaveLength(1); expect(f.base.workspace.approvedLogo).toEqual(f.originalApproval);
});

test("vector proposal fixture: unsupported results remain reviewable and owner switches hide private proposals", async ({ page }) => {
  const f = await setupVectorProposalUi(page); f.unsupported = true; await start(page); await expect.poll(() => f.admissions.length).toBe(1); f.finish(f.admissions[0]!.requestKey);
  await panel(page).getByRole("button", { name: "Check original suggestion request", exact: true }).click();
  await expect(panel(page)).toContainText("This request did not produce a supported edit"); await expect(panel(page).getByRole("button", { name: "Apply as vector candidate", exact: true })).toBeDisabled();
  f.setOwner("00000000-0000-4000-8000-000000009999"); await checkNormalAccount(page);
  await expect(panel(page)).toHaveCount(0); await expect(page.getByRole("img", { name: "Vector candidate", exact: true })).toHaveCount(0);
  expect(f.applications).toHaveLength(0); expect(f.admissions).toHaveLength(1);
});
test("vector proposal fixture: cold reload preserves multiple queued requests and bounded continuation blocks new admission", async ({ page }) => {
  const f = await setupVectorProposalUi(page, { navigate: false }); f.seedPending(11); await page.goto(f.base.url);
  const pending = panel(page).getByRole("region", { name: "Pending vector suggestions", exact: true });
  await expect(pending.getByRole("button", { name: "Check saved request", exact: true })).toHaveCount(10);
  await expect(panel(page).getByRole("button", { name: "Review AI suggestion request", exact: true })).toBeDisabled();
  await pending.getByRole("button", { name: "More pending requests", exact: true }).click();
  await expect(pending.getByRole("button", { name: "Check saved request", exact: true })).toHaveCount(1);
  await expect(panel(page).getByRole("button", { name: "Review AI suggestion request", exact: true })).toBeDisabled();
  await pending.getByRole("button", { name: "Stop further work", exact: true }).click(); await expect(panel(page)).toContainText("Provider outcomes and charges remain unresolved");
  expect(f.pending.get(f.closures[0]!.requestKey)!.value.state.status).toBe("needs_reconciliation");
  expect(f.admissions).toHaveLength(0); expect(f.quotes).toHaveLength(0); expect(f.closures).toHaveLength(1);
  await page.reload(); await expect(pending.getByRole("button", { name: "Check saved request", exact: true })).toHaveCount(10);
  expect(f.pending.size).toBe(11); expect(f.admissions).toHaveLength(0);
});
test("vector proposal fixture: failed pending discovery leaves manual review usable and never claims AI availability", async ({ page }) => {
  const f = await setupVectorProposalUi(page, { navigate: false }); f.discoveryFailure = true; await page.goto(f.base.url);
  await expect(panel(page)).toContainText("Pending AI requests have not been verified");
  await expect(panel(page).getByRole("button", { name: "Review AI suggestion request", exact: true })).toBeDisabled();
  await expect(page.getByRole("img", { name: "Vector candidate", exact: true })).toBeVisible(); expect(f.admissions).toHaveLength(0); expect(f.applications).toHaveLength(0);
  f.discoveryFailure = false; await panel(page).getByRole("button", { name: "Check suggestions and requests", exact: true }).click();
  await review(page); expect(f.admissions).toHaveLength(0);
});
test.afterEach(async ({ page }, info) => captureUiEvidence(page, info));
