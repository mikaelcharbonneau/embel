// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompetitorLogo } from "@/components/workspace/competitor-logo";

let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const projectId = "33333333-3333-4333-8333-333333333333";
async function shown(size = 40) {
  await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "Fixture Studio", url: "https://fixture.example.org/about", size })));
  return { tile: host.querySelector<HTMLElement>(".competitor-logo")!, image: host.querySelector("img")! };
}

describe("competitor logo", () => {
  it("asks Embel's server for the site icon, never the competitor site", async () => {
    await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "Fixture Studio", url: "https://fixture.example.org/about" })));
    expect(host.querySelector("img")!.getAttribute("src")).toBe(`/api/projects/${projectId}/competitor-icon?host=fixture.example.org&v=2`);
  });

  it("shows every icon at the same size inside the same tile", async () => {
    const { tile, image } = await shown();
    expect([tile.style.width, tile.style.height]).toEqual(["40px", "40px"]);
    expect([image.getAttribute("width"), image.getAttribute("height")]).toEqual(["24", "24"]);
  });

  it("keeps small chips proportionate", async () => {
    const { tile, image } = await shown(22);
    expect(tile.style.width).toBe("22px");
    expect(image.getAttribute("width")).toBe("15");
  });

  it("falls back to the initial in the same tile when the icon fails", async () => {
    const { image } = await shown();
    await act(async () => { image.dispatchEvent(new Event("error")); });
    const tile = host.querySelector<HTMLElement>(".competitor-logo-monogram")!;
    expect(tile.textContent).toBe("F");
    expect(tile.style.width).toBe("40px");
  });

  it("shows the initial when the site has no usable icon", async () => {
    await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "fixture Studio", url: "http://fixture.example.org" })));
    expect(host.querySelector(".competitor-logo-monogram")?.textContent).toBe("F");
  });
});
