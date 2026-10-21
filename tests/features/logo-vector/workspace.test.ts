import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountSessionProvider } from "@/components/workspace/account-session";
import { LogoDraftMemoryProvider } from "@/components/identity/logo-draft-memory-context";
import { createLogoDraftMemory } from "@/components/identity/logo-draft-memory";
import { LogoEditorWorkspace } from "../../../src/features/logo-vector/components/logo-editor-workspace";

function render(projectId: string) {
  const memoryProps = { memory: createLogoDraftMemory(), children: null };
  return renderToStaticMarkup(createElement(AccountSessionProvider, null,
    createElement(LogoDraftMemoryProvider, memoryProps, createElement(LogoEditorWorkspace, { projectId })),
  ));
}
describe("official logo editor wrapper", () => {
  it("uses actual account status and hides vector content until the account is verified", () => {
    const html = render("00000000-0000-4000-8000-000000000001");
    expect(html).toContain("Checking your account");
    expect(html).toContain("Review your vector logo");
    expect(html).toContain('href="/brands/account/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain("Back to project");
    expect(html).not.toContain('aria-current="page"');
    expect(html).not.toContain("/logo/editor");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("synthetic");
  });
  it("handles an invalid route project without fabricating a workspace", () => {
    const html = render("invalid-project");
    expect(html).toContain("Logo workspace not found");
    expect(html).not.toContain("<svg");
  });
});
