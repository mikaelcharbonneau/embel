// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createAccountLogoClient } from "../../../src/components/identity/account-logo-client";
import { OwnedTextControls } from "../../../src/features/logo-vector/components/owned-text-controls";
import { textEditFixture } from "./text-edit-fixtures";

describe("account-bound lettering controls", () => {
  let root: Root, host: HTMLDivElement;
  beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
  afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  async function until(test: () => boolean) { for (let i = 0; i < 60 && !test(); i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)); }); expect(test(), host.textContent ?? "DOM").toBe(true); }
  async function fixture(delay = false) {
    const f = await textEditFixture(), account = { status: "ready" as const, userId: f.revision.ownerId, generation: 1 }; let current = true, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const client = createAccountLogoClient(account, f.projectId, () => current, () => { current = false; }, async url => {
      if (delay) await gate;
      const path = String(url);
      return Response.json(path.includes("/stages/") ? f.brief : path.includes("/raster-refinements/") ? f.refinement : [f.input.font.record]);
    });
    const props = { account, client, revision: f.revision, document: f.document, componentId: "synthetic-lettering", lockedComponentIds: [], isCurrent: () => current, onEdit() {} };
    const render = () => act(async () => root.render(createElement(OwnedTextControls, props)));
    await render(); return { ...f, render, release, foreign() { current = false; } };
  }
  it("loads controls independently without generating a new logo or font preview", async () => {
    await fixture(); await until(() => host.textContent!.includes("Replace outlined lettering"));
    expect(host.querySelector("svg, img")).toBeNull(); expect(host.textContent).toContain("Save edit creates a new lettering version");
  });
  it("hides former-owner controls before a late read completes", async () => {
    const f = await fixture(true); expect(host.textContent).toContain("Loading verified text controls");
    f.foreign(); await f.render(); await act(async () => f.release());
    expect(host.textContent).toBe(""); expect(host.querySelector("input, select, button")).toBeNull();
  });
});
