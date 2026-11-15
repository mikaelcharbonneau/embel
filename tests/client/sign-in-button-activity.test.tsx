// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/auth/sign-in-form";

const fixture = vi.hoisted(() => ({ signIn: vi.fn(), signingIn: false }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: { status: "signed_out", generation: 1 },
    signIn: fixture.signIn,
    signingIn: fixture.signingIn,
    awaitingConfirmation: false,
    dismissConfirmation() {},
  }),
}));
vi.mock("@/components/workspace/prompt-recovery", () => ({ hasPromptRecovery: () => false }));

// Inert fixtures; no request leaves the test.
let root: Root, host: HTMLDivElement, finish: (value: unknown) => void;
const button = (label: string) => [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
const input = (selector: string) => host.querySelector<HTMLInputElement>(selector)!;
async function render() {
  await act(async () =>
    root.render(createElement(SignInForm, { configured: true, mode: "sign-in", confirmation: "failed" })),
  );
}
async function fill(node: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Sends the form and lets the account report the request as under way, as the session provider does. */
async function send(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  fixture.signingIn = true;
  await render();
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  fixture.signingIn = false;
  fixture.signIn.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await render();
  await act(async () => button("Send a new confirmation email").click());
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("shows activity only on Resend confirmation while a confirmation email is sent", async () => {
  await fill(input('form[aria-label="Resend confirmation"] input[name="email"]'), "person@example.com");
  await send(host.querySelector<HTMLFormElement>('form[aria-label="Resend confirmation"]')!);
  expect(fixture.signIn).toHaveBeenCalledOnce();
  expect(button("Resend confirmation").getAttribute("aria-busy")).toBe("true");
  expect(button("Sign in").getAttribute("aria-busy")).toBeNull();
  expect(button("Sign in").disabled).toBe(true);
  fixture.signingIn = false;
  await act(async () => finish({ ok: true, confirmationRequired: true }));
  expect(button("Resend confirmation").getAttribute("aria-busy")).toBeNull();
  expect(button("Sign in").disabled).toBe(false);
});

it("shows activity only on Sign in while signing in", async () => {
  await fill(input('form[aria-label="Sign in"] input[name="email"]'), "person@example.com");
  await fill(input('form[aria-label="Sign in"] input[name="password"]'), "a synthetic password");
  await send(host.querySelector<HTMLFormElement>('form[aria-label="Sign in"]')!);
  expect(fixture.signIn).toHaveBeenCalledOnce();
  expect(button("Sign in").getAttribute("aria-busy")).toBe("true");
  expect(button("Resend confirmation").getAttribute("aria-busy")).toBeNull();
  expect(button("Resend confirmation").disabled).toBe(true);
});
