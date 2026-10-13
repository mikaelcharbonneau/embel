// @vitest-environment jsdom
import { act, createElement, useLayoutEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountProjectSchema } from "@/domain/project-api";
import { accountProjectDraft } from "@/components/workspace/project-draft-adapter";
import { PersonalityReview } from "@/components/workspace/strategy-review";
import type { LocalDraft } from "@/components/workspace/local-drafts";

const when = "2026-10-04T10:00:00.000Z";
let root: Root | null, host: HTMLDivElement, current: LocalDraft;
const complete = vi.fn();
function Harness() {
  const [draft, setDraft] = useState(() => accountProjectDraft(accountProjectSchema.parse({
    id: "bbbbbbbb-1111-4111-8111-111111111111", owner_id: "aaaaaaaa-1111-4111-8111-111111111111", title: "Personality fixture", scope: "complete_brand", current_revision: 1, created_at: when,
    context: { description: "Synthetic kitchen brief", personality: { sincerity: 40, excitement: 35, competence: 60, sophistication: 45, ruggedness: 20 } },
  })));
  useLayoutEffect(() => { current = draft; });
  return createElement(PersonalityReview, { draft, inline: true, notice: "", onChange: personality => setDraft(previous => ({ ...previous, personality })), onComplete: complete, onBack: vi.fn(), onSkip: vi.fn() });
}
async function slider(label: string, value: number) {
  const id = [...host.querySelectorAll("label")].find(element => element.textContent === label)!.htmlFor;
  const input = document.getElementById(id)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function trait(label: string) {
  const input = [...host.querySelectorAll("label")].find(element => element.querySelector("strong")?.textContent === label)!.querySelector("input")!;
  await act(async () => input.click());
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); complete.mockReset();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(Harness)));
});
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = null; document.body.replaceChildren(); });

describe("Personality review keeps the current editing baseline", () => {
  it("keeps advanced edits when starting a trait choice", async () => {
    await slider("Sophistication", 91); expect(current.personality?.sophistication).toBe(91);
    await trait("Warm");
    expect(current.personality).toEqual({ sincerity: 80, excitement: 35, competence: 60, sophistication: 91, ruggedness: 20 });
    expect(complete).not.toHaveBeenCalled();
  });

  it("restores the edited baseline when traits are deselected, including shared dimensions", async () => {
    await slider("Competence", 73);
    await trait("Thoughtful"); await trait("Confident"); await trait("Thoughtful");
    expect(current.personality?.competence).toBe(80);
    await trait("Confident"); expect(current.personality?.competence).toBe(73);
  });

  it("starts a new baseline after a slider edit clears the trait choices", async () => {
    await trait("Warm"); await slider("Ruggedness", 64);
    await trait("Playful"); await trait("Playful");
    expect(current.personality).toEqual({ sincerity: 80, excitement: 35, competence: 60, sophistication: 45, ruggedness: 64 });
    expect(complete).not.toHaveBeenCalled();
  });
});
