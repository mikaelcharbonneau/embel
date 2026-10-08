import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LogoInputsView } from "@/features/logo-inputs/components/logo-inputs-panel";
import type { LogoInputsController, LogoInputsState, LogoInputClient } from "@/features/logo-inputs/client/controller";
import { syntheticLogoWorkspace, syntheticLogoReferences } from "../../fixtures/logo-creation";
const empty: LogoInputsState = { busy: false, loading: false, references: [], fonts: [], catalog: [], referenceCursor: null, requestCursor: null, unresolved: [], pending: null, pendingStatus: null, hasOriginalFile: false, message: null, error: null };
function render(canWrite: boolean, changes: Partial<LogoInputsState> = {}) {
  const state = { ...empty, ...changes };
  const controller = { getSnapshot: () => state, subscribe: () => () => undefined } as unknown as LogoInputsController;
  return renderToStaticMarkup(createElement(LogoInputsView, { controller, client: {} as LogoInputClient, canWrite, isCurrent: () => true, selections: [], onSelectionsChange: () => undefined }));
}
describe("truthful owned input controls", () => {
  it("keeps unavailable storage and curated sources explicit without a simulated successful import", () => {
    const html = render(false);
    expect(html).toContain("source and display and processing rights");
    expect(html).toContain("Connected owned storage is required");
    expect(html).toMatch(/type="file"[^>]*disabled/);
    expect(html).not.toContain("Reference saved");
  });
  it("requires an unchecked declaration, actual license and separate reviewed catalog action", () => {
    const html = render(true);
    expect(html).toContain("32 MiB"); expect(html).toContain("10 MiB"); expect(html).toContain("Actual font license text");
    expect(html).toContain("until the license is reviewed"); expect(html).toContain("Paid fonts are not offered");
    expect(html).not.toContain("checked=");
  });
});

it("allows saved reference edits while new uploads are unavailable", () => {
 const workspace=syntheticLogoWorkspace(),reference={...syntheticLogoReferences()[1]!,workspace};
 const state={...empty,references:[reference]}; const controller={getSnapshot:()=>state,subscribe:()=>()=>undefined} as unknown as LogoInputsController;
 const html=renderToStaticMarkup(createElement(LogoInputsView,{workspace,controller,client:{} as LogoInputClient,canWrite:true,isCurrent:()=>true,selections:[],onSelectionsChange:()=>{}}));
 expect(html).toContain("Connected owned storage is required");
 expect(html).toMatch(/type="file"[^>]*disabled/);
 const savedFieldset=html.match(/<fieldset([^>]*)><legend>Uploaded reference 1<\/legend>/);
 expect(savedFieldset).not.toBeNull();expect(savedFieldset![1]).not.toContain("disabled");
});
