import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import PDFDocument from "pdfkit";
vi.mock("server-only", () => ({}));
import { validateHomeAttachmentBytes } from "@/server/home-attachments/validation";
const encode = (s: string) => new TextEncoder().encode(s);
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const input = (
  b: Uint8Array,
  mimeType: "text/plain" | "application/pdf" | "image/png" | "image/jpeg" = "text/plain",
) => ({ requestKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "brief.txt", mimeType, contentHash: hash(b) });
async function pdf(options: ConstructorParameters<typeof PDFDocument>[0] = {}) {
  const doc = new PDFDocument(options),
    chunks: Uint8Array[] = [];
  const done = new Promise<Uint8Array>((resolve, reject) => {
    doc.on("data", (b) => chunks.push(b));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
  doc.text("An ordinary brand brief.");
  doc.end();
  return done;
}
describe("Home actual-byte admission", () => {
  it("accepts bounded UTF-8 plain text and rejects a wrong digest", async () => {
    const b = encode("A café for the neighbourhood");
    await expect(validateHomeAttachmentBytes(input(b), b)).resolves.toBeUndefined();
    await expect(validateHomeAttachmentBytes({ ...input(b), contentHash: "0".repeat(64) }, b)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it.each([
    "<html><script>bad()</script></html>",
    '<?xml version="1.0"?><svg/>',
    '<svg onload="bad()"/>',
    "%PDF-1.7",
    "PK\u0003\u0004",
    "bad\u0000text",
  ])("rejects active/binary text disguised as text/plain: %s", async (s) => {
    const b = encode(s);
    await expect(validateHomeAttachmentBytes(input(b), b)).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("rejects repeated opening markup prefixes without requiring a closing angle bracket", async () => {
    // Small synthetic correctness fixture, not a hostile timing/memory probe.
    const b = encode("<a ".repeat(128));
    await expect(validateHomeAttachmentBytes(input(b), b)).rejects.toMatchObject({ code: "invalid_input" });
  });
  it("preserves ordinary text containing numeric comparisons", async () => {
    const b = encode("The brief says 2 < 3, 4 > 1, and a cost < 12.");
    await expect(validateHomeAttachmentBytes(input(b), b)).resolves.toBeUndefined();
  });
  it("rejects invalid UTF-8, empty input and over-limit input", async () => {
    for (const b of [new Uint8Array([255]), new Uint8Array(), new Uint8Array(10_485_761)])
      await expect(validateHomeAttachmentBytes(input(b), b)).rejects.toMatchObject({
        code: b.length > 10_485_760 ? "body_too_large" : "invalid_input",
      });
  });
  it("decodes real PNG/JPEG rather than trusting a MIME or filename", async () => {
    for (const mime of ["image/png", "image/jpeg"] as const) {
      const image = sharp({ create: { width: 4, height: 3, channels: 3, background: "#ffaa22" } });
      const b = await (mime === "image/png" ? image.png() : image.jpeg()).toBuffer();
      await expect(validateHomeAttachmentBytes(input(b, mime), b)).resolves.toBeUndefined();
      await expect(
        validateHomeAttachmentBytes(input(b, mime === "image/png" ? "image/jpeg" : "image/png"), b),
      ).rejects.toMatchObject({ code: "invalid_input" });
    }
    const b = encode("<html>renamed PNG</html>");
    await expect(validateHomeAttachmentBytes(input(b, "image/png"), b)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
  it("fails closed for ordinary PDFs without a bounded decoder and rejects malformed-envelope or encrypted bytes", async () => {
    const b = await pdf();
    await expect(validateHomeAttachmentBytes(input(b, "application/pdf"), b)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
    for (const invalid of [encode("%PDF-1.7\nmissing final marker"), await pdf({ userPassword: "fixture-password" })])
      await expect(validateHomeAttachmentBytes(input(invalid, "application/pdf"), invalid)).rejects.toMatchObject({
        code: "invalid_input",
      });
  });
  it("rejects PDF actions including escaped names and unsupported object streams", async () => {
    const b = await pdf();
    for (const token of [
      "/JavaScript",
      "/Java#53cript",
      "/OpenAction",
      "/AA",
      "/EmbeddedFile",
      "/Launch",
      "/ObjStm",
      "/AcroForm",
    ]) {
      // Keep the PDF header and final EOF marker intact, so this exercises
      // the prohibited-name guard rather than the trailing-content check.
      const active = Buffer.from(
        Buffer.from(b).toString("latin1").replace("%%EOF", `% prohibited-name fixture ${token}\n%%EOF`),
        "latin1",
      );
      expect(Buffer.from(active).toString("latin1")).toMatch(/%%EOF\s*$/u);
      await expect(validateHomeAttachmentBytes(input(active, "application/pdf"), active)).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
  });
  it("does not invoke a decompressor for a compressed-content PDF envelope", async () => {
    // Deliberately invalid encoded stream; a decoder would try to expand it.
    // The unavailable capability must reject before any stream decode/parsing.
    const b = encode("%PDF-1.7\n1 0 obj << /Length 4 /Filter /FlateDecode >> stream\nxBAD\nendstream\nendobj\n%%EOF");
    await expect(validateHomeAttachmentBytes(input(b, "application/pdf"), b)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
  });
  it("rejects an aborted PDF admission before work", async () => {
    const b = await pdf(),
      controller = new AbortController();
    controller.abort();
    await expect(validateHomeAttachmentBytes(input(b, "application/pdf"), b, controller.signal)).rejects.toMatchObject({
      code: "integration_unavailable",
    });
  });
});
