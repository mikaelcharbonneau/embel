// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DirectionTypeSample } from "@/components/visual-directions/direction-type-sample";

class TestFace {
  static instances: TestFace[] = [];
  status = "loading";
  finish!: () => void;
  fail!: () => void;

  constructor(readonly family: string, readonly source: string, readonly descriptors: FontFaceDescriptors) {
    TestFace.instances.push(this);
  }

  load() {
    return new Promise<void>((resolve, reject) => {
      this.finish = () => { this.status = "loaded"; resolve(); };
      this.fail = () => { this.status = "error"; reject(Error("Font unavailable")); };
    });
  }
}

let host: HTMLDivElement, root: Root;
const faces = new Set<TestFace>();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("FontFace", TestFace);
  TestFace.instances = [];
  faces.clear();
  Object.defineProperty(document, "fonts", { configurable: true, value: faces });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  Reflect.deleteProperty(document, "fonts");
  vi.unstubAllGlobals();
});
async function render(family: string, brandName: string, weight = 600, style = "normal") {
  await act(async () => root.render(<DirectionTypeSample style={{ family, weight, style }} brandName={brandName} />));
}

describe("saved direction type specimen", () => {
  it("shows a mixed-script name in the saved variable font and weight only after the face is loaded", async () => {
    const brandName = "سَنا Studio";
    await render("Noto Sans Arabic", brandName);
    expect(host.querySelector("bdi")).toBeNull();
    expect(TestFace.instances).toHaveLength(1);
    const [face] = TestFace.instances;
    expect(face!.source).toBe('url("/fonts/brand/noto-sans-arabic-variable.ttf")');
    expect(face!.descriptors).toEqual({ style: "normal", weight: "100 900" });
    await act(async () => face!.finish());
    const sample = host.querySelector("bdi")!;
    expect(faces.has(face!)).toBe(true);
    expect(sample.textContent).toBe(brandName);
    expect(sample.dir).toBe("rtl");
    expect(sample.style.fontFamily).toBe(face!.family);
    expect(sample.style.fontWeight).toBe("600");
    await act(async () => root.render(null));
    expect(faces.size).toBe(0);
  });

  it.each([
    ["Lora", "東京", 600, "normal"],
    ["Lora", "Cedar", 900, "normal"],
    ["Lora", "Cedar", 600, "italic"],
    ["Unlisted family", "Cedar", 600, "normal"],
  ] as const)("uses an explicit unavailable state for unsupported %s / %s / %i / %s", async (family, brandName, weight, style) => {
    await render(family, brandName, weight, style);
    expect(host.textContent).toContain("Type sample unavailable");
    expect(host.querySelector("bdi")).toBeNull();
    expect(TestFace.instances).toHaveLength(0);
  });

  it("does not show a system-font substitute when the selected local file fails", async () => {
    await render("Lora", "Cedar");
    await act(async () => TestFace.instances[0]!.fail());
    expect(host.textContent).toContain("Type sample unavailable");
    expect(host.querySelector("bdi")).toBeNull();
    expect(faces.size).toBe(0);
  });

  it("ends a stalled load and ignores a face that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      await render("Lora", "Cedar");
      await act(async () => vi.advanceTimersByTime(15_000));
      expect(host.textContent).toContain("Type sample unavailable");
      await act(async () => TestFace.instances[0]!.finish());
      expect(host.querySelector("bdi")).toBeNull();
      expect(faces.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late font load when the displayed family changes", async () => {
    await render("Lora", "Cedar");
    const first = TestFace.instances[0]!;
    await render("Manrope", "Cedar");
    const second = TestFace.instances[1]!;
    await act(async () => first.finish());
    expect(faces.size).toBe(0);
    expect(host.querySelector("bdi")).toBeNull();
    await act(async () => second.finish());
    expect(faces.has(second)).toBe(true);
    expect(host.querySelector("bdi")?.style.fontFamily).toBe(second.family);
  });

  it("reuses a loaded variable face when the parent changes its sample text or weight", async () => {
    await render("Lora", "Cedar", 400);
    await act(async () => TestFace.instances[0]!.finish());
    await render("Lora", "Cèdre", 700);
    const sample = host.querySelector("bdi")!;
    expect(TestFace.instances).toHaveLength(1);
    expect(faces.size).toBe(1);
    expect(sample.textContent).toBe("Cèdre");
    expect(sample.style.fontWeight).toBe("700");
  });
});
