import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { unzipSync, strFromU8 } from "fflate";
import sharp from "sharp";
import { buildLogoExport } from "../../../src/features/identity-deliverables/server/package";
import { renderSelectedSocial } from "../../../src/features/identity-deliverables/server/social";
import { approvedExportFixture, hashBytes } from "./fixtures";

describe("synthetic actual export package", () => {
  it("default pack includes guidelines and verified logos without social or font files", async () => {
    const input = await approvedExportFixture(), output = await buildLogoExport(input, new AbortController().signal);
    const entries = unzipSync(output.archive.bytes), names = Object.keys(entries);
    expect(output.files.filter(file => file.verification).length).toBe(9);
    expect(names).toContain("brand-guidelines.pdf");
    expect(names.some(name => /avatar|banner|\.(ttf|otf|woff2?)$/i.test(name))).toBe(false);
    expect(output.sourceSnapshotHash).toBe(input.sourceSnapshotHash);
    for (const file of output.files) expect(hashBytes(entries[file.name]!)).toBe(file.contentHash);
    const manifest = JSON.parse(strFromU8(entries["manifest.json"]!));
    expect(manifest.files).toHaveLength(output.files.length);
    const publicText = strFromU8(entries["manifest.json"]!);
    for (const forbidden of ["ownerId", "projectId", "signedUrl", "storagePath", "credentials", "prompt"]) expect(publicText).not.toContain(forbidden);
    expect(new Set(names).size).toBe(names.length); expect(names.every(name => /^[a-zA-Z0-9._-]+$/.test(name))).toBe(true);
  });
  it("only selected social output has exact contained dimensions", async () => {
    const input = await approvedExportFixture(); input.socialSelections = [{ kind: "avatar", presetId: "avatar-1024-contain-v1" }];
    const files = await renderSelectedSocial(input, new AbortController().signal);
    expect(files).toHaveLength(1); expect(files[0]!.role).toBe("avatar");
    expect(await sharp(files[0]!.bytes).metadata()).toMatchObject({ width: 1024, height: 1024, hasAlpha: true });
    input.socialSelections = [{ kind: "banner", presetId: "banner-1500x500-contain-v1" }];
    const banner = await renderSelectedSocial(input, new AbortController().signal);
    expect(await sharp(banner[0]!.bytes).metadata()).toMatchObject({ width: 1500, height: 500 });
    input.socialSelections = [{ kind: "banner", presetId: "unreviewed-crop" }];
    await expect(renderSelectedSocial(input, new AbortController().signal)).rejects.toThrow();
  });
});
