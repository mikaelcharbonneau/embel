// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const { renderEffect } = vi.hoisted(() => ({ renderEffect: vi.fn() }));
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => {
    renderEffect(props);
    return <div data-testid="real-library-boundary" />;
  },
}));
import { GenerationAnimation, IMAGE_FX_LOADING_OPTIONS } from "@/components/logo-creation/generation-animation";
it("uses the selected Image FX settings without reveal loops or private image pools", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = false;
  vi.stubGlobal("matchMedia", () => media);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<GenerationAnimation variant={0} />));
    const stage = host.firstElementChild;
    expect(IMAGE_FX_LOADING_OPTIONS).toEqual({
      preset: "pixels-organic",
      theme: "light",
      pixelScale: 0.5,
      strength: 1,
      autoReveal: false,
    });
    expect(renderEffect).toHaveBeenCalled();
    const props = renderEffect.mock.lastCall![0];
    expect(props).toMatchObject(IMAGE_FX_LOADING_OPTIONS);
    expect(props.images).toBeUndefined();
    expect(props.colors).toBeUndefined();
    expect(host.textContent).not.toMatch(/\d+%|Option \d/);
    await act(async () => {
      media.matches = true;
      media.dispatchEvent(new Event("change"));
    });
    expect(host.querySelector('[data-testid="real-library-boundary"]')).toBeNull();
    expect(host.textContent).toContain("Creating your concept");
    await act(async () => root.render(<GenerationAnimation variant={0} queued />));
    expect(host.firstElementChild).toBe(stage);
    expect(host.textContent).toContain("Waiting to create");
    await act(async () => {
      media.matches = false;
      media.dispatchEvent(new Event("change"));
    });
    expect(host.querySelector('[data-testid="real-library-boundary"]')).toBeNull();
    await act(async () => root.render(<GenerationAnimation variant={1} />));
    expect(host.firstElementChild).toBe(stage);
    expect(host.querySelector('[data-testid="real-library-boundary"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    renderEffect.mockClear();
  }
});
