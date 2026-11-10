import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isPublicAddress } from "../../src/server/public-address";

describe("public network address check", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "192.0.2.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "fe80::1%en0",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "not-an-address",
  ])("rejects non-public destination %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "2606:4700:4700::1111"])("accepts public destination %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});
