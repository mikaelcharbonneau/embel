// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/auth/sign-in-form";

const fixture = vi.hoisted(() => ({ signIn: vi.fn(), prompt: vi.fn(() => false) }));
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
vi.mock("@/components/workspace/prompt-recovery", () => ({ hasPromptRecovery: () => fixture.prompt() }));

// Inert fixtures; no request leaves the test.
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>;
const input = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const messageFor = (name: string) => {
  const ids = input(name).getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => document.getElementById(id)?.textContent).join(" ");
};
async function render(mode: "sign-in" | "sign-up" = "sign-in") {
  await act(async () => root.render(createElement(SignInForm, { configured: true, mode, overlay: true })));
}
async function fill(name: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(name), value);
    input(name).dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
  fixture.prompt.mockReturnValue(false);
  fixture.signIn.mockImplementation(async (attempt: () => Promise<void>) => {
    try {
      await attempt();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
  });
  fetcher = vi.fn(async () => Response.json({ error: { code: "invalid_credentials" } }, { status: 401 }));
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

it("uses the app's own messages under each empty field and focuses the first one", async () => {
  await render();
  expect(host.querySelector("form")!.noValidate).toBe(true);
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  expect(input("email").getAttribute("aria-invalid")).toBe("true");
  expect(input("password").getAttribute("aria-invalid")).toBe("true");
  expect(messageFor("email")).toBe("Enter your email address.");
  expect(messageFor("password")).toBe("Enter your password.");
  expect(document.activeElement).toBe(input("email"));
  await fill("email", "x");
  expect(input("email").hasAttribute("aria-invalid")).toBe(false);
});

it("rejects a malformed email in place without sending it", async () => {
  await render();
  await fill("email", "not-an-address");
  await fill("password", "inert password");
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  expect(messageFor("email")).toContain("Enter a valid email address");
});

it("puts a credential mismatch under the password and marks both fields", async () => {
  await render();
  await fill("email", "field-errors@example.invalid");
  await fill("password", "inert password");
  await submit();
  expect(fetcher).toHaveBeenCalledOnce();
  expect(input("email").getAttribute("aria-invalid")).toBe("true");
  expect(input("password").getAttribute("aria-invalid")).toBe("true");
  expect(messageFor("password")).toContain("We couldn't sign you in with those details");
  expect(input("password").value).toBe("");
  // Focus lands on the field to fix, not on the page.
  expect(document.activeElement).toBe(input("password"));
});

it("explains a short and a mismatched new password under their own fields", async () => {
  await render("sign-up");
  expect(messageFor("password")).toBe("Use at least 12 characters.");
  await fill("email", "field-errors@example.invalid");
  await fill("password", "short-pass");
  await fill("confirmPassword", "different");
  await submit();
  expect(fetcher).not.toHaveBeenCalled();
  expect(messageFor("password")).toBe("This password has 10 characters. Use at least 12.");
  expect(messageFor("confirmPassword")).toBe("The two passwords don't match. Enter the same password again.");
  expect(document.activeElement).toBe(input("password"));
  expect(host.textContent).toContain("You'll confirm your email before you sign in.");
});

it("says the idea is kept when a prompt is waiting", async () => {
  fixture.prompt.mockReturnValue(true);
  await render();
  expect(host.querySelector(".auth-card__intro")?.textContent).toBe(
    "Your idea is kept. It will be waiting when you're signed in.",
  );
});
