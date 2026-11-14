// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDialogMethods } from "../helpers/dialog-methods";
import { DEFAULT_PROFILE_VALUES, PROFILE_TIME_ZONES } from "@/domain/account-profile";

const fixture = vi.hoisted(() => ({
  session: { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 } as {
    status: string;
    userId?: string;
    generation: number;
  },
  profile: {} as Record<string, unknown>,
  edit: vi.fn(),
  save: vi.fn(),
  discard: vi.fn(),
  reload: vi.fn(),
  keepEdits: vi.fn(),
  usageMount: vi.fn(),
  usageUnmount: vi.fn(),
  localAI: vi.fn(),
  checkAccount: vi.fn(),
}));
vi.mock("@/components/workspace/account-session", () => ({
  useAccountSession: () => ({ session: fixture.session }),
  AccountStatus: () => createElement("p", null, "Synthetic account status"),
}));
vi.mock("@/components/workspace/account-profile-provider", () => ({
  useAccountProfile: () => fixture.profile,
  PROFILE_SAVE_FAILED: "Couldn’t save. Check your connection.",
}));
// The plan card reads /api/billing; its own behavior is covered with the Plans page.
vi.mock("@/components/billing/plan-credits-card", () => ({ PlanCreditsCard: () => null }));
vi.mock("@/components/workspace/account-access", () => ({
  AccountAccess: () => createElement("button", { type: "button", onClick: fixture.checkAccount }, "Sign out"),
}));
vi.mock("@/components/workspace/recorded-usage", () => ({
  RecordedUsageSection: ({ active }: { active: boolean }) => {
    useEffect(() => {
      fixture.usageMount();
      return () => {
        fixture.usageUnmount();
      };
    }, []);
    return createElement(
      "section",
      { className: "recorded-usage", "aria-labelledby": "recorded-usage-title", "data-active": String(active) },
      createElement("h2", { id: "recorded-usage-title" }, "Recent requests"),
      createElement("p", null, "Synthetic recent usage history"),
    );
  },
}));
import { SettingsWorkspace } from "@/components/workspace/settings-workspace";

// Synthetic presentation/lifetime checks. Actual usage owner masking and request
// fencing remain exercised by the RecordedUsage continuity suites.
let root: Root, host: HTMLDivElement, restoreDialogs: () => void;
const tab = (id: string) => host.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!;
const panel = (id: string) => host.querySelector<HTMLElement>(`#settings-panel-${id}`)!;
const select = (id: string) => act(async () => tab(id).click());
async function render() {
  await act(async () => root.render(createElement(SettingsWorkspace)));
}
function setProfile(revision = 1) {
  const saved = {
    ownerId: fixture.session.userId,
    email: "fixture@example.invalid",
    revision,
    updatedAt: "2026-10-20T00:00:00Z",
    values: { ...DEFAULT_PROFILE_VALUES, fullName: "Synthetic account" },
  };
  fixture.profile = {
    workspace: { saved, values: saved.values, latest: null, mustReload: false },
    busy: false,
    saving: false,
    confirmed: false,
    error: null,
    edit: fixture.edit,
    save: fixture.save,
    discard: fixture.discard,
    reload: fixture.reload,
    keepEdits: fixture.keepEdits,
  };
}
beforeEach(() => {
  restoreDialogs = installDialogMethods();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  fixture.session = { status: "ready", userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", generation: 1 };
  setProfile();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("Unexpected network request in presentation fixture");
    }),
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  expect(fetch).not.toHaveBeenCalled();
  for (const action of [
    fixture.edit,
    fixture.save,
    fixture.discard,
    fixture.reload,
    fixture.keepEdits,
    fixture.checkAccount,
  ])
    expect(action).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  host.remove();
  restoreDialogs();
  vi.unstubAllGlobals();
});

describe("Settings keeps only working options", () => {
  it("offers exactly Account and Usage, with no header shortcut or placeholder cards", async () => {
    await render();
    expect([...host.querySelectorAll('[role="tab"]')].map((button) => button.textContent)).toEqual([
      "Account",
      "Usage",
    ]);
    expect(tab("account").getAttribute("aria-selected")).toBe("true");
    expect(host.querySelector(".sg-heading button, .sg-heading a")).toBeNull();
    for (const id of ["account", "usage"]) {
      await select(id);
      expect(host.querySelector(".sg-availability")).toBeNull();
      expect(host.textContent).not.toMatch(
        /Not available yet|unavailable features|readiness|verified|OpenAI|Billing|Recover|workspace|Notifications|Integrations/i,
      );
    }
  });

  it("shows profile, read-only email, date preferences and sign-out on Account", async () => {
    await render();
    const account = panel("account"),
      name = account.querySelector<HTMLInputElement>('input[autocomplete="name"]')!;
    const email = account.querySelector<HTMLInputElement>('input[autocomplete="email"]')!;
    const zone = account.querySelector<HTMLSelectElement>('select[aria-label="Time zone"]')!;
    const format = account.querySelector<HTMLSelectElement>('select[aria-label="Date format"]')!;
    expect(name.value).toBe("Synthetic account");
    expect(name.disabled).toBe(false);
    expect(zone.disabled).toBe(false);
    expect(format.disabled).toBe(false);
    expect(email.readOnly).toBe(true);
    expect(email.value).toBe("fixture@example.invalid");
    expect(account.querySelector(`#${email.getAttribute("aria-describedby")}`)?.textContent).toBe(
      "You sign in with this email. It can’t be changed here.",
    );
    expect(account.querySelectorAll('select[aria-label="Language"], select[aria-label="Appearance"]')).toHaveLength(0);
    expect(account.textContent).not.toContain("Account connection");
    // Changes save on their own: no Save or Cancel buttons, and the profile says so.
    expect(account.textContent).toContain("Changes on this page save automatically.");
    expect(account.querySelector(`#${name.getAttribute("aria-describedby")}`)?.textContent).toBe(
      "Your name appears in the account menu.",
    );
    const signOut = account.querySelector('[aria-label="Sign out"]')!;
    expect(signOut.querySelector("button")?.textContent).toBe("Sign out");
    expect([...account.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Sign out",
      "Download",
      "Delete account",
    ]);
    expect([...account.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Profile",
      "Preferences",
      "Sign out",
      "Your data",
    ]);
    const data = account.querySelector('[aria-labelledby="account-data-title"]')!;
    expect(data.textContent).toContain("Download my data");
    expect(data.querySelector("button.e-button--danger")?.textContent).toBe("Delete account");
    fixture.profile = { ...fixture.profile, busy: true };
    await render();
    expect(account.querySelector('input[autocomplete="name"]')).toBe(name);
    expect(name.disabled).toBe(true);
    expect(account.querySelector('select[aria-label="Date format"]')).toBe(format);
    expect(format.disabled).toBe(true);
  });

  it("shows Saved only after the server confirms, and one Try again after a failed save", async () => {
    setProfile(0);
    await render();
    const status = () => panel("account").querySelector("#profile-fullName-status")!;
    expect(status().textContent).toBe("Your name appears in the account menu.");
    fixture.profile = { ...fixture.profile, busy: true, saving: true };
    await render();
    expect(status().textContent).toBe("Saving");
    // A running save leaves the field editable.
    expect(panel("account").querySelector<HTMLInputElement>('input[autocomplete="name"]')!.disabled).toBe(false);
    fixture.profile = { ...fixture.profile, busy: false, saving: false, confirmed: true };
    await render();
    expect(status().textContent).toBe("Saved");
    const workspace = (fixture.profile as { workspace: Record<string, unknown> }).workspace;
    fixture.profile = {
      ...fixture.profile,
      confirmed: false,
      error: "Couldn’t save. Check your connection.",
      workspace: { ...workspace, mustReload: true },
    };
    await render();
    expect(status().textContent).toBe("Couldn’t save. Check your connection.Try again");
    expect(status().querySelectorAll("button")).toHaveLength(1);
    await act(async () => status().querySelector("button")!.click());
    expect(fixture.reload).toHaveBeenCalledOnce();
    fixture.reload.mockClear();
  });

  it("asks to sign in instead of drawing empty fields when signed out", async () => {
    fixture.session = { status: "signed_out", generation: 2 };
    fixture.profile = { workspace: null, busy: false, error: null };
    await render();
    expect(panel("account").querySelector('input[autocomplete="name"]')).toBeNull();
    expect(panel("account").querySelector("[role=status]")?.textContent).toBe(
      "Sign in to edit your profile and preferences.",
    );
    expect(panel("account").querySelector('[aria-label="Sign in"] h2')?.textContent).toBe("Sign in");
  });

  it("holds the place of the fields with skeletons while the account is checked", async () => {
    fixture.session = { status: "checking", generation: 2 };
    fixture.profile = { workspace: null, busy: false, error: null };
    await render();
    const loading = panel("account").querySelector('[aria-busy="true"]')!;
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.querySelectorAll(".e-skeleton").length).toBeGreaterThan(0);
    expect(panel("account").querySelector("input, select")).toBeNull();
  });

  it("labels time zones by city while keeping the saved identifier", async () => {
    await render();
    const zone = panel("account").querySelector<HTMLSelectElement>('select[aria-label="Time zone"]')!;
    const options = [...zone.options];
    expect(options.map((option) => option.value)).toEqual([...PROFILE_TIME_ZONES]);
    expect(options[0]!.textContent).toBe("Toronto — Eastern Time");
    expect(options.every((option) => !option.textContent!.includes("/") && !option.textContent!.includes("_"))).toBe(
      true,
    );
    expect(zone.value).toBe(DEFAULT_PROFILE_VALUES.timeZone);
  });
});

describe("Usage tab lifetime", () => {
  it("mounts usage only when its tab is opened", async () => {
    await render();
    expect(fixture.usageMount).not.toHaveBeenCalled();
    await select("usage");
    expect(tab("usage").getAttribute("aria-selected")).toBe("true");
    expect(fixture.usageMount).toHaveBeenCalledOnce();
    expect(panel("usage").firstElementChild).toBe(host.querySelector(".recorded-usage"));
  });

  it("retains the same usage section while switching tabs", async () => {
    await render();
    await select("usage");
    const usage = host.querySelector(".recorded-usage")!;
    await select("account");
    expect(host.querySelector(".recorded-usage")).toBe(usage);
    expect(panel("usage").hidden).toBe(true);
    expect(panel("usage").hasAttribute("inert")).toBe(true);
    expect(usage.getAttribute("data-active")).toBe("false");
    await select("usage");
    expect(host.querySelector(".recorded-usage")).toBe(usage);
    expect(usage.getAttribute("data-active")).toBe("true");
    expect(fixture.usageUnmount).not.toHaveBeenCalled();
    expect(fixture.usageMount).toHaveBeenCalledOnce();
  });
});
