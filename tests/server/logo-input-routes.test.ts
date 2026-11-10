import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const f = vi.hoisted(() => ({ resolve: vi.fn(), auth: vi.fn(), requests: vi.fn(), request: vi.fn(), references: vi.fn(), fonts: vi.fn(), catalog: vi.fn(), referenceUpload: vi.fn(), fontUpload: vi.fn(), fontImport: vi.fn() }));
vi.mock("../../src/server/auth/context", () => ({ getAuthenticatedContext: f.auth }));
vi.mock("../../src/server/data/logo-inputs", () => ({ productionLogoInputService: {
  listLogoInputRequests: f.requests, readLogoInputRequest: f.request, listLogoReferences: f.references,
  listLogoFonts: f.fonts, listCatalogLogoFonts: f.catalog, uploadLogoReference: f.referenceUpload,
  uploadLogoFont: f.fontUpload, importCatalogLogoFont: f.fontImport,
} }));
vi.mock("@/server/runtime/logo-request-services", () => ({ resolveLogoRequestServices: f.resolve }));
import { ApiError } from "../../src/server/http/errors";
const id = (n: number) => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const auth = { userId: id(1), client: {} };
const context = { params: Promise.resolve({ projectId: id(2) }) };
const routes = {
  requests: () => import("../../src/app/api/projects/[projectId]/logo/inputs/requests/route"),
  request: () => import("../../src/app/api/projects/[projectId]/logo/inputs/requests/[requestKey]/route"),
  references: () => import("../../src/app/api/projects/[projectId]/logo/references/route"),
};
const scope = { params: Promise.resolve({ projectId: id(2), requestKey: id(3) }) };
beforeEach(() => { vi.resetAllMocks(); vi.stubEnv("APP_ORIGIN", "https://fluid.invalid"); f.auth.mockResolvedValue(auth); f.resolve.mockResolvedValue({ inputs: { uploadLogoReference: f.referenceUpload, uploadLogoFont: f.fontUpload, importCatalogLogoFont: f.fontImport } }); });
afterEach(() => vi.unstubAllEnvs());
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
describe("owned logo input reads", () => {
  it.each(Object.keys(routes) as (keyof typeof routes)[])("%s rejects an unverified session before data access", async key => {
    f.auth.mockRejectedValueOnce(new ApiError("unauthenticated"));
    const response = await (await routes[key]()).GET(new Request("https://fluid.invalid/api"), scope);
    expect(response.status).toBe(401); privateResponse(response); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(Object.keys(routes) as (keyof typeof routes)[])("%s rejects a noncanonical project UUID before data access", async key => {
    const response = await (await routes[key]()).GET(new Request("https://fluid.invalid/api"), { params: Promise.resolve({ projectId: id(2).toUpperCase(), requestKey: id(3) }) });
    expect(response.status).toBe(422); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["requests", "references"] as const)("%s returns a bounded owned page and forwards cancellation", async key => {
    const value = { ownerId: id(1), projectId: id(2), items: [], nextCursor: null };
    f[key].mockResolvedValue(value);
    const request = new Request(`https://fluid.invalid/api?limit=5&cursor=${id(4)}`);
    const response = await (await routes[key]()).GET(request, context);
    expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual(value);
    expect(f[key]).toHaveBeenCalledWith(auth, id(2), { limit: 5, cursor: id(4) }, request.signal);
  });
  it.each(["requests", "references"] as const)("%s rejects duplicate, foreign, oversized and malformed page queries", async key => {
    const route = await routes[key]();
    for (const query of ["limit=0", `limit=${key === "requests" ? 11 : 51}`, "limit=1&limit=2", "limit=1e1", "ownerId=foreign", "cursor=not-a-uuid", "cursor=" + "a".repeat(4097)]) {
      const response = await route.GET(new Request("https://fluid.invalid/api?" + query), context);
      expect(response.status, query).toBe(422); privateResponse(response);
    }
    expect(f[key]).not.toHaveBeenCalled();
  });
  it("reads one request by canonical identity with cancellation", async () => {
    f.request.mockResolvedValue({ status: "not_found" }); const request = new Request("https://fluid.invalid/api");
    const response = await (await routes.request()).GET(request, scope);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ status: "not_found" }); privateResponse(response);
    expect(f.request).toHaveBeenCalledWith(auth, id(2), id(3), request.signal);
    expect((await (await routes.request()).GET(new Request("https://fluid.invalid/api"), { params: Promise.resolve({ projectId: id(2), requestKey: "invalid" }) })).status).toBe(422);
    expect(f.request).toHaveBeenCalledTimes(1);
  });
  it.each(["request"] as const)("%s refuses unsupported or repeated query parameters", async key => {
    const route = await routes[key]();
    for (const query of ["ownerId=foreign", "limit=1", "cursor=first&cursor=second"]) expect((await route.GET(new Request("https://fluid.invalid/api?" + query), scope)).status).toBe(422);
    expect(f[key]).not.toHaveBeenCalled();
  });

  it("sanitizes storage failures without serializing private errors", async () => {
    f.requests.mockRejectedValue(new Error("secret database path"));
    const response = await (await routes.requests()).GET(new Request("https://fluid.invalid/api"), context);
    expect(response.status).toBe(500); privateResponse(response); expect(await response.text()).not.toContain("secret database path");
  });
});

const writes = {
  referenceUpload: () => import("../../src/app/api/projects/[projectId]/logo/references/uploads/route"),
};
const expected = { projectRevision: 1, referenceRevision: 0, preferencesRevision: 0, workspaceRevision: 1, stageRevisions: { brief_references: 1, concepts: 0, vector: 0, refinements: 0, directions: 0, deliverables: 0 } };
const referenceInput = { requestKey: id(3), expected, aspects: ["shape"], rightsDeclaration: "I own and permit processing this reference." };
const fontInput = { requestKey: id(3), expected, licenseSourceUrl: "https://fonts.invalid/license", licenseText: "Synthetic license text for this test.", rightsDeclaration: "I may upload this font for review." };
const refMax = 33_554_432, fontMax = 10_485_760, metadataMax = 294_912, multipartOverhead = 16_384;
function multipart(input: unknown, type = "image/png", bytes: Uint8Array<ArrayBuffer> = new Uint8Array([1, 2, 3])) {
  const form = new FormData(); form.set("input", typeof input === "string" ? input : JSON.stringify(input)); form.set("file", new File([bytes], "untrusted-private-name", { type })); return form;
}
function uploadRequest(form: FormData, origin = "https://fluid.invalid", headers: Record<string, string> = {}) {
  return new Request("https://fluid.invalid/api", { method: "POST", headers: { origin, ...headers }, body: form });
}
function validWrite(key: keyof typeof writes) {
  void key; return uploadRequest(multipart(referenceInput, "image/png", new Uint8Array(12)));
}
describe("owned logo input writes", () => {
  it.each(Object.keys(writes) as (keyof typeof writes)[])("%s authenticates before reading the request body", async key => {
    f.auth.mockRejectedValueOnce(new ApiError("unauthenticated")); const request = validWrite(key);
    const response = await (await writes[key]()).POST(request, context);
    expect(response.status).toBe(401); privateResponse(response); expect(request.bodyUsed).toBe(false); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(Object.keys(writes) as (keyof typeof writes)[])("%s rejects foreign and absent origins before body consumption", async key => {
    for (const origin of ["https://evil.invalid", "null", ""]) {
      const request = validWrite(key); request.headers.set("origin", origin);
      const response = await (await writes[key]()).POST(request, context);
      expect(response.status).toBe(403); expect(request.bodyUsed).toBe(false); privateResponse(response);
    }
    const crossSite = validWrite(key); crossSite.headers.set("sec-fetch-site", "cross-site");
    expect((await (await writes[key]()).POST(crossSite, context)).status).toBe(403); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(Object.keys(writes) as (keyof typeof writes)[])("%s validates the route UUID before reading the body", async key => {
    const request = validWrite(key);
    expect((await (await writes[key]()).POST(request, { params: Promise.resolve({ projectId: "foreign-project" }) })).status).toBe(422);
    expect(request.bodyUsed).toBe(false); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["referenceUpload"] as const)("%s preserves exact metadata and bytes while forwarding cancellation", async key => {
    const input = key === "referenceUpload" ? referenceInput : fontInput, mimeType = key === "referenceUpload" ? "image/png" : "font/ttf";
    const bytes = new Uint8Array([0, 13, 10, 255, 17, 12, 9, 4, 1, 2, 3, 4]);
    const request = uploadRequest(multipart(input, mimeType, bytes));
    const originalFormData = vi.spyOn(request, "formData").mockRejectedValue(new Error("Unbounded parsing forbidden"));
    f[key].mockResolvedValue({ fixture: key });
    const response = await (await writes[key]()).POST(request, context);
    expect(response.status).toBe(200); privateResponse(response); expect(await response.json()).toEqual({ fixture: key });
    expect(f.resolve).toHaveBeenCalledWith(auth, id(2), request.signal);
    expect(originalFormData).not.toHaveBeenCalled(); expect(f[key]).toHaveBeenCalledWith(auth, id(2), input, bytes, mimeType, request.signal);
  });
  it.each(["image/png", "image/jpeg", "image/webp"])("reference upload accepts only supported raster wire types: %s", async type => {
    f.referenceUpload.mockResolvedValue({ fixture: "reference" });
    expect((await (await writes.referenceUpload()).POST(uploadRequest(multipart(referenceInput, type)), context)).status).toBe(200);
  });

  it.each(["referenceUpload"] as const)("%s rejects duplicate, additional, swapped and missing multipart fields", async key => {
    const input = key === "referenceUpload" ? referenceInput : fontInput;
    for (const issue of ["duplicate-input", "duplicate-file", "extra", "input-file", "file-text", "missing-input", "missing-file"]) {
      const form = multipart(input, key === "referenceUpload" ? "image/png" : "font/ttf", new Uint8Array(12));
      if (issue === "duplicate-input") form.append("input", JSON.stringify(input));
      if (issue === "duplicate-file") form.append("file", new File(["bad"], "second"));
      if (issue === "extra") form.append("ownerId", id(99));
      if (issue === "input-file") form.set("input", new File([JSON.stringify(input)], "input.json"));
      if (issue === "file-text") form.set("file", "fake");
      if (issue === "missing-input") form.delete("input");
      if (issue === "missing-file") form.delete("file");
      expect((await (await writes[key]()).POST(uploadRequest(form), context)).status, issue).toBe(422);
    }
    expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["referenceUpload"] as const)("%s rejects metadata identity forgery, malformed JSON and blank permission", async key => {
    const input = key === "referenceUpload" ? referenceInput : fontInput;
    for (const invalid of [{ ...input, ownerId: id(99) }, { ...input, projectId: id(99) }, { ...input, requestKey: "forged" }, { ...input, rightsDeclaration: "   " }, "{malformed"]) {
      const request = uploadRequest(multipart(invalid, key === "referenceUpload" ? "image/png" : "font/ttf", new Uint8Array(12)));
      expect((await (await writes[key]()).POST(request, context)).status).toBe(422);
    }
    expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["referenceUpload"] as const)("%s refuses unsupported MIME and undersized files", async key => {
    const input = key === "referenceUpload" ? referenceInput : fontInput;
    for (const type of ["image/svg+xml", "text/html", "application/octet-stream", ""]) expect((await (await writes[key]()).POST(uploadRequest(multipart(input, type, new Uint8Array(12))), context)).status).toBe(422);
    expect((await (await writes[key]()).POST(uploadRequest(multipart(input, key === "referenceUpload" ? "image/png" : "font/ttf", new Uint8Array(key === "referenceUpload" ? 0 : 11))), context)).status).toBe(422);
    expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["referenceUpload"] as const)("%s enforces individual file limits inside otherwise bounded multipart", async key => {
    const maximum = key === "referenceUpload" ? refMax : fontMax;
    const request = uploadRequest(multipart(key === "referenceUpload" ? referenceInput : fontInput, key === "referenceUpload" ? "image/png" : "font/ttf", new Uint8Array(maximum + 1)));
    expect((await (await writes[key]()).POST(request, context)).status).toBe(413); expect(f[key]).not.toHaveBeenCalled();
  });
  it.each(["referenceUpload"] as const)("%s caps declared and actual streamed body bytes, including false Content-Length", async key => {
    const maximum = (key === "referenceUpload" ? refMax : fontMax) + metadataMax + multipartOverhead;
    const declared = validWrite(key); declared.headers.set("content-length", String(maximum + 1));
    expect((await (await writes[key]()).POST(declared, context)).status).toBe(413); expect(declared.bodyUsed).toBe(false);
    let cancelled = false;
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(maximum)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
    const request = new Request("https://fluid.invalid/api", { method: "POST", headers: { origin: "https://fluid.invalid", "content-type": "multipart/form-data; boundary=bounded", "content-length": "1" }, body: stream, duplex: "half" } as RequestInit);
    expect((await (await writes[key]()).POST(request, context)).status).toBe(413); expect(cancelled).toBe(true); expect(f[key]).not.toHaveBeenCalled();
  });


  it("rejects malformed multipart and unbounded multipart headers without exposing content", async () => {
    const post = (await writes.referenceUpload()).POST;
    for (const body of ["private malformed body", "--bounded\r\nContent-Disposition: form-data; name=\"input\"\r\nX-Private: " + "x".repeat(17000) + "\r\n\r\n{}\r\n--bounded--\r\n"]) {
      const response = await post(new Request("https://fluid.invalid/api", { method: "POST", headers: { origin: "https://fluid.invalid", "content-type": "multipart/form-data; boundary=bounded" }, body }), context);
      expect([413, 422]).toContain(response.status); expect(await response.text()).not.toContain("private malformed");
    }
    expect(f.referenceUpload).not.toHaveBeenCalled();
  });
  it("honors an already-aborted upload without reading bytes or invoking persistence", async () => {
    const request = new Request(validWrite("referenceUpload"), { signal: AbortSignal.abort() });
    const response = await (await writes.referenceUpload()).POST(request, context);
    expect(response.status).toBe(503); expect(request.bodyUsed).toBe(false); expect(f.referenceUpload).not.toHaveBeenCalled();
  });


  it.each(Object.keys(writes) as (keyof typeof writes)[])("%s returns fail-closed availability and sanitizes unexpected failures", async key => {
    const post = (await writes[key]()).POST;
    f[key].mockRejectedValueOnce(new ApiError("integration_unavailable"));
    const unavailable = await post(validWrite(key), context); expect(unavailable.status).toBe(503); privateResponse(unavailable);
    f[key].mockRejectedValueOnce(new Error("private license path and credentials"));
    const failure = await post(validWrite(key), context); expect(failure.status).toBe(500); expect(await failure.text()).not.toContain("private license");
  });
});

describe("bounded logo multipart edge cases", () => {

  it("aborts a stalled upload stream without entering persistence", async () => {
    const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream({ pull() { controller.abort(); }, cancel() { cancelled = true; } });
    const request = new Request("https://fluid.invalid/api", { method: "POST", headers: { origin: "https://fluid.invalid", "content-type": "multipart/form-data; boundary=bounded" }, body: stream, signal: controller.signal, duplex: "half" } as RequestInit);
    expect((await (await writes.referenceUpload()).POST(request, context)).status).toBe(503);
    expect(cancelled || !request.bodyUsed).toBe(true); expect(f.referenceUpload).not.toHaveBeenCalled();
  });

});
