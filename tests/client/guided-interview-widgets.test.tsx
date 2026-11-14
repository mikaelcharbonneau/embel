// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FoldedAnswer,
  GuidedChoices,
  GuidedChoicesEmpty,
  GuidedChoicesLoading,
  selectedOptions,
  type GuidedChoicesProps,
} from "@/components/workspace/guided-interview-widgets";
import type { GuidedOption, GuidedReply } from "@/domain/guided-interview";

type ChoiceReply = Extract<GuidedReply, { kind: "choices" }>;
const competitorId = "11111111-1111-4111-8111-111111111111";
const competitor: GuidedOption = {
  id: competitorId,
  stage: "competitors",
  label: "Fixture Studio",
  description: "Synthetic competitor description for this local test.",
  recommended: true,
  recommendationReason: "Its product range addresses the same need.",
  payload: {
    id: competitorId,
    name: "Fixture Studio",
    relevance: "A useful comparison for everyday objects.",
    url: "https://studio.example.test",
    origin: "research",
    selected: false,
    sources: [
      {
        url: "https://studio.example.test/about",
        title: "Fixture Studio: About",
        retrievedAt: "2026-10-14T10:00:00.000Z",
      },
    ],
  },
};
const audienceId = "22222222-2222-4222-8222-222222222222";
const audience: GuidedOption = {
  id: audienceId,
  stage: "audience",
  label: "People furnishing their first home",
  description: "Buyers building a lasting collection from a small starting budget.",
  recommended: true,
  recommendationReason: "Your practical, durable range meets their immediate priorities.",
  payload: {
    id: audienceId,
    label: "People furnishing their first home",
    needs: ["Affordable essentials", "Pieces that last"],
    reason: "They are making several considered purchases at once.",
    origin: "proposal",
    selected: false,
    sources: [],
  },
};
const personality: GuidedOption = {
  id: "warm-confident",
  stage: "personality",
  label: "Warm and quietly confident",
  description: "A considered, approachable voice with a clear point of view.",
  recommended: true,
  recommendationReason: "This supports the audience's wish for lasting usefulness.",
  payload: {
    profile: { sincerity: 75, excitement: 25, competence: 65, sophistication: 40, ruggedness: 15 },
    traits: ["Warm", "Thoughtful", "Confident"],
    expression: "Welcoming language, restrained layouts, and tactile materials.",
    toneExample: "Good things, chosen for every day.",
  },
};
function choices(option: GuidedOption, additional: GuidedOption[] = []): ChoiceReply {
  return {
    kind: "choices",
    turnId: "fixture-turn",
    stage: option.stage,
    message: "A synthetic assistant reply.",
    question:
      option.stage === "competitors"
        ? "Which brands belong in your comparison?"
        : option.stage === "audience"
          ? "Who are you here for?"
          : "How should your brand feel?",
    selectionMode: option.stage === "personality" ? "single" : "multiple",
    options: [option, ...additional],
  };
}

let host: HTMLDivElement;
let root: Root;
const onSelectionChange = vi.fn<(ids: string[]) => void>();
function Harness({ reply, initialSelectedIds = [] }: { reply: ChoiceReply; initialSelectedIds?: string[] }) {
  const [selectedIds, setSelectedIds] = useState(initialSelectedIds);
  return (
    <GuidedChoices
      reply={reply}
      selectedIds={selectedIds}
      onSelectionChange={(ids) => {
        onSelectionChange(ids);
        setSelectedIds(ids);
      }}
    />
  );
}
async function render(reply = choices(competitor), props: Partial<GuidedChoicesProps> = {}) {
  await act(async () =>
    root.render(createElement(GuidedChoices, { reply, selectedIds: [], onSelectionChange, ...props })),
  );
}
/** Decision 2: no step offers its own Continue; Send in the reply box moves on. */
function continueButton() {
  return [...host.querySelectorAll("button")].find((button) => /^Continue/u.test(button.textContent ?? ""));
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  onSelectionChange.mockReset();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("guided interview choice controls", () => {
  it("marks recommendations on compact competitor cards without selecting or confirming them", async () => {
    const other: GuidedOption = {
      ...competitor,
      id: "44444444-4444-4444-8444-444444444444",
      label: "Other Studio",
      recommended: false,
      recommendationReason: null,
      payload: { ...competitor.payload, id: "44444444-4444-4444-8444-444444444444", name: "Other Studio" },
    };
    await render(choices(competitor, [other]));
    expect(
      [...host.querySelectorAll(".guided-option__recommended")].map((badge) => badge.closest(".e-choice")?.textContent),
    ).toEqual([expect.stringContaining("Fixture Studio")]);
    // Competitor cards stay compact: the recommendation reason is not repeated in a box.
    expect(host.textContent).not.toContain(competitor.recommendationReason);
    expect(host.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    expect(continueButton()).toBeUndefined();
    expect(host.textContent).toContain("0 selected. Choose at least one competitor to continue.");
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(host.querySelector("textarea")).toBeNull();
  });

  it("leaves out the badge when every card is recommended, and a reason that repeats the description", async () => {
    const repeated: GuidedOption = {
      ...competitor,
      payload: { ...competitor.payload, relevance: "Synthetic competitor description for this local test." },
    };
    await render(choices(repeated));
    expect(host.querySelector(".guided-option__recommended")).toBeNull();
    expect(host.textContent).not.toContain("Why it matters");
    await render(choices(competitor));
    expect(host.textContent).toContain("Why it matters");
  });

  it("keeps multi-select choices editable; choosing never confirms them", async () => {
    const second: GuidedOption = {
      ...audience,
      id: "33333333-3333-4333-8333-333333333333",
      label: "Thoughtful gift buyers",
      recommended: false,
      recommendationReason: null,
      payload: { ...audience.payload, id: "33333333-3333-4333-8333-333333333333" },
    };
    await act(async () => root.render(<Harness reply={choices(audience, [second])} />));
    const inputs = host.querySelectorAll<HTMLInputElement>("input");
    await act(async () => inputs[0]!.click());
    await act(async () => inputs[1]!.click());
    expect(onSelectionChange).toHaveBeenLastCalledWith([audience.id, second.id]);
    expect(host.textContent).toContain("2 selected");
    await act(async () => inputs[0]!.click());
    expect(onSelectionChange).toHaveBeenLastCalledWith([second.id]);
    expect(continueButton()).toBeUndefined();
    expect(host.textContent).toContain("Choose one or more, then press Send.");
  });

  it("uses one native radio group for personality and replaces the earlier selection", async () => {
    const second: GuidedOption = {
      ...personality,
      id: "energetic-expressive",
      label: "Energetic and expressive",
      recommended: false,
      recommendationReason: null,
    };
    await act(async () => root.render(<Harness reply={choices(personality, [second])} />));
    const inputs = host.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs.length).toBe(2);
    expect(inputs[0]!.name).toBe(inputs[1]!.name);
    await act(async () => inputs[0]!.click());
    await act(async () => inputs[1]!.click());
    expect(onSelectionChange).toHaveBeenLastCalledWith([second.id]);
    expect(inputs[0]!.checked).toBe(false);
    expect(inputs[1]!.checked).toBe(true);
    // The ring alone shows the choice (decision 3): no tick or radio mark is drawn.
    expect(host.querySelector(".e-choice__mark")?.textContent).toBe("");
  });

  it("shows audience needs and fit, then personality expression and tone examples", async () => {
    await render(choices(audience));
    expect(host.textContent).toContain("Affordable essentials");
    expect(host.textContent).toContain("Pieces that last");
    expect(host.textContent).toContain(audience.payload.reason);
    await render(choices(personality));
    expect(host.textContent).toContain(personality.payload.expression);
    expect(host.textContent).toContain(personality.payload.toneExample);
    expect(host.textContent).toContain("Thoughtful");
  });

  it("opens evidence separately from the competitor selection", async () => {
    await render();
    const links = [...host.querySelectorAll<HTMLAnchorElement>("a")];
    expect(links.map((link) => link.href)).toEqual([
      "https://studio.example.test/",
      "https://studio.example.test/about",
    ]);
    for (const link of links) {
      expect(link.closest("label")).toBeNull();
      expect(link.target).toBe("_blank");
      expect(link.rel).toContain("noopener");
      await act(async () => {
        link.addEventListener("click", (event) => event.preventDefault(), { once: true });
        link.click();
      });
    }
    expect(host.querySelector<HTMLInputElement>("input")?.checked).toBe(false);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("does not render unsafe provider URLs as links", async () => {
    await render(
      choices({
        ...competitor,
        payload: {
          ...competitor.payload,
          url: "javascript:alert(1)",
          sources: [{ url: "data:text/html,unsafe", title: "Unsafe", retrievedAt: "2026-10-14T10:00:00.000Z" }],
        },
      }),
    );
    expect(host.querySelector("a")).toBeNull();
    expect(host.textContent).toContain(competitor.description);
  });

  it("connects native labels and descriptions and fences selection while disabled", async () => {
    await render(choices(audience), { disabled: true, selectedIds: [audience.id] });
    const input = host.querySelector<HTMLInputElement>("input")!;
    expect(input.labels?.length).toBe(1);
    expect(document.getElementById(input.getAttribute("aria-labelledby")!)?.textContent).toBe(audience.label);
    expect(
      input
        .getAttribute("aria-describedby")!
        .split(" ")
        .map((id) => document.getElementById(id)?.textContent)
        .join(" "),
    ).toContain(audience.description);
    expect(host.querySelector("legend")?.textContent).toBe("Who are you here for?");
    expect(input.disabled).toBe(true);
    await act(async () => input.click());
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("keeps prior answers revisitable from their folded entry without submitting or selecting anything", async () => {
    const onEdit = vi.fn();
    await act(async () =>
      root.render(
        <FoldedAnswer
          label="Audience"
          answers={[{ text: audience.label }]}
          editName="Change answer: Who are you here for?"
          onEdit={onEdit}
        />,
      ),
    );
    const folded = host.querySelector("details")!;
    expect(folded.open).toBe(false);
    expect(folded.querySelector("summary")!.textContent).toContain(audience.label);
    expect(host.querySelector("input")).toBeNull();
    expect(continueButton()).toBeUndefined();
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("does not count stale selection IDs or fabricate empty researched options", async () => {
    expect(selectedOptions(choices(competitor), [], ["an-option-from-another-turn"])).toEqual([]);
    await render(choices(competitor), { selectedIds: ["an-option-from-another-turn"] });
    expect(host.textContent).toContain("0 selected.");
    await render({ ...choices(competitor), options: [] });
    expect(host.querySelectorAll("input").length).toBe(0);
    expect(host.textContent).toContain("No options are available");
    expect(host.textContent).not.toContain("Fixture Studio");
  });
});

describe("waiting and failed steps", () => {
  it("shows skeletons in the final shape while options are written, with no percentage or Stop in the work", async () => {
    await act(async () => root.render(<GuidedChoicesLoading stage="audience" />));
    expect(host.querySelector('[role="status"][aria-busy="true"]')).not.toBeNull();
    expect(host.querySelectorAll(".e-choice")).toHaveLength(3);
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).not.toMatch(/\d+\s?%|complete/i);
  });

  it("shows a quiet empty state with no button after a response did not finish", async () => {
    await act(async () => root.render(<GuidedChoicesEmpty stage="competitors" title="Competitors" research />));
    expect(host.textContent).toContain("No competitors yet");
    expect(host.textContent).toContain("They appear here when the research finishes.");
    expect(host.querySelector("button")).toBeNull();
  });
});
