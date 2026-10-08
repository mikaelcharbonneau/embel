import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";

/** Optional reviewer screenshots from the existing, intercepted account fixtures. */
export async function captureUiEvidence(page: Page, info: TestInfo) {
  const directory = process.env.FLUID_UI_EVIDENCE;
  if (!directory || info.status !== "passed" || page.isClosed()) return;
  await mkdir(directory, { recursive: true });
  const filename = `${info.project.name}-${info.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 115)}.png`;
  await page.screenshot({ path: join(directory, filename), fullPage: true, scale: "css" });
}
