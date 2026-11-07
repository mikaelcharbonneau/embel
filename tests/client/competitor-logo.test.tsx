// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompetitorLogo } from "@/components/workspace/competitor-logo";

let host: HTMLDivElement, root: Root;
beforeEach(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const projectId = "33333333-3333-4333-8333-333333333333";
async function loaded(naturalWidth: number, size = 40) {
  await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "Fixture Studio", url: "https://fixture.example.org/about", size })));
  const image = host.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { configurable: true, value: naturalWidth });
  await act(async () => { image.dispatchEvent(new Event("load")); });
  return image;
}

describe("competitor logo", () => {
  it("asks Embel's server for the site icon, never the competitor site", async () => {
    await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "Fixture Studio", url: "https://fixture.example.org/about" })));
    expect(host.querySelector("img")!.getAttribute("src")).toBe(`/api/projects/${projectId}/competitor-icon?host=fixture.example.org&v=2`);
  });

  it("fills the space with a large icon", async () => {
    expect((await loaded(180)).style.padding).toBe("");
  });

  it("shows a tiny icon smaller instead of stretching it", async () => {
    expect((await loaded(32)).style.padding).toBe("10px");
    expect((await loaded(16)).style.padding).toBe("12px");
  });

  it("leaves small chips at their size", async () => {
    expect((await loaded(32, 24)).style.padding).toBe("");
  });

  it("shows the initial when the site has no usable icon", async () => {
    await act(async () => root.render(createElement(CompetitorLogo, { projectId, name: "fixture Studio", url: "http://fixture.example.org" })));
    expect(host.querySelector(".competitor-logo-monogram")?.textContent).toBe("F");
  });
});
