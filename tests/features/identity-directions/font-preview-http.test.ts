import { describe, expect, it, vi } from "vitest";
import { createAccountLogoClient } from "@/components/identity/account-logo-client";
import { createFontPreviewHttpReader } from "@/features/identity-directions/components/font-preview-http";
import { FONT_PREVIEW_RESPONSE_BYTES, fontPreviewInputSchema } from "@/features/identity-directions/model/font-preview";
import { directionFixture, fontFixture, id } from "./fixtures";
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function fixture(fetcher?: typeof fetch) {
  const account = { status: "ready" as const, userId: id(1), generation: 1 }, font = fontFixture(), style = directionFixture().typography[0]!.styles[0]!;
  let current = true;
  const input = fontPreviewInputSchema.parse({ sampleText: style.sampleText, weight: style.weight, style: style.style, sizePx: style.sizePx, lineHeight: style.lineHeight, fontContentHash: font.asset.contentHash, rightsEvidenceId: font.rights.id });
  const output = { ownerId: account.userId, projectId: id(2), fontVersionId: font.id, input, result: { status: "unavailable", reason: "style_unsupported" } };
  const fetch = vi.fn(fetcher ?? (async () => json(output))), expire = vi.fn(), isCurrent = () => current;
  const client = createAccountLogoClient(account, id(2), isCurrent, expire, fetch);
  const read = createFontPreviewHttpReader({ account, projectId: id(2), client, isCurrent, expire, fetcher: fetch });
  return { font, input, output, read, fetch, expire, client, switchAccount: () => { current = false; } };
}
describe("account-fenced specimen HTTP reader", () => {
  it("requests only the owned read-only specimen route with same-origin credentials and no redirect", async () => {
    const f = fixture(); const result = await f.read(f.font, f.input, new AbortController().signal);
    expect(result).toEqual(f.output.result);
    expect(f.fetch).toHaveBeenCalledWith(`/api/projects/${id(2)}/logo/fonts/${f.font.id}/preview`, expect.objectContaining({ method: "POST", body: JSON.stringify(f.input), credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error" }));
    f.client.dispose();
  });
  it.each(["ownerId", "projectId", "fontVersionId", "input"])("rejects a response with wrong %s binding", async field => {
    const f = fixture(); const changed = { ...f.output, [field]: field === "input" ? { ...f.input, sampleText: "Other text" } : id(99) };
    f.fetch.mockResolvedValueOnce(json(changed));
    await expect(f.read(f.font, f.input, new AbortController().signal)).rejects.toMatchObject({ status: 502 }); f.client.dispose();
  });
  it("rejects cross-project inputs without sending a request", async () => {
    const f = fixture(); f.font.asset.projectId = id(99);
    await expect(f.read(f.font, f.input, new AbortController().signal)).rejects.toMatchObject({ status: 422 }); expect(f.fetch).not.toHaveBeenCalled(); f.client.dispose();
  });
  it("fences late responses after account change", async () => {
    const pending = deferred<Response>(), f = fixture(async () => pending.promise);
    const read = f.read(f.font, f.input, new AbortController().signal); f.switchAccount(); pending.resolve(json(f.output));
    expect(await read).toBeNull(); f.client.dispose();
  });
  it("expires the same account on 401 without trusting a response body", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(json({}, 401));
    expect(await f.read(f.font, f.input, new AbortController().signal)).toBeNull(); expect(f.expire).toHaveBeenCalledOnce();
    expect(await f.read(f.font, f.input, new AbortController().signal)).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["text/html", "font/ttf", "image/svg+xml"])("refuses unexpected %s responses", async type => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response("<script>alert(1)</script>", { headers: { "content-type": type } }));
    await expect(f.read(f.font, f.input, new AbortController().signal)).rejects.toMatchObject({ status: 502 }); f.client.dispose();
  });
  it("bounds actual response bytes even if content-length lies", async () => {
    const f = fixture(); f.fetch.mockResolvedValueOnce(new Response("x".repeat(FONT_PREVIEW_RESPONSE_BYTES + 1), { headers: { "content-type": "application/json", "content-length": "1" } }));
    await expect(f.read(f.font, f.input, new AbortController().signal)).rejects.toMatchObject({ status: 502 }); f.client.dispose();
  });
  it("cancels an interrupted response stream", async () => {
    const f = fixture(), controller = new AbortController(), cancelled = vi.fn();
    f.fetch.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "application/json" } }));
    const read = f.read(f.font, f.input, controller.signal); await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
    expect(await read).toBeNull(); expect(cancelled).toHaveBeenCalledOnce(); f.client.dispose();
  });
  it("limits concurrent reads to two and cancels queued work before dispatch", async () => {
    const pending = deferred<Response>(), f = fixture(async () => pending.promise), queued = new AbortController();
    const first = f.read(f.font, f.input, new AbortController().signal), second = f.read(f.font, f.input, new AbortController().signal), third = f.read(f.font, f.input, queued.signal);
    expect(f.fetch).toHaveBeenCalledTimes(2); queued.abort(); expect(await third).toBeNull();
    f.switchAccount(); pending.resolve(json(f.output)); expect(await first).toBeNull(); expect(await second).toBeNull(); expect(f.fetch).toHaveBeenCalledTimes(2); f.client.dispose();
  });
});
