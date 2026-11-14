import { describe, expect, it, vi } from "vitest";
import { createAccountViewCache } from "@/components/workspace/account-view-cache";

const owner = { userId: "owner-a", generation: 1 };

describe("the account's kept list views (D-073)", () => {
  it("returns a kept value only for the bound owner and session", () => {
    const cache = createAccountViewCache();
    cache.bind(owner);
    cache.set(owner, "projects", ["kept"]);
    expect(cache.get(owner, "projects")).toEqual(["kept"]);
    expect(cache.get({ userId: "owner-a", generation: 2 }, "projects")).toBeUndefined();
    expect(cache.get({ userId: "owner-b", generation: 1 }, "projects")).toBeUndefined();
  });

  it("releases every held preview when the session changes or signs out", () => {
    const cache = createAccountViewCache();
    const release = vi.fn();
    cache.bind(owner);
    cache.set(owner, "card", { url: "blob:a" }, release);
    cache.bind(owner);
    expect(release).not.toHaveBeenCalled();
    cache.bind(null);
    expect(release).toHaveBeenCalledOnce();
    expect(cache.get(owner, "card")).toBeUndefined();
  });

  it("never keeps a value for a session that is not bound", () => {
    const cache = createAccountViewCache();
    const release = vi.fn();
    cache.bind({ userId: "owner-b", generation: 3 });
    expect(cache.set(owner, "card", { url: "blob:a" }, release)).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases a replaced preview and the oldest entries past its bound", () => {
    const cache = createAccountViewCache();
    cache.bind(owner);
    const first = vi.fn(),
      second = vi.fn();
    cache.set(owner, "card", 1, first);
    cache.set(owner, "card", 2, second);
    expect(first).toHaveBeenCalledOnce();
    const oldest = vi.fn();
    cache.set(owner, "oldest", 0, oldest);
    for (let index = 0; index < 200; index += 1) cache.set(owner, `filler-${index}`, index);
    expect(oldest).toHaveBeenCalledOnce();
    expect(cache.get(owner, "oldest")).toBeUndefined();
  });

  it("updates every kept list that shares a prefix", () => {
    const cache = createAccountViewCache();
    cache.bind(owner);
    cache.set(owner, "projects:active:50", { items: ["a", "b"] });
    cache.set(owner, "projects:active:6", { items: ["a"] });
    cache.update<{ items: string[] }>(owner, "projects:active:", (kept) => ({
      items: kept.items.filter((id) => id !== "a"),
    }));
    expect(cache.get(owner, "projects:active:50")).toEqual({ items: ["b"] });
    expect(cache.get(owner, "projects:active:6")).toEqual({ items: [] });
  });

  it("moves a kept value with what it holds, so a renamed card's picture is not released", () => {
    const cache = createAccountViewCache();
    cache.bind(owner);
    const held = vi.fn(),
      replaced = vi.fn();
    cache.set(owner, "card:artwork:p:1", { name: "Old", url: "blob:a" }, held);
    cache.set(owner, "card:artwork:p:2", { name: "Stale", url: "blob:b" }, replaced);
    const moved = cache.move<{ name: string; url: string }>(owner, "card:artwork:p:1", "card:artwork:p:2", (kept) => ({
      ...kept,
      name: "New",
    }));
    expect(moved).toEqual({ name: "New", url: "blob:a" });
    expect(cache.get(owner, "card:artwork:p:1")).toBeUndefined();
    expect(cache.get(owner, "card:artwork:p:2")).toEqual({ name: "New", url: "blob:a" });
    expect(held).not.toHaveBeenCalled();
    expect(replaced).toHaveBeenCalledOnce();
    expect(cache.move(owner, "card:artwork:missing", "card:artwork:p:3", (kept) => kept)).toBeUndefined();
    expect(cache.move({ userId: "owner-b", generation: 1 }, "card:artwork:p:2", "x", (kept) => kept)).toBeUndefined();
    cache.bind(null);
    expect(held).toHaveBeenCalledOnce();
  });
});
