// @vitest-environment jsdom
import { sessionStandIn, type SessionDoing } from "./session-stand-in";
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/auth/sign-in-form";

const fixture = vi.hoisted(() => ({
  prompt: vi.fn(() => false),
  status: "signed_out" as "signed_out" | "checking" | "ready",
  doing: "nothing" as string,
  awaitingConfirmation: false,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () =>
    sessionStandIn({
      session: { status: fixture.status, generation: 1 },
      doing: fixture.doing as SessionDoing,
      awaitingConfirmation: fixture.awaitingConfirmation,
      signIn: vi.fn(),
      dismissConfirmation() {},
    }),
}));
vi.mock("@/components/workspace/prompt-recovery", () => ({ hasPromptRecovery: () => fixture.prompt() }));

// Inert fixtures: jsdom never sends a form, and no request leaves the test.
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const all = ["google", "apple", "chatgpt"] as const;
const providerForms = () => Array.from(host.querySelectorAll<HTMLFormElement>('form[action^="/api/auth/oauth/"]'));
const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="Continue with ${name}"]`)!;
const password = () => host.querySelector<HTMLInputElement>('input[name="password"]')!;
async function render(props: Partial<ComponentProps<typeof SignInForm>> = {}) {
  await act(async () => root.render(createElement(SignInForm, { configured: true, overlay: true, ...props })));
}
/** A press as the browser reports it to the page; returns whether the form post would go ahead. */
async function press(form: HTMLFormElement) {
  let sent = false;
  await act(async () => {
    sent = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  return sent;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  Object.assign(fixture, { status: "signed_out", doing: "nothing", awaitingConfirmation: false });
  fixture.prompt.mockReturnValue(false);
  fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("draws nothing without enabled providers: no button, no divider, the email form alone", async () => {
  await render();
  expect(providerForms()).toHaveLength(0);
  expect(host.querySelector(".auth-providers")).toBeNull();
  expect(host.textContent).not.toContain("or continue with email");
  expect(host.querySelectorAll("form")).toHaveLength(1);
  await render({ providers: [] });
  expect(host.querySelector(".auth-providers")).toBeNull();
});

it("posts each provider from its own form, named exactly, outside the email form", async () => {
  await render({ providers: all });
  const forms = providerForms();
  expect(forms.map((form) => [form.getAttribute("method"), form.getAttribute("action")])).toEqual([
    ["post", "/api/auth/oauth/google"],
    ["post", "/api/auth/oauth/apple"],
    ["post", "/api/auth/oauth/chatgpt"],
  ]);
  for (const [index, name] of ["Google", "Apple", "ChatGPT"].entries()) {
    const control = forms[index]!.querySelector("button")!;
    expect(control).toBe(button(name));
    expect(control.type).toBe("submit");
    expect(control.textContent).toBe(name);
    expect(control.getAttribute("translate")).toBe("no");
    expect(control.disabled).toBe(false);
    expect(control.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // Only a hidden field: the dialog's first focus still finds Email.
    expect(Array.from(forms[index]!.querySelectorAll("input")).map((field) => [field.type, field.name])).toEqual([
      ["hidden", "next"],
    ]);
    expect(forms[index]!.closest("form form")).toBeNull();
    expect(forms[index]!.parentElement?.closest("form")).toBeNull();
  }
  expect(host.textContent).toContain("or continue with email");
  expect(host.querySelector("form input:not([type=hidden]):not(:disabled)")?.getAttribute("name")).toBe("email");
  // The row sits between the title and the email form.
  const emailForm = host.querySelector('form[aria-label="Sign in"]')!;
  const row = host.querySelector(".auth-providers")!;
  expect(host.querySelector("h1")!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(row.compareDocumentPosition(emailForm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("draws only the enabled providers, in a fixed order, and ignores unknown names", async () => {
  await render({ providers: ["chatgpt", "google", "github" as never] });
  expect(providerForms().map((form) => form.getAttribute("action"))).toEqual([
    "/api/auth/oauth/google",
    "/api/auth/oauth/chatgpt",
  ]);
  expect(button("Apple")).toBeNull();
});

it("returns to Projects, or to Home when an idea is kept", async () => {
  await render({ providers: all });
  expect(providerForms().map((form) => new FormData(form).get("next"))).toEqual(["/brands", "/brands", "/brands"]);
  await act(async () => root.unmount());
  root = createRoot(host);
  fixture.prompt.mockReturnValue(true);
  await render({ providers: all });
  expect(providerForms().map((form) => new FormData(form).get("next"))).toEqual(["/", "/", "/"]);
});

it("appears when creating an account too, with the terms line still about the account", async () => {
  await render({ providers: all, mode: "sign-up" });
  expect(providerForms()).toHaveLength(3);
  expect(host.querySelector(".auth-card__terms")?.textContent).toBe(
    "By creating an account, you agree to the Terms of Service and Privacy Policy.",
  );
  expect(host.querySelectorAll(".auth-card__terms")).toHaveLength(1);
  await act(async () => root.unmount());
  root = createRoot(host);
  await render({ providers: all, mode: "sign-up", overlay: false });
  expect(providerForms()).toHaveLength(3);
});

it("adds a terms line to sign-in only while a provider row is shown", async () => {
  const terms = () => host.querySelector(".auth-card__terms");
  await render();
  expect(terms()).toBeNull();
  await render({ providers: ["github" as never] });
  expect(terms()).toBeNull();
  for (const overlay of [true, false]) {
    await render({ providers: ["apple"], overlay });
    expect(terms()?.textContent).toBe(
      "By continuing with a provider, you agree to the Terms of Service and Privacy Policy.",
    );
    expect(Array.from(terms()!.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual([
      "/terms",
      "/privacy",
    ]);
    expect(host.querySelectorAll(".auth-card__terms")).toHaveLength(1);
  }
  // Gone with the row: while a new confirmation email is requested, and when sign-in is unavailable.
  await render({ providers: all, confirmation: "failed" });
  expect(terms()).not.toBeNull();
  const resend = Array.from(host.querySelectorAll("button")).find(
    (control) => control.textContent === "Send a new confirmation email",
  )!;
  await act(async () => resend.click());
  expect(terms()).toBeNull();
  await act(async () => root.unmount());
  root = createRoot(host);
  await render({ providers: all, configured: false });
  expect(terms()).toBeNull();
});

it("is disabled while the session is checked or an email request is on its way", async () => {
  fixture.status = "checking";
  await render({ providers: all });
  expect(["Google", "Apple", "ChatGPT"].map((name) => button(name).disabled)).toEqual([true, true, true]);
  expect(await press(providerForms()[0]!)).toBe(false);
  await act(async () => root.unmount());
  root = createRoot(host);
  fixture.status = "signed_out";
  fixture.doing = "signing_in";
  await render({ providers: all });
  expect(["Google", "Apple", "ChatGPT"].map((name) => button(name).disabled)).toEqual([true, true, true]);
  expect(await press(providerForms()[1]!)).toBe(false);
});

it("is absent when signed in, when sign-in is unavailable and while an email link is awaited", async () => {
  fixture.status = "ready";
  await render({ providers: all });
  expect(providerForms()).toHaveLength(0);
  await act(async () => root.unmount());
  root = createRoot(host);
  fixture.status = "signed_out";
  await render({ providers: all, configured: false });
  expect(providerForms()).toHaveLength(0);
  await act(async () => root.unmount());
  root = createRoot(host);
  fixture.awaitingConfirmation = true;
  await render({ providers: all, mode: "sign-up" });
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(providerForms()).toHaveLength(0);
});

it("is absent while a new confirmation email is being requested", async () => {
  await render({ providers: all, confirmation: "failed" });
  expect(providerForms()).toHaveLength(3);
  const resend = Array.from(host.querySelectorAll("button")).find(
    (control) => control.textContent === "Send a new confirmation email",
  )!;
  await act(async () => resend.click());
  expect(host.querySelector('form[aria-label="Resend confirmation"]')).not.toBeNull();
  expect(providerForms()).toHaveLength(0);
});

it("sends one post, shows the pressed button as busy and clears the typed password", async () => {
  await render({ providers: all });
  password().value = "inert typed password";
  const [google, apple] = providerForms();
  expect(await press(google!)).toBe(true);
  expect(button("Google").getAttribute("aria-busy")).toBe("true");
  // Busy, not disabled: the post that just started is not withdrawn, and the hidden field still travels.
  expect(button("Google").disabled).toBe(false);
  expect(new FormData(google!).get("next")).toBe("/brands");
  expect(button("Apple").disabled).toBe(true);
  expect(button("ChatGPT").disabled).toBe(true);
  expect(password().value).toBe("");
  expect(await press(google!)).toBe(false);
  expect(await press(apple!)).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it("works again when the browser restores the page after Back from the provider", async () => {
  await render({ providers: all });
  const [google] = providerForms();
  await press(google!);
  await act(async () => {
    const restored = new Event("pageshow");
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
  });
  expect(button("Google").getAttribute("aria-busy")).toBeNull();
  expect(button("Apple").disabled).toBe(false);
  expect(await press(google!)).toBe(true);
});

it("explains a provider sign-in that failed, above buttons that still work", async () => {
  await render({ providers: all, providerFailed: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "We couldn’t sign you in with that provider. Try again, or use your email and password.",
  );
  expect(button("Google").disabled).toBe(false);
  await render({ providers: all });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  // Email still works alone when no provider is enabled any more.
  await render({ providerFailed: true });
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("use your email and password");
  expect(providerForms()).toHaveLength(0);
});
