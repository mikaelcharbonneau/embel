import { describe, expect, it } from "vitest";
import { isSignedDownloadUrl } from "../../src/domain/signed-download-url";

describe("signed download links", () => {
  it.each([
    "https://fricsfwqibyhemknqgyf.supabase.co/storage/v1/object/sign/fluid-assets/file?token=t&download=logo.png",
    "http://127.0.0.1:54321/storage/v1/object/sign/fluid-assets/file?token=t",
    "http://localhost:54321/storage/v1/object/sign/fluid-assets/file",
    "http://[::1]:54321/storage/v1/object/sign/fluid-assets/file",
  ])("accepts https, and plain http only to this computer: %s", url => {
    expect(isSignedDownloadUrl(url)).toBe(true);
  });
  it.each([
    "http://private-storage.example/file",
    "http://127.0.0.1.example.com/file",
    "http://192.168.1.10:54321/file",
    "https://user:password@private-storage.example/file",
    "http://user@127.0.0.1:54321/file",
    "ftp://127.0.0.1/file",
    "javascript:alert(1)",
    "not a url",
  ])("refuses other links: %s", url => {
    expect(isSignedDownloadUrl(url)).toBe(false);
  });
});
