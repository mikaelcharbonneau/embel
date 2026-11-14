import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import { assetsUrl, createVisualJourneyFixture, directionsUrl } from "../fixtures/visual-identity-journey";
import { guidedSlogan } from "../../src/domain/guided-interview";
import { brandCopy, createFinalBrandBoard } from "../../src/features/brand-assets/model/artwork";
import { createBrandAssetSnapshot } from "../../src/features/brand-assets/model/snapshot";

for (const [name, family, direction] of [
  ["茶屋 Studio", "Noto Sans SC", "ltr"],
  ["مقهى Studio", "Noto Sans Arabic", "rtl"],
] as const) {
  test(`multilingual brand pack preserves ${name} in the real browser PNG`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const font =
      family === "Noto Sans SC"
        ? { file: "/fonts/brand/noto-sans-sc-variable.ttf", url: "https://fonts.google.com/specimen/Noto+Sans+SC" }
        : {
            file: "/fonts/brand/noto-sans-arabic-variable.ttf",
            url: "https://fonts.google.com/specimen/Noto+Sans+Arabic",
          };
    const f = createVisualJourneyFixture({ name, fontFamily: family }),
      health = await f.setup(page);
    const fontRequests: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/fonts/brand/")) fontRequests.push(path);
    });
    await page.goto(directionsUrl);
    await page.getByRole("button", { name: "Create three directions", exact: true }).click();
    await expect.poll(() => f.admissions.length).toBe(1);
    f.complete(1);
    f.systems[0]!.applicationDesign.graphic = "none";
    await page.getByRole("button", { name: "Check progress", exact: true }).click();
    const sample = page
      .locator('[aria-label="Direction comparison"] article')
      .first()
      .locator("bdi")
      .filter({ hasText: name });
    await expect(sample).toBeVisible();
    await expect(sample).toHaveAttribute("dir", direction);
    await page
      .getByRole("article", { name: /^Direction 1:/ })
      .getByRole("button", { name: "Choose", exact: true })
      .click();
    await page.getByRole("link", { name: "Continue", exact: true }).click();
    await expect(page).toHaveURL(assetsUrl);
    const kit = page.getByRole("button", { name: "Download brand kit", exact: true });
    await expect(kit).toBeEnabled();
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await kit.click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    expect([...new Set(fontRequests)]).toEqual([font.file]);
    const files = unzipSync(await readFile((await download.path())!));
    await download.saveAs(info.outputPath("multilingual-brand-assets.zip"));
    expect(await sharp(files["brand-board.png"]!).metadata()).toMatchObject({ width: 1600, height: 2200 });
    expect(await sharp(files["social/banner-wide.png"]!).metadata()).toMatchObject({ width: 1500, height: 500 });
    expect(strFromU8(files["guides/brand-guide.html"]!)).toContain(font.url);
    // Templates carry the logo, never the name a second time; the name is set in type on the board.
    expect(strFromU8(files["social/banner-wide.svg"]!)).not.toContain(`>${name}</text>`);

    // Compare the board's type sample, which shows the name in the heading face, with
    // independently drawn browser text using the exact bundled face. This catches wrong
    // glyphs, direction and alignment. The expected geometry comes from the same template.
    const snapshot = createBrandAssetSnapshot({
      system: f.systems[0]!,
      sourceLogo: f.sourceLogo,
      ownerId: f.systems[0]!.ownerId,
      projectId: f.systems[0]!.projectId,
    });
    const context = f.project.context;
    const typeSample = createFinalBrandBoard(
      snapshot,
      brandCopy(snapshot, { slogan: guidedSlogan(context), positioning: context.positioning || null }),
    ).nodes.find((node) => node.kind === "text" && node.text === name);
    if (typeSample?.kind !== "text") throw new Error("The board sets the name in its type sample.");
    const comparison = await page.evaluate(
      async ({ png, fontFile, family, name, direction, sample, background }) => {
        const face = new FontFace(family, await (await fetch(fontFile)).arrayBuffer(), {
          style: "normal",
          weight: "100 900",
        });
        await face.load();
        document.fonts.add(face);
        try {
          const image = new Image();
          image.src = `data:image/png;base64,${png}`;
          await image.decode();
          const actual = document.createElement("canvas");
          actual.width = 1600;
          actual.height = 2200;
          const actualContext = actual.getContext("2d")!;
          actualContext.drawImage(image, 0, 0);
          const expected = document.createElement("canvas");
          expected.width = 1600;
          expected.height = 2200;
          const expectedContext = expected.getContext("2d")!;
          expectedContext.fillStyle = background;
          expectedContext.fillRect(0, 0, 1600, 2200);
          expectedContext.font = `${sample.weight} ${sample.size}px "${family}"`;
          expectedContext.fillStyle = sample.color;
          expectedContext.direction = direction;
          expectedContext.textAlign = "start";
          expectedContext.fillText(name, direction === "rtl" ? sample.x + sample.maxWidth : sample.x, sample.y);
          const top = Math.round(sample.y - sample.size * 0.9),
            height = Math.round(sample.size * 1.25);
          const actualPixels = actualContext.getImageData(sample.x, top, sample.maxWidth, height).data,
            expectedPixels = expectedContext.getImageData(sample.x, top, sample.maxWidth, height).data;
          let mismatches = 0,
            ink = 0,
            left = Infinity,
            right = -Infinity;
          for (let i = 0; i < actualPixels.length; i += 4) {
            if (expectedPixels[i]! < 100) {
              ink++;
              const x = (i / 4) % sample.maxWidth;
              left = Math.min(left, x);
              right = Math.max(right, x);
            }
            if (
              actualPixels[i] !== expectedPixels[i] ||
              actualPixels[i + 1] !== expectedPixels[i + 1] ||
              actualPixels[i + 2] !== expectedPixels[i + 2]
            )
              mismatches++;
          }
          return { mismatches, ink, left, right, loaded: face.status };
        } finally {
          document.fonts.delete(face);
        }
      },
      {
        png: Buffer.from(files["brand-board.png"]!).toString("base64"),
        fontFile: font.file,
        family,
        name,
        direction,
        sample: {
          x: typeSample.x,
          y: typeSample.y,
          size: typeSample.size,
          maxWidth: typeSample.maxWidth,
          weight: typeSample.weight,
          color: typeSample.color,
        },
        background: snapshot.palette.background,
      },
    );
    expect(comparison.loaded).toBe("loaded");
    expect(comparison.ink).toBeGreaterThan(1000);
    expect(comparison.mismatches).toBe(0);
    // Left-to-right text starts at the column's left edge; right-to-left text ends at its right edge.
    if (direction === "rtl") expect(comparison.right).toBeGreaterThan(typeSample.maxWidth - 12);
    else expect(comparison.left).toBeLessThan(12);
    expect(f.admissions).toHaveLength(1);
    expect(f.selections).toHaveLength(1);
    expect(health.pageErrors).toEqual([]);
    expect(health.consoleErrors).toEqual([]);
  });
}
