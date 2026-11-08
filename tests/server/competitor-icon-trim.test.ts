import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import sharp from "sharp";
import { trimIconMargin } from "@/server/competitor-icons";

// Synthetic icons only: a 64px canvas with a 32px dark mark in the middle.
async function icon(background: { r: number; g: number; b: number; alpha: number }) {
  const mark = await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 20, g: 20, b: 40, alpha: 1 } } }).png().toBuffer();
  return sharp({ create: { width: 64, height: 64, channels: 4, background } }).composite([{ input: mark, left: 16, top: 16 }]).png().toBuffer();
}
async function size(bytes: Buffer) { const { width, height } = await sharp(bytes).metadata(); return [width, height]; }

describe("competitor icon margins", () => {
  it("removes a white margin the site drew around its mark", async () => {
    const result = await trimIconMargin({ bytes: await icon({ r: 255, g: 255, b: 255, alpha: 1 }), contentType: "image/png" });
    expect(result.contentType).toBe("image/png"); expect(await size(result.bytes)).toEqual([32, 32]);
  });

  it("removes a transparent margin", async () => {
    const result = await trimIconMargin({ bytes: await icon({ r: 0, g: 0, b: 0, alpha: 0 }), contentType: "image/png" });
    expect(await size(result.bytes)).toEqual([32, 32]);
  });

  it("keeps a full-bleed icon's own coloured background", async () => {
    const original = { bytes: await icon({ r: 250, g: 200, b: 60, alpha: 1 }), contentType: "image/png" };
    expect(await trimIconMargin(original)).toBe(original);
  });

  it("leaves an .ico, an unreadable file and an image that is only margin unchanged", async () => {
    const ico = { bytes: Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0]), contentType: "image/x-icon" };
    expect(await trimIconMargin(ico)).toBe(ico);
    const broken = { bytes: Buffer.from("not an image at all"), contentType: "image/png" };
    expect(await trimIconMargin(broken)).toBe(broken);
    const blank = { bytes: await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } }).png().toBuffer(), contentType: "image/png" };
    expect(await trimIconMargin(blank)).toBe(blank);
  });
});
