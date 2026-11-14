// @vitest-environment jsdom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn(), prompt: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }) }));
vi.mock("next/link", () => ({
  default: ({ children, href, onClick, className }: ComponentProps<"a">) =>
    createElement("a", { href, className, onClick }, children),
}));
vi.mock("../../src/components/workspace/prompt-recovery", () => ({ hasPromptRecovery: () => Boolean(mocks.prompt()) }));
import { AccountSessionProvider } from "../../src/components/workspace/account-session";
import { SignInForm } from "../../src/components/auth/sign-in-form";

let host: HTMLDivElement;
let root: Root;
let createResponse: () => Promise<Response>;
let resendResponse: () => Promise<Response>;
let requestBodies: { path: string; body: unknown }[];
let authed: boolean;
const email = "client-signup@example.invalid";
const password = "  synthetic signup password  ";
const pending = { authenticated: false, confirmationRequired: true };
async function until(assert: () => void) {
  let error: unknown;
  for (let i = 0; i < 80; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    try {
      assert();
      return;
    } catch (next) {
      error = next;
    }
  }
  throw error;
}
async function render(
  mode: "sign-in" | "sign-up" = "sign-up",
  configured = true,
  confirmation?: "failed" | "complete",
) {
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <SignInForm key={mode} mode={mode} configured={configured} confirmation={confirmation} />
      </AccountSessionProvider>,
    ),
  );
  if (configured) await until(() => expect(host.querySelector("fieldset")?.disabled).toBe(false));
}
function fields() {
  return {
    email: host.querySelector<HTMLInputElement>('form input[name="email"]')!,
    password: host.querySelector<HTMLInputElement>('input[name="password"]')!,
    confirm: host.querySelector<HTMLInputElement>('input[name="confirmPassword"]')!,
  };
}
function fill(repeated = password) {
  const inputs = fields();
  inputs.email.value = email;
  inputs.password.value = password;
  if (inputs.confirm) inputs.confirm.value = repeated;
  return inputs;
}
async function submit(form = host.querySelector("form")!) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  authed = false;
  requestBodies = [];
  createResponse = async () => Response.json(pending);
  resendResponse = async () => Response.json(pending);
  mocks.prompt.mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/session")
        return authed
          ? Response.json({ user: { id: "aaaaaaaa-1111-4111-8111-111111111111" } })
          : Response.json({ error: { code: "unauthenticated" } }, { status: 401 });
      requestBodies.push({ path, body: JSON.parse(String(init?.body)) });
      if (path === "/api/auth/sign-up") return createResponse();
      if (path === "/api/auth/resend-confirmation") return resendResponse();
      throw new Error("Unexpected synthetic request");
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("checks repeated passwords and clears both fields without sending a mismatched signup", async () => {
  await render();
  const inputs = fill("different synthetic password");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("passwords don’t match");
  expect(inputs.password.value).toBe("");
  expect(inputs.confirm.value).toBe("");
  expect(requestBodies).toEqual([]);
});
it("clears credentials immediately, admits one request, preserves recovery and announces pending confirmation", async () => {
  mocks.prompt.mockReturnValue({ id: "synthetic-draft-id" });
  localStorage.setItem("synthetic-draft", "Retained browser work");
  let release!: (response: Response) => void;
  createResponse = () =>
    new Promise((done) => {
      release = done;
    });
  await render();
  const inputs = fill();
  const form = host.querySelector("form")!;
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  expect(inputs.password.value).toBe("");
  expect(inputs.confirm.value).toBe("");
  expect(form.getAttribute("aria-busy")).toBe("true");
  expect(requestBodies).toEqual([{ path: "/api/auth/sign-up", body: { email, password } }]);
  expect(host.querySelector('a[href="/sign-in"]')).toBeNull();
  await act(async () => release(Response.json(pending)));
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(document.activeElement).toBe(host.querySelector("h1"));
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(host.textContent).toContain("Your idea is kept. It will be waiting when you’re signed in.");
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(localStorage.getItem("synthetic-draft")).toBe("Retained browser work");
  const storage = JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } });
  expect(storage).not.toContain(email);
  expect(storage).not.toContain(password);
});
it("clears password fields when switching between creation and sign-in", async () => {
  await render();
  const creationFields = fill();
  const signIn = host.querySelector<HTMLAnchorElement>('a[href="/sign-in"]')!;
  signIn.addEventListener("click", (event) => event.preventDefault());
  await act(async () => signIn.click());
  expect(creationFields.password.value).toBe("");
  expect(creationFields.confirm.value).toBe("");
  await render("sign-in");
  expect(fields().password.autocomplete).toBe("current-password");
  fields().password.value = password;
  const create = host.querySelector<HTMLAnchorElement>('a[href="/sign-up"]')!;
  create.addEventListener("click", (event) => event.preventDefault());
  await act(async () => create.click());
  expect(fields().password.value).toBe("");
  await render();
  expect(fields().password.autocomplete).toBe("new-password");
  expect(fields().password.value).toBe("");
});
it("clears recreated password inputs when leaving a second account attempt", async () => {
  await render();
  fill();
  await submit();
  const useAnother = [...host.querySelectorAll("button")].find((button) => button.textContent === "Use another email")!;
  await act(async () => useAnother.click());
  const inputs = fill();
  await render("sign-in");
  expect(inputs.password.value).toBe("");
  expect(inputs.confirm.value).toBe("");
});
it("keeps modal labels unique when an auth page is retained beneath it", async () => {
  await act(async () =>
    root.render(
      <AccountSessionProvider>
        <SignInForm configured />
        <SignInForm configured mode="sign-up" overlay />
      </AccountSessionProvider>,
    ),
  );
  await until(() => expect(host.querySelector("fieldset")?.disabled).toBe(false));
  const ids = [...host.querySelectorAll("[id]")].map((element) => element.id);
  expect(new Set(ids).size).toBe(ids.length);
  // Each label names the input it sits beside, inside the same form.
  for (const label of host.querySelectorAll<HTMLLabelElement>("label")) {
    expect(label.control).toBeInstanceOf(HTMLInputElement);
    expect(label.control?.id).toBe(label.htmlFor);
    expect(label.control?.closest("form")).toBe(label.closest("form"));
  }
});
it("sanitizes rate limits and malformed responses, retains the form, then recovers on an explicit retry", async () => {
  createResponse = async () =>
    Response.json({ error: { message: "private provider detail email exists" } }, { status: 429 });
  await render();
  fill();
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Too many account attempts");
  expect(host.textContent).not.toContain("private provider");
  expect(fields().password.value).toBe("");
  createResponse = async () => Response.json({ authenticated: true, access_token: "private" });
  fill();
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("couldn’t be verified");
  expect(mocks.replace).not.toHaveBeenCalled();
  createResponse = async () => Response.json(pending);
  fill();
  await submit();
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(requestBodies).toHaveLength(3);
});
it("resends without storing or resubmitting a password and recovers an expired link", async () => {
  await render("sign-in", true, "failed");
  expect(host.textContent).toContain("newest email link");
  const requestEmail = [...host.querySelectorAll("button")].find(
    (button) => button.textContent === "Send a new confirmation email",
  )!;
  await act(async () => requestEmail.click());
  const form = host.querySelector<HTMLFormElement>('form[aria-label="Resend confirmation"]')!;
  form.querySelector<HTMLInputElement>('input[name="email"]')!.value = email;
  await submit(form);
  expect(requestBodies).toEqual([{ path: "/api/auth/resend-confirmation", body: { email } }]);
  expect(host.textContent).toContain("If this address is awaiting confirmation");
  expect(form.querySelector<HTMLInputElement>('input[name="email"]')!.value).toBe("");
  expect(mocks.replace).not.toHaveBeenCalled();
});
it("continues recovered prompts after a verified immediate-session outcome", async () => {
  mocks.prompt.mockReturnValue({ id: "synthetic-draft-id" });
  createResponse = async () => {
    authed = true;
    return Response.json({ authenticated: true });
  };
  await render();
  fill();
  await submit();
  expect(mocks.replace).toHaveBeenCalledExactlyOnceWith("/");
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("disables account creation when the server configuration is unavailable", async () => {
  await render("sign-up", false);
  expect(host.textContent).toContain("Account creation is unavailable right now");
  expect(host.querySelector("fieldset")?.disabled).toBe(true);
  fill();
  await submit();
  expect(requestBodies).toEqual([]);
});
