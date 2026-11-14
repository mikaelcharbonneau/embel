// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/auth/sign-in-form";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

const fixture = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => createElement("a", { href }, children),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: { status: "signed_out", generation: 1 },
    signIn: fixture.signIn,
    signingIn: false,
    awaitingConfirmation: false,
    dismissConfirmation() {},
  }),
}));
vi.mock("@/components/workspace/prompt-recovery", () => ({ hasPromptRecovery: () => false }));
vi.mock("@/components/ui/auth-artwork", () => ({ AuthArtwork: () => null }));
vi.mock("@/components/ui/icon", () => ({ Icon: () => null, EmbelMark: () => null }));

// Inert fixtures. A fake Turnstile API stands in for Cloudflare's script; no network is used.
const email = "captcha-form@example.invalid",
  password = "inert form password";
const plainMessage = "The security check didn't pass. Please try again.";
type WidgetOptions = { callback: (token: string) => void; "error-callback": () => void };
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
let turnstile: { render: ReturnType<typeof vi.fn>; reset: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let options: WidgetOptions;
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
async function mount(element: React.ReactElement) {
  await act(async () => root.render(element));
}
async function fill(name: string, value: string) {
  await act(async () => {
    const node = field(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
const sentBody = () => JSON.parse(fetcher.mock.calls[0]![1].body as string);
const alertText = () => host.querySelector('[role="alert"]')?.textContent;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.signIn.mockImplementation(async (attempt: () => Promise<void>) => {
    try {
      await attempt();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
  });
  fetcher = vi.fn(async (path: string) =>
    Response.json(path.includes("password-reset") ? { requested: true } : { authenticated: true }),
  );
  vi.stubGlobal("fetch", fetcher);
  turnstile = {
    render: vi.fn((_el: HTMLElement, o: WidgetOptions) => {
      options = o;
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as unknown as { turnstile: unknown }).turnstile = turnstile;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as { turnstile?: unknown }).turnstile;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("with no site key", () => {
  it("renders no widget, loads no script and sends no token", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    await mount(createElement(SignInForm, { configured: true }));
    expect(turnstile.render).not.toHaveBeenCalled();
    expect(host.querySelector(".auth-captcha")).toBeNull();
    expect(document.querySelector('script[src*="challenges.cloudflare.com"]')).toBeNull();
    await fill("email", email);
    await fill("password", password);
    await submit();
    expect(sentBody()).toEqual({ email, password });
  });

  it("password reset sends only the email", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    await mount(createElement(ForgotPasswordForm, { configured: true }));
    await fill("email", email);
    await submit();
    expect(sentBody()).toEqual({ email });
  });
});

describe("with a site key", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "inert-site-key"));

  it("renders the widget, waits for a token, forwards it, then resets it after the attempt", async () => {
    await mount(createElement(SignInForm, { configured: true }));
    expect(turnstile.render).toHaveBeenCalledOnce();
    expect(turnstile.render.mock.calls[0]![1]).toMatchObject({ sitekey: "inert-site-key" });
    await fill("email", email);
    await fill("password", password);
    await submit();
    expect(fetcher).not.toHaveBeenCalled();
    expect(alertText()).toContain("security check");
    await act(async () => options.callback("inert-token"));
    await submit();
    expect(sentBody()).toEqual({ email, password, captchaToken: "inert-token" });
    expect(turnstile.reset).toHaveBeenCalledWith("widget-1");
  });

  it("does not reuse a spent token on a second attempt", async () => {
    await mount(createElement(SignInForm, { configured: true }));
    await fill("email", email);
    await fill("password", password);
    await act(async () => options.callback("inert-token"));
    await submit();
    expect(fetcher).toHaveBeenCalledOnce();
    await fill("password", password);
    await submit();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("includes the token in sign-up requests", async () => {
    await mount(createElement(SignInForm, { configured: true, mode: "sign-up" }));
    const strong = password + " long";
    await fill("email", email);
    await fill("password", strong);
    await fill("confirmPassword", strong);
    await act(async () => options.callback("signup-token"));
    await submit();
    expect(sentBody()).toMatchObject({ email, captchaToken: "signup-token" });
  });

  it("includes the token in password reset requests and explains a widget that failed to load", async () => {
    await mount(createElement(ForgotPasswordForm, { configured: true }));
    await fill("email", email);
    await act(async () => options["error-callback"]());
    await submit();
    expect(alertText()).toContain("couldn't load");
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => options.callback("reset-token"));
    await submit();
    expect(sentBody()).toEqual({ email, captchaToken: "reset-token" });
    expect(turnstile.reset).toHaveBeenCalled();
  });

  it("maps a captcha failure to a plain message on reset and sign-in", async () => {
    await mount(createElement(ForgotPasswordForm, { configured: true }));
    await fill("email", email);
    await act(async () => options.callback("reset-token"));
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "captcha_failed" } }, { status: 400 }));
    await submit();
    expect(alertText()).toBe(plainMessage);

    await act(async () => root.unmount());
    root = createRoot(host);
    await mount(createElement(SignInForm, { configured: true }));
    await fill("email", email);
    await fill("password", password);
    await act(async () => options.callback("inert-token"));
    fetcher.mockResolvedValueOnce(Response.json({ error: { code: "captcha_failed" } }, { status: 400 }));
    await submit();
    expect(alertText()).toBe(plainMessage);
  });
});
