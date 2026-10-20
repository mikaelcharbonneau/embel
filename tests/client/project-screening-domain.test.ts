import { describe, expect, it } from "vitest";
import { projectScreeningDomainError, projectScreeningDomainSuggestion } from "@/components/naming/project-screening-domain";
import { domainSyntaxError } from "@/features/domain-workspace/model";
import { providerTargetSchema } from "@/domain/standalone-provider-evidence";

describe("selected-name domain suggestions", () => {
  it.each(["Kedar.com", "KEDAR.COM", "belélan.com", "東京.com", "Ｃedar.com", "xn--belan-dsa.com"])("rejects unsupported exact input %s without Unicode case folding", domain => {
    expect(projectScreeningDomainError(domain)).toContain("Internationalized names are not supported yet.");
  });
  it.each(["cedar.com", "  CEDAR.COM  ", "blue-cedar.co.uk"])("preserves supported manual ASCII input %s", domain => {
    expect(projectScreeningDomainError(domain)).toBeNull();
  });
  it.each([
    ["Cedar", "cedar.com"],
    ["  Blue Cedar  ", "bluecedar.com"],
    ["Blue\tCedar", "bluecedar.com"],
    ["BLUE-CEDAR", "blue-cedar.com"],
    ["Cedar42", "cedar42.com"],
    ["Cedar.CA", "cedar.ca"],
    ["Shop.Cedar.Co.UK", "shop.cedar.co.uk"],
    ["a".repeat(63), `${"a".repeat(63)}.com`],
  ])("suggests supported syntax for %s without claiming availability", (name, expected) => {
    const domain = projectScreeningDomainSuggestion(name);
    expect(domain).toBe(expected);
    expect(domainSyntaxError(domain!)).toBeNull();
    expect(providerTargetSchema.safeParse({ tool: "domains", domain }).success).toBe(true);
  });

  it.each([
    "Bel Élan", "Bel E\u0301lan", "Café", "東京", "Cedar東京", "Сedar", "Kedar", "İdea", "ＡＢＣ",
    "Cedar & Co", "Cedar's", "Cedar/Co", "https://cedar.com", "hello@cedar.com", "Cedar😀", "Cedar\u200b",
    "", "   ", ".", "-Cedar", "Cedar-", "Cedar..com", "Cedar.c", "xn--cedar", "xn--belan-dsa.com", "a".repeat(64),
  ])("leaves unsupported name %s for an explicit domain choice", name => {
    expect(projectScreeningDomainSuggestion(name)).toBeNull();
  });
});
