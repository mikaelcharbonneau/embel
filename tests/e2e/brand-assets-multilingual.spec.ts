import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";
import sharp from "sharp";
import { assetsUrl, createVisualJourneyFixture, directionsUrl } from "../fixtures/visual-identity-journey";

for (const [name, family, direction] of [["茶屋 Studio", "Noto Sans SC", "ltr"], ["مقهى Studio", "Noto Sans Arabic", "rtl"]] as const) {
  test(`multilingual brand pack preserves ${name} in real browser PNG and editable SVG`, async ({ page }, info) => {
    test.setTimeout(90_000);
    const font = family === "Noto Sans SC"
      ? { file: "/fonts/brand/noto-sans-sc-variable.ttf", url: "https://fonts.google.com/specimen/Noto+Sans+SC" }
      : { file: "/fonts/brand/noto-sans-arabic-variable.ttf", url: "https://fonts.google.com/specimen/Noto+Sans+Arabic" };
    const f = createVisualJourneyFixture({ name, fontFamily: family }), health = await f.setup(page);
    const fontRequests: string[] = [];
    page.on("request", request => { const path = new URL(request.url()).pathname; if (path.startsWith("/fonts/brand/")) fontRequests.push(path); });
    await page.goto(directionsUrl);
    await page.getByRole("button", { name: "Generate three directions", exact: true }).click();
    await expect.poll(() => f.admissions.length).toBe(1);
    f.complete(1); f.systems[0]!.applicationDesign.graphic = "none";
    await page.getByRole("button", { name: "Check progress", exact: true }).click();
    await page.getByRole("button", { name: "Choose direction", exact: true }).click();
    await page.getByRole("link", { name: "Continue to brand assets", exact: true }).click();
    await expect(page).toHaveURL(assetsUrl);
    await page.getByRole("button", { name: "Create brand assets", exact: true }).click();
    await expect(page.getByText("Your brand assets are ready.", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(fontRequests).toEqual([font.file]);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download everything", exact: true }).click();
    const download = await downloadPromise;
    expect(await download.failure()).toBeNull();
    const files = unzipSync(await readFile((await download.path())!));
    await download.saveAs(info.outputPath("multilingual-brand-assets.zip"));
    expect(await sharp(files["brand-board.png"]!).metadata()).toMatchObject({ width: 1600, height: 2200 });
    expect(await sharp(files["social/banner-wide.png"]!).metadata()).toMatchObject({ width: 1500, height: 500 });
    const template = strFromU8(files["social/banner-wide.svg"]!);
    expect(template).toContain(`font-family="${family}"`);
    expect(template).toContain(`direction="${direction}" unicode-bidi="isolate" text-anchor="start"`);
    expect(template).toContain(`>${name}</text>`);
    expect(strFromU8(files["guides/brand-guide.html"]!)).toContain(font.url);

    // Compare the exported heading with independently drawn browser text using
    // the exact bundled face. This catches wrong glyphs, direction and alignment.
    const comparison = await page.evaluate(async ({ png, fontFile, family, name, direction, svg }) => {
      const face = new FontFace(family, await (await fetch(fontFile)).arrayBuffer(), { style: "normal", weight: "100 900" });
      await face.load(); document.fonts.add(face);
      const svgHost = document.createElement("div"); svgHost.style.cssText = "position:fixed;left:-10000px;top:0"; svgHost.innerHTML = svg; document.body.append(svgHost);
      try {
        const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
        const actual = document.createElement("canvas"); actual.width = 1600; actual.height = 2200;
        const actualContext = actual.getContext("2d")!; actualContext.drawImage(image, 0, 0);
        const expected = document.createElement("canvas"); expected.width = 1600; expected.height = 2200;
        const expectedContext = expected.getContext("2d")!;
        expectedContext.fillStyle = "#F7F1E3"; expectedContext.fillRect(0, 0, 1600, 2200);
        expectedContext.font = `600 100px "${family}"`; expectedContext.fillStyle = "#10241A";
        expectedContext.direction = direction; expectedContext.textAlign = direction === "rtl" ? "right" : "left";
        expectedContext.fillText(name, direction === "rtl" ? 1520 : 80, 186);
        const actualPixels = actualContext.getImageData(80, 84, 1440, 145).data, expectedPixels = expectedContext.getImageData(80, 84, 1440, 145).data;
        let mismatches = 0, ink = 0;
        for (let i = 0; i < actualPixels.length; i += 4) {
          if (expectedPixels[i]! < 100) ink++;
          if (actualPixels[i] !== expectedPixels[i] || actualPixels[i + 1] !== expectedPixels[i + 1] || actualPixels[i + 2] !== expectedPixels[i + 2]) mismatches++;
        }
        const svgName = [...svgHost.querySelectorAll("text")].find(node => node.textContent === name)!;
        const bounds = svgName.getBBox(); expectedContext.font = `600 ${svgName.getAttribute("font-size")}px "${family}"`;
        return { mismatches, ink, loaded: face.status, svg: { direction: getComputedStyle(svgName).direction,
          width: svgName.getComputedTextLength(), expectedWidth: expectedContext.measureText(name).width, x: bounds.x, right: bounds.x + bounds.width } };
      } finally { svgHost.remove(); document.fonts.delete(face); }
    }, { png: Buffer.from(files["brand-board.png"]!).toString("base64"), fontFile: font.file, family, name, direction, svg: template });
    expect(comparison.loaded).toBe("loaded"); expect(comparison.ink).toBeGreaterThan(1000); expect(comparison.mismatches).toBe(0);
    expect(comparison.svg.direction).toBe(direction); expect(comparison.svg.width).toBeCloseTo(comparison.svg.expectedWidth, 0);
    // Glyph overhangs may extend a few pixels beyond the advance-box anchor.
    expect(Math.abs((direction === "rtl" ? comparison.svg.right : comparison.svg.x) - (direction === "rtl" ? 1380 : 645))).toBeLessThan(8);
    expect(f.admissions).toHaveLength(1); expect(f.selections).toHaveLength(1);
    expect(health.pageErrors).toEqual([]); expect(health.consoleErrors).toEqual([]);
  });
}
