import { expect, test, type Locator, type Page } from "@playwright/test";
import { frameBarrier, namingCard, namingFixture, openNaming } from "./naming-brain-fixture";

async function box(locator: Locator) {
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  return rect!;
}

async function drag(page: Page, grip: Locator, touch: boolean, dx: number, dy: number) {
  const rect = await box(grip), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  if (touch) {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let i = 1; i <= 6; i++) await session.send("Input.dispatchTouchEvent", {
        type: "touchMove", touchPoints: [{ x: x + dx * i / 6, y: y + dy * i / 6 }],
      });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally { await session.detach(); }
  } else {
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 6 }); await page.mouse.up();
  }
  await frameBarrier(page);
}

async function checkCanvasBesideCard(page: Page) {
  const point = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("[data-naming-results-scroll]")!;
    const card = document.querySelector<HTMLElement>("[data-floating-composer]")!;
    const area = canvas.getBoundingClientRect(), panel = card.getBoundingClientRect();
    const y = Math.floor(panel.top + panel.height / 2);
    // Probe both exposed strips at the same vertical position as the card.
    for (const x of [area.left + 2, area.right - 3, panel.left - 2, panel.right + 2]) {
      if (x <= area.left || x >= area.right || (x >= panel.left && x < panel.right)) continue;
      const hit = document.elementFromPoint(x, y);
      if (hit && canvas.contains(hit) && !hit.closest('button,a,input,[role="button"]')) return { x, y };
    }
    return null;
  });
  expect(point, "the results canvas receives hits beside the floating card").not.toBeNull();
  // Verify real pointer delivery; a transparent overlay can look identical.
  await page.locator("[data-naming-results-scroll]").evaluate(canvas => {
    canvas.addEventListener("pointerdown", () => canvas.setAttribute("data-qa-pointer", "received"), { once: true });
  });
  await page.mouse.click(point!.x, point!.y);
  await expect(page.locator("[data-naming-results-scroll]")).toHaveAttribute("data-qa-pointer", "received");
}

test("move, minimize and expand the Naming composer above results and name inspection", async ({ page }, info) => {
  const mobile = info.project.name === "mobile";
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
  const f = await namingFixture(page, { saved: true, count: 100 });
  await openNaming(page); await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  const card = page.locator("[data-floating-composer]");
  const canvas = page.locator("[data-naming-results-scroll]");
  const grip = card.getByRole("button", { name: "Move composer", exact: true });
  const composer = page.getByRole("textbox", { name: "Naming message", exact: true });
  const message = "A draft I have not sent.";
  await composer.fill(message); await grip.focus(); await frameBarrier(page);
  const start = await box(card), workspace = await box(page.locator("[data-naming-layout]")), results = await box(canvas);
  expect(Math.abs(results.y + results.height - workspace.y - workspace.height)).toBeLessThanOrEqual(2);
  expect(results.y + results.height).toBeGreaterThan(start.y + start.height / 2);
  await checkCanvasBesideCard(page);
  expect(await grip.evaluate(button => {
    const b = button.getBoundingClientRect();
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
    return button.contains(hit) ? "drag handle" : hit?.tagName + " " + (hit?.getAttribute("aria-label") ?? hit?.className ?? "");
  }), "the composer handle wins hit testing over the names grid").toBe("drag handle");
  await drag(page, grip, mobile, mobile ? 0 : 120, -125);
  const moved = await box(card);
  expect(moved.y).toBeLessThan(start.y - 65);
  if (!mobile) expect(moved.x).toBeGreaterThan(start.x + 60);
  await grip.press("ArrowDown"); await frameBarrier(page);
  expect((await box(card)).y).toBeCloseTo(moved.y + 16, 0);
  await grip.press("Home"); await frameBarrier(page);
  expect((await box(card)).x).toBeCloseTo(start.x, 0);
  expect((await box(card)).y).toBeCloseTo(start.y, 0);

  await card.getByRole("button", { name: "Open chat", exact: true }).click();
  await expect(card).toHaveAttribute("data-expanded", "true");
  await expect(page.locator("[data-naming-chat-scroll]")).toBeVisible();
  await card.getByRole("button", { name: "Close chat", exact: true }).click();
  await expect(card).toHaveAttribute("data-expanded", "false");
  await card.getByRole("button", { name: "Minimize composer", exact: true }).click();
  await expect(composer).toBeHidden();
  await card.getByRole("button", { name: "Restore composer", exact: true }).click();
  await expect(composer).toHaveValue(message);

  await drag(page, grip, mobile, mobile ? -130 : 220, -160);
  await page.setViewportSize(mobile ? { width: 320, height: 568 } : { width: 840, height: 560 });
  await frameBarrier(page);
  const cardRect = await box(card), boundary = await box(page.locator("[data-floating-composer-host]"));
  expect(cardRect.x).toBeGreaterThanOrEqual(boundary.x - 1); expect(cardRect.y).toBeGreaterThanOrEqual(boundary.y - 1);
  expect(cardRect.x + cardRect.width).toBeLessThanOrEqual(boundary.x + boundary.width + 1);
  expect(cardRect.y + cardRect.height).toBeLessThanOrEqual(boundary.y + boundary.height + 1);
  await grip.press("Home"); await frameBarrier(page);
  // Programmatic inspection of the existing last result must not request more names.
  await canvas.evaluate(el => { el.scrollTop = el.scrollHeight; });
  const inspectLast = namingCard(page, 100).getByRole("button", { name: "Inspect name Synthetic 100", exact: true });
  await inspectLast.click();
  const inspection = page.getByRole("dialog", { name: "Synthetic 100", exact: true });
  await expect(inspection).toBeVisible(); await expect(inspection).toContainText("Synthetic 100");
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  await inspection.getByRole("button", { name: "Use this name", exact: true }).click({ trial: true });
  await page.getByRole("button", { name: "Close name preview", exact: true }).click();
  await checkCanvasBesideCard(page);
  await drag(page, grip, mobile, 0, -100);
  await expect(page.locator(".naming-feed-card")).toHaveCount(100); await expect(composer).toHaveValue(message);
  expect(f.mutations()).toHaveLength(0);
});

test("Naming remembers the composer's placement and minimized state when inspecting and reopening the project", async ({ page, context }, info) => {
  const mobile = info.project.name === "mobile";
  const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  await page.setViewportSize(viewport);
  const fixture = await namingFixture(page, { saved: true, count: 100 });
  await openNaming(page);
  const panel = (tab: Page) => tab.locator("[data-floating-composer]");
  const button = (tab: Page, name: string) => panel(tab).getByRole("button", { name, exact: true });
  // The writer changes size when minimized. Compare its bottom-center anchor
  // relative to the same workspace, rather than using its top-left corner.
  const anchor = (tab: Page) => panel(tab).evaluate(el => {
    const r = el.getBoundingClientRect();
    const host = el.closest("[data-floating-composer-host]")!.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2 - host.left), y: Math.round(r.bottom - host.top) };
  });
  const at = async (tab: Page, expected: { x: number; y: number }) => {
    await expect.poll(async () => {
      const actual = await anchor(tab);
      return Math.max(Math.abs(expected.x - actual.x), Math.abs(expected.y - actual.y));
    }).toBeLessThanOrEqual(2);
  };

  await expect(panel(page)).toHaveAttribute("data-expanded", "false");
  const original = await anchor(page);
  const grip = button(page, "Move composer");
  await drag(page, grip, mobile, mobile ? 0 : 120, -135);
  const moved = await anchor(page);
  expect(moved.y).toBeLessThan(original.y - 100);
  if (!mobile) expect(moved.x).toBeGreaterThan(original.x + 90);
  await button(page, "Minimize composer").click();
  await expect(panel(page)).toHaveAttribute("data-minimized", "true");
  const minimized = await anchor(page);
  await namingCard(page, 1).getByRole("button", { name: "Inspect name Synthetic 001", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Synthetic 001", exact: true })).toBeVisible();
  await expect(panel(page)).toHaveAttribute("data-minimized", "true"); await at(page, minimized);
  await page.getByRole("button", { name: "Close name preview", exact: true }).click();
  await expect(page.locator(".naming-feed-card")).toHaveCount(100);
  await expect(button(page, "Restore composer")).toBeVisible(); await at(page, minimized);

  const reopened = await context.newPage();
  try {
    await reopened.setViewportSize(viewport);
    const fresh = await namingFixture(reopened, { saved: true, count: 100 });
    await openNaming(reopened); await expect(reopened.locator(".naming-feed-card")).toHaveCount(100);
    await expect(button(reopened, "Restore composer")).toBeVisible(); await at(reopened, minimized);
    await button(reopened, "Restore composer").click();
    await expect(reopened.getByRole("textbox", { name: "Naming message", exact: true })).toBeVisible();
    await at(reopened, moved);
    await button(reopened, "Open chat").click();
    await expect(panel(reopened)).toHaveAttribute("data-expanded", "true");
    await reopened.reload(); await expect(reopened.locator(".naming-feed-card")).toHaveCount(100);
    await expect(button(reopened, "Close chat")).toBeVisible();
    await expect(reopened.locator("[data-naming-chat-scroll]")).toBeVisible();
    await button(reopened, "Close chat").click();
    await expect(panel(reopened)).toHaveAttribute("data-expanded", "false"); await at(reopened, moved);
    await button(reopened, "Move composer").press("Home"); await at(reopened, original);
    await reopened.reload(); await expect(reopened.locator(".naming-feed-card")).toHaveCount(100);
    await expect(button(reopened, "Minimize composer")).toBeVisible();
    await expect(panel(reopened)).toHaveAttribute("data-expanded", "false"); await at(reopened, original);
    await expect(button(reopened, "Reset composer position")).toHaveCount(0);
    expect(fresh.mutations()).toHaveLength(0);
  } finally { await reopened.close(); }
  expect(fixture.mutations()).toHaveLength(0);
});
