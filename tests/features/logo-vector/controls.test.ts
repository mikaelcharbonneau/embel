import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LogoManualEdit } from "../../../src/domain/logo-vector";
import { ComponentControls } from "../../../src/features/logo-vector/components/component-controls";
import { separatedLogoDocument } from "./fixtures";

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

describe("local component controls", () => {
  it("retains numeric draft text and commits bounded signed or fractional edits only on blur", () => {
    const edits: LogoManualEdit[] = [];
    const document = separatedLogoDocument();
    const render = () => ComponentControls({ document, componentId: "synthetic-symbol", lockedComponentIds: [], onEdit: edit => edits.push(edit) });
    const nodes = elements(render());
    const size = nodes.find(node => node.props["aria-label"] === "Component scale")!;
    // A model-controlled value would restore the old number over empty/intermediate native input.
    expect(size.props.value).toBeUndefined();
    expect(size.props.defaultValue).toBe(1);
    const input = {
      value: "", validationMessage: "", min: "0.01", max: "100",
      setCustomValidity(message: string) { this.validationMessage = message; },
      reportValidity() { return this.validationMessage === ""; },
    };
    const change = size.props.onChange as (event: unknown) => void;
    const blur = size.props.onBlur as (event: unknown) => void;
    for (const value of ["", "-", "0", "0.", "0.5"]) { input.value = value; change({ currentTarget: input }); }
    expect(edits).toEqual([]);
    blur({ currentTarget: input });
    expect(edits).toEqual([{ kind: "size", componentId: "synthetic-symbol", scale: .5 }]);
    input.value = "0"; blur({ currentTarget: input });
    expect(input.value).toBe("0");
    expect(input.validationMessage).not.toBe("");
    expect(edits).toHaveLength(1);
    const rotation = nodes.find(node => node.props["aria-label"] === "Component rotation")!;
    input.value = "-12.5";
    (rotation.props.onBlur as (event: unknown) => void)({ currentTarget: input });
    expect(edits[1]).toEqual({ kind: "rotation", componentId: "synthetic-symbol", degrees: -12.5 });
    const position = nodes.find(node => node.props["aria-label"] === "Component X position")!;
    input.value = "-.5";
    (position.props.onBlur as (event: unknown) => void)({ currentTarget: input });
    expect(edits[2]).toEqual({ kind: "arrangement", placements: [{ componentId: "synthetic-symbol", transform: { x: -.5, y: 0, scale: 1, rotation: 0 } }], order: ["synthetic-symbol", "synthetic-lettering"] });
    document.components[0]!.transform.scale = .5;
    const updated = elements(render()).find(node => node.props["aria-label"] === "Component scale")!;
    expect(updated.key).not.toBe(size.key);
    expect(updated.props.defaultValue).toBe(.5);
    const lock = nodes.find(node => node.type === "button" && node.props["aria-pressed"] === false)!;
    (lock.props.onClick as () => void)();
    expect(edits[3]).toEqual({ kind: "locks", componentIds: ["synthetic-symbol"] });
  });
  it("disables geometry while locked and explains unavailable text controls", () => {
    const html = renderToStaticMarkup(createElement(ComponentControls, { document: separatedLogoDocument(), componentId: "synthetic-lettering", lockedComponentIds: ["synthetic-lettering"], onEdit: () => {} }));
    expect(html).toContain("Unlock component");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("Outlined lettering");
    expect(html).toContain("Font editing is unavailable");
  });
  it("does not emit numeric edits for unchanged or equivalent values on blur", () => {
    const edits: LogoManualEdit[] = [], nodes = elements(ComponentControls({ document: separatedLogoDocument(), componentId: "synthetic-symbol", lockedComponentIds: [], onEdit: edit => edits.push(edit) }));
    for (const [label, values] of [["Component scale", ["1", "1.0", "1e0"]], ["Component rotation", ["0", "0.0", "-0"]], ["Component X position", ["0", "0.0"]], ["Component Y position", ["0", "0.0"]]] as const) {
      const control = nodes.find(node => node.props["aria-label"] === label)!;
      for (const value of values) (control.props.onBlur as (event: unknown) => void)({ currentTarget: { value, setCustomValidity() {}, reportValidity() {} } });
    }
    expect(edits).toEqual([]);
  });
});
