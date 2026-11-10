import { describe, expect, it } from "vitest";
import { createEntry } from "@/features/handles-workspace/domain";
import { handleProfileUrl, handlesCsv } from "@/features/handles-workspace/manual-tools";

describe("manual Handles tools", () => {
  it("constructs only the exact fixed platform profile destinations", () => {
    expect(handleProfileUrl(createEntry("instagram", "cedar"))).toBe("https://www.instagram.com/cedar/");
    expect(handleProfileUrl(createEntry("tiktok", "cedar"))).toBe("https://www.tiktok.com/@cedar");
    expect(handleProfileUrl(createEntry("youtube", "cedar"))).toBe("https://www.youtube.com/@cedar");
    expect(handleProfileUrl(createEntry("x", "cedar"))).toBe("https://x.com/cedar");
    expect(handleProfileUrl(createEntry("linkedin", "cedar"))).toBe("https://www.linkedin.com/company/cedar/");
    expect(() => handleProfileUrl({ platform: "x", handle: "../logout?next=https://evil.test" })).toThrow();
  });
  it("exports unknown availability and separates user declarations from provider evidence", () => {
    const entry = {
      ...createEntry("instagram", "cedar"),
      accountCreated: { declaredAt: new Date().toISOString(), url: "https://www.instagram.com/cedar/" },
    };
    const csv = handlesCsv([{ name: "Cedar", entries: [entry] }]);
    expect(csv).toContain('"Cedar","Instagram","cedar","Unknown",""');
    expect(csv).toContain('"User-declared account URL"');
    expect(csv).not.toContain("Confirmed available");
    expect(entry.evidence).toEqual([]);
  });
  it("quotes multiline text and neutralizes spreadsheet formulas", () => {
    const csv = handlesCsv([{ name: ' \t=HYPERLINK("evil")\nsecond line', entries: [createEntry("x", "cedar")] }]);
    expect(csv).toContain('"\' \t=HYPERLINK(""evil"")\nsecond line"');
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});
