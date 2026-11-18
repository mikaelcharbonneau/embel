import assert from "node:assert/strict";
import { test } from "node:test";
import { findUnacceptedAdvisories } from "../../scripts/ci/audit-production.mjs";

const accepted = [{ advisory: "https://example.test/A", package: "pkg-a", expires: "2026-12-31" }];

function report(vulnerabilities) {
  return { vulnerabilities };
}

const advisory = (url) => ({ url, severity: "high", title: "Example" });

test("an accepted advisory on its package passes, including chains that point at it", () => {
  const findings = findUnacceptedAdvisories(
    report({
      "pkg-a": { via: [advisory("https://example.test/A")] },
      "pkg-parent": { via: ["pkg-a"] },
    }),
    accepted,
    new Date("2026-11-18T00:00:00Z"),
  );
  assert.deepEqual(findings, []);
});

test("any other advisory fails", () => {
  const findings = findUnacceptedAdvisories(
    report({ "pkg-b": { via: [advisory("https://example.test/B")] } }),
    accepted,
    new Date("2026-11-18T00:00:00Z"),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^pkg-b high/);
});

test("the accepted advisory on a different package fails", () => {
  const findings = findUnacceptedAdvisories(
    report({ "pkg-b": { via: [advisory("https://example.test/A")] } }),
    accepted,
    new Date("2026-11-18T00:00:00Z"),
  );
  assert.equal(findings.length, 1);
});

test("an expired acceptance fails again", () => {
  const findings = findUnacceptedAdvisories(
    report({ "pkg-a": { via: [advisory("https://example.test/A")] } }),
    accepted,
    new Date("2027-01-01T00:00:00Z"),
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /now expired/);
});

test("an empty report passes", () => {
  assert.deepEqual(findUnacceptedAdvisories({}, accepted), []);
});
