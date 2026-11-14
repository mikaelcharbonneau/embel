import { describe, expect, it } from "vitest";
import { assetTitle } from "@/components/assets/asset-labels";

describe("Library asset titles", () => {
  it("replaces stored identifiers with plain words and keeps written titles", () => {
    expect(assetTitle("logo_identity_system")).toBe("Direction board");
    expect(assetTitle("brand_board")).toBe("Brand board");
    expect(assetTitle("logo_concept")).toBe("Logo concept");
    expect(assetTitle("logo_export")).toBe("Logo files");
    expect(assetTitle("social_profile")).toBe("Social profile image");
    expect(assetTitle("logo_mockup")).toBe("Logo mockup");
    expect(assetTitle("Primary mark")).toBe("Primary mark");
    expect(assetTitle("  ")).toBe("Saved file");
  });
});
