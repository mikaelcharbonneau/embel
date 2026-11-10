import { afterEach, expect, it, vi } from "vitest";
import { requestSignUp, signUpErrorMessage, SignUpRequestError } from "../../src/components/auth/sign-up-request";

afterEach(() => vi.unstubAllGlobals());
it("sends credentials once through a same-origin POST and accepts only explicit signup outcomes", async () => {
  const body = JSON.stringify({ email: "synthetic@example.invalid", password: "synthetic password fixture" });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ authenticated: false, confirmationRequired: true }))
    .mockResolvedValueOnce(Response.json({ authenticated: true }));
  vi.stubGlobal("fetch", fetch);
  expect(await requestSignUp(body)).toBe("confirmation_required");
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/auth/sign-up", {
    method: "POST",
    credentials: "same-origin",
    mode: "same-origin",
    redirect: "error",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body,
  });
  expect(await requestSignUp(body)).toBeUndefined();
});
it("rejects malformed successes and refuses an authenticated resend response", async () => {
  for (const value of [
    {},
    { authenticated: false },
    { authenticated: true, token: "private" },
    { authenticated: false, confirmationRequired: false },
    { authenticated: false, confirmationRequired: true, user: { email: "private" } },
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(value)));
    await expect(requestSignUp("{}")).rejects.toMatchObject({ status: 502 });
  }
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not json")));
  await expect(requestSignUp("{}")).rejects.toMatchObject({ status: 502 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ authenticated: true })));
  await expect(requestSignUp("{}", "resend-confirmation")).rejects.toMatchObject({ status: 502 });
});
it("does not read or echo provider diagnostics and never retries failed requests", async () => {
  for (const status of [403, 413, 422, 429, 500, 503]) {
    const json = vi.fn(() => {
      throw new Error("private credential detail");
    });
    const fetch = vi.fn().mockResolvedValue({ ok: false, status, json });
    vi.stubGlobal("fetch", fetch);
    await expect(requestSignUp("{}")).rejects.toMatchObject({ status });
    expect(json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    const message = signUpErrorMessage(new SignUpRequestError(status));
    expect(message).not.toContain("private");
    expect(message).not.toContain("exists");
  }
  expect(signUpErrorMessage(new Error("private email exists"))).not.toContain("private email");
});
