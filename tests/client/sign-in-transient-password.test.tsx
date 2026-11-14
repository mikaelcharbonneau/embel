// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignInForm } from "@/components/auth/sign-in-form";

const fixture = vi.hoisted(() => ({ signIn: vi.fn(), replace: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: fixture.replace, refresh: fixture.refresh }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, onClick }: { children: React.ReactNode; href: string; onClick?: () => void }) =>
    createElement("a", { href, onClick }, children),
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

// Inert transport only; no browser or Supabase request is made.
const email = "transient-fixture@example.invalid",
  password = "  inert password with spaces  ";
let root: Root, host: HTMLDivElement, fetcher: ReturnType<typeof vi.fn>, release: (response: Response) => void;
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
async function render(mode: "sign-in" | "sign-up" = "sign-in") {
  await act(async () => root.render(createElement(SignInForm, { configured: true, mode })));
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
async function finish(status: number) {
  await act(async () => {
    release(
      Response.json(status === 200 ? { authenticated: true } : { error: { code: "synthetic_error" } }, { status }),
    );
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.replace.mockReset();
  fixture.refresh.mockReset();
  fixture.signIn.mockImplementation(async (attempt: () => Promise<void>) => {
    try {
      await attempt();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "failed", error };
    }
  });
  fetcher = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("password visibility", () => {
  const toggle = () => host.querySelector<HTMLButtonElement>(".auth-password-toggle")!;
  it("shows the password only on request and masks it again before the request is sent", async () => {
    await render();
    await fill("email", email);
    await fill("password", password);
    expect(toggle().type).toBe("button");
    expect(toggle().getAttribute("aria-label")).toBe("Show password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().getAttribute("aria-controls")).toBe(field("password").id);
    await act(async () => toggle().click());
    expect(field("password").type).toBe("text");
    expect(field("password").value).toBe(password);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(field("password").getAttribute("spellcheck")).toBe("false");
    expect(fetcher).not.toHaveBeenCalled();
    await submit();
    expect(field("password").type).toBe("password");
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reveals both new-password fields together and masks them again on submit", async () => {
    await render("sign-up");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-label")).toBe("Show passwords");
    expect(field("password").type).toBe("text");
    expect(field("confirmPassword").type).toBe("text");
    await fill("email", email);
    await fill("password", password);
    await fill("confirmPassword", "different password value");
    await submit();
    expect(field("password").type).toBe("password");
    expect(field("confirmPassword").type).toBe("password");
    // Owner decision (D-072): a mismatch keeps what was typed; nothing is sent.
    expect(field("password").value).toBe(password);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the password label exact and leaves no account-saving footnote", async () => {
    await render();
    expect(field("password").labels?.[0]?.textContent).toBe("Password");
    expect(host.textContent).not.toContain("save to your account");
  });
});

describe("transient sign-in keeps only the same mounted masked input", () => {
  it("retains a 503 password without storage or resubmission, then clears it after an explicit successful retry", async () => {
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await render();
    await fill("email", ` ${email} `);
    await fill("password", password);
    await submit();
    expect(field("password").type).toBe("password");
    expect(field("password").value).toBe(password);
    await finish(503);
    expect(field("password").value).toBe(password);
    expect(host.textContent).toContain("Sign-in is unavailable right now");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(storage).not.toHaveBeenCalled();
    expect(host.innerHTML).not.toContain(password);
    await submit();
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [, init] of fetcher.mock.calls) expect(JSON.parse(String(init.body))).toEqual({ email, password });
    await finish(200);
    expect(field("password").value).toBe("");
    expect(fixture.replace).toHaveBeenCalledWith("/brands");
  });

  it.each([401, 403, 413, 422, 429, 500, 502])(
    "clears the password after a non-transient %s response",
    async (status) => {
      await render();
      await fill("email", email);
      await fill("password", password);
      await submit();
      await finish(status);
      expect(field("password").value).toBe("");
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("clears on email changes and cannot restore the previous secret after a late 503", async () => {
    await render();
    await fill("email", email);
    await fill("password", password);
    await submit();
    await fill("email", "different-fixture@example.invalid");
    expect(field("password").value).toBe("");
    await finish(503);
    expect(field("password").value).toBe("");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("clears on mode change and does not apply the previous sign-in result to that mode", async () => {
    await render();
    await fill("email", email);
    await fill("password", password);
    await submit();
    await render("sign-up");
    expect(field("password").value).toBe("");
    expect(field("confirmPassword").value).toBe("");
    await finish(503);
    expect(field("password").value).toBe("");
    expect(host.textContent).not.toContain("Sign-in is unavailable right now");
  });

  it("clears detached password nodes on dismissal and never restores them into a remounted form", async () => {
    await render();
    await fill("email", email);
    await fill("password", password);
    await submit();
    const detached = field("password");
    await act(async () => root.unmount());
    expect(detached.value).toBe("");
    root = createRoot(host);
    await render();
    await finish(503);
    expect(detached.value).toBe("");
    expect(field("password").value).toBe("");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps signup's existing clear-before-submit and clear-on-error behavior", async () => {
    await render("sign-up");
    await fill("email", email);
    await fill("password", password);
    await fill("confirmPassword", password);
    await submit();
    expect(field("password").value).toBe("");
    expect(field("confirmPassword").value).toBe("");
    await finish(503);
    expect(field("password").value).toBe("");
    expect(field("confirmPassword").value).toBe("");
  });
});
