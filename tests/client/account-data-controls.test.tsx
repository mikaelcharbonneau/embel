// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogMethods } from "../helpers/dialog-methods";

const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const fixture = vi.hoisted(() => ({
  email: "Person@Example.invalid" as string | null,
  signOut: vi.fn(async () => ({ ok: true })),
  replace: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({
    session: { status: "ready", userId: owner, generation: 1 },
    signOut: fixture.signOut,
  }),
}));
vi.mock("@/components/workspace/account-profile-provider", () => ({
  useAccountProfile: () => ({ workspace: { saved: { ownerId: owner, email: fixture.email } } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: fixture.replace }) }));
import { AccountDataControls } from "@/components/workspace/account-data-controls";

let root: Root, host: HTMLDivElement, restoreDialogs: () => void, fetcher: ReturnType<typeof vi.fn>;
const button = (label: string) =>
  [...document.querySelectorAll("button")].find((node) => node.textContent === label) as HTMLButtonElement;
const input = () => document.querySelector<HTMLInputElement>('dialog input[type="email"]')!;
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function open() {
  await act(async () => root.render(createElement(AccountDataControls)));
  await act(async () => button("Delete account").click());
}

beforeEach(() => {
  restoreDialogs = installDialogMethods();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.email = "Person@Example.invalid";
  fixture.signOut.mockClear();
  fixture.replace.mockClear();
  fetcher = vi.fn(async () => Response.json({ deleted: true }));
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreDialogs();
  vi.unstubAllGlobals();
});

describe("Delete account confirmation", () => {
  it("names what is lost, starts on Cancel and turns the danger button on only when the email matches", async () => {
    await open();
    const dialog = document.querySelector("dialog")!;
    expect(dialog.querySelector("h2")?.textContent).toBe("Delete your account?");
    expect(dialog.textContent).toContain("This can’t be undone.");
    expect(dialog.textContent).toContain("Your email is Person@Example.invalid.");
    expect(document.activeElement).toBe(button("Cancel"));
    const confirm = [...dialog.querySelectorAll("button")].find((node) => node.textContent === "Delete account")!;
    expect(confirm.className).toContain("e-button--danger-filled");
    expect(confirm.disabled).toBe(true);
    await type("someone@example.invalid");
    expect(confirm.disabled).toBe(true);
    // The server compares trimmed, case-insensitive; so does the button.
    await type("  person@example.INVALID ");
    expect(confirm.disabled).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the same deletion request, then signs out and leaves Settings", async () => {
    await open();
    await type(" person@example.invalid ");
    const confirm = [...document.querySelectorAll("dialog button")].find(
      (node) => node.textContent === "Delete account",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    expect(fetcher).toHaveBeenCalledOnce();
    const [path, init] = fetcher.mock.calls[0]!;
    expect(path).toBe("/api/account/deletion");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", mode: "same-origin", cache: "no-store" });
    expect(new Headers(init.headers).get("X-Embel-Account")).toBe(owner);
    expect(JSON.parse(init.body)).toEqual({ confirmEmail: "person@example.invalid" });
    expect(fixture.signOut).toHaveBeenCalledWith(true);
    expect(fixture.replace).toHaveBeenCalledWith("/");
    expect(document.querySelector("dialog h2")?.textContent).toBe("Account deleted");
  });

  it("keeps the dialog open with the failure inside it", async () => {
    fetcher.mockImplementation(async () =>
      Response.json({ error: { code: "reauthentication_required" } }, { status: 403 }),
    );
    await open();
    await type("person@example.invalid");
    const confirm = [...document.querySelectorAll("dialog button")].find(
      (node) => node.textContent === "Delete account",
    ) as HTMLButtonElement;
    await act(async () => confirm.click());
    const alert = document.querySelector('dialog [role="alert"]')!;
    expect(alert.textContent).toBe(
      "For your security, sign in again before deleting your account. Then come back to Settings.",
    );
    expect(input().getAttribute("aria-invalid")).toBe("true");
    expect(fixture.signOut).not.toHaveBeenCalled();
  });

  it("lets the server compare when the account email is not known here", async () => {
    fixture.email = null;
    await open();
    expect(document.querySelector("dialog")!.textContent).toContain("Type the email you sign in with.");
    await type("anything@example.invalid");
    const confirm = [...document.querySelectorAll("dialog button")].find(
      (node) => node.textContent === "Delete account",
    ) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });
});
