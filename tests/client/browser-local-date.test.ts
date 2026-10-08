import { execFileSync } from "node:child_process";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrowserLocalDate } from "@/components/workspace/browser-local-date";

describe("browser-local source dates", () => {
  it("uses the runtime timezone across UTC midnight and daylight-saving offsets", () => {
    const component = new URL("../../src/components/workspace/browser-local-date.tsx", import.meta.url).href;
    const script = `import { formatBrowserDate } from ${JSON.stringify(component)}; process.stdout.write(JSON.stringify(["2026-10-04T01:30:00Z", "2026-12-01T04:30:00Z"].map(value => formatBrowserDate(value, "en-US"))));`;
    const dates = (timeZone: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { env: { ...process.env, TZ: timeZone }, encoding: "utf8" }));
    expect(dates("America/Toronto")).toEqual(["Oct 3, 2026", "Nov 30, 2026"]);
    expect(dates("UTC")).toEqual(["Oct 4, 2026", "Dec 1, 2026"]);
  });
  it("keeps the absolute timestamp and a stable placeholder for server rendering and hydration", () => {
    const dateTime = "2026-10-04T01:30:00Z";
    expect(renderToStaticMarkup(createElement(BrowserLocalDate, { dateTime, prefix: "Retrieved " })))
      .toBe(`<time dateTime="${dateTime}">Retrieved …</time>`);
  });
});
