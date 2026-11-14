// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppMark } from "@/components/ui/app-mark";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const paths = (svg: string) => svg.match(/<path [^>]*\/>/g) ?? [];

it("serves a clean copy of the approved mark and keeps the original with its provenance record", () => {
  const original = read("design-assets/brand/embel-mark-original.svg");
  expect(original).toContain("c2pa");
  for (const served of ["public/embel-mark.svg", "public/fluid-mark.svg", "src/app/icon.svg"]) {
    const svg = read(served);
    expect(Buffer.byteLength(svg)).toBeLessThanOrEqual(2048);
    expect(svg).not.toContain("<metadata");
    expect(paths(svg)).toEqual(paths(original));
    expect(paths(svg)).toHaveLength(8);
  }
});

it("loads the mark eagerly: it is on the first screen of every page", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  await act(async () => root.render(<AppMark />));
  expect(host.querySelector("img")?.getAttribute("loading")).toBe("eager");
  expect(host.querySelector("img")?.getAttribute("src")).toBe("/embel-mark.svg");
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
