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
    <h3>EUIPO exact-name research</h3>
    <p>Search European Union marks by exact name. Similar names, national registers and goods or services relevance require separate review. Your free-text goods and classification notes are not search filters.</p>
    <div className="tm-actions"><button type="button" className="button secondary small" disabled={disabled || pending || !adapter?.ready || !draft.markName.trim() || !jurisdictions.includes("EM")} onClick={() => void search()}>{pending ? "Searching EUIPO…" : "Search exact EU name"}</button>
      {pending && <button type="button" className="button secondary small" onClick={() => { request.current?.abort(); setPending(false); }}>Cancel registry search</button>}</div>
    {!adapter?.ready ? <p>EUIPO access is not connected. Use the official registry links for manual research.</p> : !jurisdictions.includes("EM") && <p>Add European Union (EU) to your requested territories to use this source.</p>}
    {error && <p role="alert" className="tm-error">{error}</p>}
    {research && <div role="status"><p>{research.hits.length ? `${research.hits.length} exact-name records returned for review.` : "No exact-name records were returned in this lookup."} This is partial research, not legal clearance.</p>
      <p>Scope: EUIPO European Union marks. Dataset update date and Nice edition are not supplied by this API. Other requested territories remain unsearched.</p>
      <p>Checked {new Date(research.checkedAt).toLocaleString("en-CA", { timeZone: "America/Toronto", timeZoneName: "short" })}. Results stay in this view and are not saved in the account draft.</p>
      {research.interrupted && <p>The lookup stopped before all requested pages completed. Earlier validated records are retained.</p>}
      <ul>{research.hits.map(hit => <li key={hit.registryId}><a href={`https://euipo.europa.eu/eSearch/#details/trademarks/${hit.registryId}`} target="_blank" rel="noopener noreferrer">{hit.mark} · {hit.registryId}</a> — {hit.status.replaceAll("_", " ")} · classes {hit.niceClasses.join(", ") || "not supplied"}</li>)}</ul>
    </div>}
  </section>;
}
