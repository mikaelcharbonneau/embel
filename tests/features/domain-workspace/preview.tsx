import { createRoot } from "react-dom/client";
import { useState } from "react";
import { DomainsWorkspace } from "../../../src/features/domain-workspace/domain-workspace";
import { domainFixtures } from "../../../src/features/domain-workspace/fixtures";
import { type DomainBrandSource, type DomainSearchAdapter } from "../../../src/features/domain-workspace/model";
import "../../../src/styles/tokens.css";
import "../../../src/styles/globals.css";
import "./preview.css";
const fixture = domainFixtures();
const scenario = new URL(location.href).searchParams.get("scenario") ?? "unavailable";
const adapter: DomainSearchAdapter | undefined = scenario === "unavailable" || scenario === "library" || scenario === "paid" ? undefined : {
  status: "ready", provider: fixture.check.provider,
  check: async (domain, signal) => {
    if (scenario === "never") await new Promise(() => {});
    if (scenario === "timeout") await new Promise(resolve => setTimeout(resolve, 16000));
    if (scenario === "late" || scenario === "switch") await new Promise(resolve => setTimeout(resolve, 300));
    if (signal.aborted) throw new Error("Cancelled fixture");
    if (scenario === "error") throw new Error("Synthetic transport failure");
    if (scenario === "mismatch") return { ...fixture.check, domain: "other.com" };
    const now = Date.now();
    return { ...fixture.check, domain, id: `fixture-${domain}`, availability: scenario === "taken-expiry" || (scenario === "taken" && domain === "northstar.com") ? "taken" : fixture.check.availability, checkedAt: new Date(now - 100).toISOString(), validUntil: new Date(now + (["expiry", "taken-expiry"].includes(scenario) ? 1000 : 60000)).toISOString() };
  },
  quote: async (domain, checkId) => ({ ...fixture.quote, domain, checkId, total: scenario === "sorting" ? { amountMinor: domain.endsWith(".com") ? 3000 : domain.endsWith(".co") ? 1000 : 2000, currency: "USD" } : fixture.quote.total, issuedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + (scenario === "quote-expiry" ? 1000 : 60000)).toISOString() }),
};
function Preview() {
  const [disconnected, setDisconnected] = useState(false);
  const [source, setSource] = useState<DomainBrandSource | null>(null);
  return <><aside style={{ padding: "12px 24px", background: "#FFF0FD", fontSize: 14 }}>Synthetic local Domains fixture · no provider, payment, registration or account service</aside><button type="button" onClick={() => setDisconnected(true)}>Disconnect fixture adapter</button><DomainsWorkspace adapter={disconnected ? undefined : adapter} initialInput="North Star" library={scenario === "library" ? { status: "ready", items: [{ order: fixture.purchased, project: { id: "fixture-brand", title: "Fixture brand" } }, { order: fixture.order, project: null }] } : scenario === "empty" ? { status: "ready", items: [] } : undefined} orders={scenario === "paid" ? [fixture.order, { ...fixture.order, id: "fixture-reconciliation", registration: "needs_reconciliation" }] : []} onCreateBrand={setSource} />{source && <output aria-label="Brand handoff fixture">{JSON.stringify(source)}</output>}</>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
