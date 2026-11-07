"use client";

import { useEffect, useRef, useState } from "react";
import { type TrademarkLookup } from "@/domain/standalone-live-checks";
import { type TrademarkDraft } from "@/features/trademark-workspace/domain";
import { type TrademarkLookupAdapter } from "./standalone-live-client";

const territoryCodes: Record<string, string> = { "european union": "EM", eu: "EM", em: "EM", canada: "CA", ca: "CA", "united states": "US", usa: "US", us: "US", "united kingdom": "GB", uk: "GB", gb: "GB" };
export function trademarkLookupTerritories(territories: string[]): string[] {
  return [...new Set(territories.filter(value => value.trim()).map((value, index) => territoryCodes[value.trim().toLowerCase()] ?? (/^[A-Z]{2}$/.test(value.trim().toUpperCase()) ? value.trim().toUpperCase() : `UNREVIEWED-${index + 1}`)))];
}
/** Parent keys this transient research by exact draft criteria and account generation. */
export function TrademarkLiveResearch({ draft, adapter, disabled }: { draft: TrademarkDraft; adapter: TrademarkLookupAdapter | undefined; disabled: boolean }) {
  const [research, setResearch] = useState<TrademarkLookup | null>(null);
  const [error, setError] = useState(""); const [pending, setPending] = useState(false);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => { request.current?.abort(); }, [adapter]);
  const jurisdictions = trademarkLookupTerritories(draft.territories);
  async function search() {
    if (disabled || !adapter?.ready || !draft.markName.trim() || !jurisdictions.includes("EM")) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setPending(true); setError(""); setResearch(null);
    try {
      const result = await adapter.search({ tool: "trademarks", mark: draft.markName.trim(), jurisdictions, niceClasses: [], mode: "exact_word" }, controller.signal);
      if (!controller.signal.aborted && request.current === controller) setResearch(result);
    } catch (cause) { if (!controller.signal.aborted && request.current === controller) setError(cause instanceof Error ? cause.message : "The registry could not be reached."); }
    finally { if (!controller.signal.aborted && request.current === controller) setPending(false); }
  }
  return <section className="tm-research-details" aria-label="EUIPO live research">
    <h3>EU register: exact name</h3>
    <p>Search the European Union trademark register for this exact name. Check similar names and national registers yourself.</p>
    <div className="tm-actions"><button type="button" className="button secondary small" disabled={disabled || pending || !adapter?.ready || !draft.markName.trim() || !jurisdictions.includes("EM")} onClick={() => void search()}>{pending ? "Searching EUIPO…" : "Search exact EU name"}</button>
      {pending && <button type="button" className="button secondary small" onClick={() => { request.current?.abort(); setPending(false); }}>Cancel registry search</button>}</div>
    {!adapter?.ready ? <p>The EU register search isn’t available right now. Use the registry links above.</p> : !jurisdictions.includes("EM") && <p>Add European Union to your territories to search the EU register.</p>}
    {error && <p role="alert" className="tm-error">{error}</p>}
    {research && <div role="status"><p>{research.hits.length ? `${research.hits.length} exact-name records returned for review.` : "No exact-name records were returned in this lookup."} This is partial research, not legal clearance.</p>
      <p>This covers EU trademarks only. Your other territories haven’t been searched.</p>
      <p>Checked {new Date(research.checkedAt).toLocaleString("en-CA", { timeZone: "America/Toronto", timeZoneName: "short" })}.</p>
      {research.interrupted && <p>The search stopped early. The results found so far are shown.</p>}
      <ul>{research.hits.map(hit => <li key={hit.registryId}><a href={`https://euipo.europa.eu/eSearch/#details/trademarks/${hit.registryId}`} target="_blank" rel="noopener noreferrer">{hit.mark} · {hit.registryId}</a> — {hit.status.replaceAll("_", " ")} · classes {hit.niceClasses.join(", ") || "not supplied"}</li>)}</ul>
    </div>}
  </section>;
}
