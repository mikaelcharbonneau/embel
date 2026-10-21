// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NamingScreening } from "@/components/naming/naming-screening";

let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("project Naming selected-name presentation", () => {
  it("retains the exact long selected spelling and evidence limits through a pending state", async () => {
    const name = "Bel Élan 東京 · A very long retained project name ".repeat(3);
    const change = vi.fn();
    await act(async () => root.render(<NamingScreening name={name} earlierContext pending={false} onChangeName={change} />));
    const heading = host.querySelector("h2")!, action = host.querySelector<HTMLButtonElement>("button")!;
    expect(heading.textContent).toBe(name);
    expect(action.textContent).toBe("Change name");
    expect(host.textContent).toContain("earlier strategy context");
    expect([...host.querySelectorAll(".project-naming-screening-status")].map(item => item.textContent)).toEqual(Array(3).fill("Not checked here"));
    for (const tool of ["domains", "handles", "trademarks"]) {
      const link = host.querySelector<HTMLAnchorElement>(`a[href="/${tool}"]`)!;
      expect(link.textContent).toBe(`Open ${tool}`);
      expect(document.getElementById(link.getAttribute("aria-describedby")!)).not.toBeNull();
    }
    await act(async () => root.render(<NamingScreening name={name} earlierContext pending onChangeName={change} />));
    expect(host.querySelector("h2")).toBe(heading);
    expect(host.querySelector("button")).toBe(action);
    expect(action.disabled).toBe(true);
    await act(async () => action.click());
    expect(change).not.toHaveBeenCalled();
    expect(host.textContent).toContain("does not purchase a domain, reserve a handle or establish trademark clearance");
  });

  it("keeps the selected-name action explicit and preserves focus on unchanged rendering", async () => {
    const change = vi.fn();
    await act(async () => root.render(<NamingScreening name="Synthetic retained name" earlierContext={false} pending={false} onChangeName={change} />));
    const action = host.querySelector<HTMLButtonElement>("button")!;
    action.focus();
    await act(async () => root.render(<NamingScreening name="Synthetic retained name" earlierContext={false} pending={false} onChangeName={change} />));
    expect(document.activeElement).toBe(action);
    expect(change).not.toHaveBeenCalled();
    await act(async () => action.click());
    expect(change).toHaveBeenCalledTimes(1);
    expect(host.querySelector("h2")!.textContent).toBe("Synthetic retained name");
  });
});
