"use client";

import { useEffect, useRef, useState } from "react";
import { ButtonAnchor, Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { lookupFailureMessage, type TrademarkLookup } from "@/domain/standalone-live-checks";
import { checkedTime, type LiveChecks } from "./use-live-checks";
import styles from "./name-details.module.css";

const otherRegisters = [
  { label: "US trademark search", url: "https://www.uspto.gov/trademarks/search" },
  { label: "Canadian trademark search", url: "https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng" },
  { label: "WIPO Global Brand Database", url: "https://branddb.wipo.int/" },
] as const;
const EUIPO_SEARCH = "https://euipo.europa.eu/eSearch/";

/** The EU register is searched live when it is connected; other registers are linked. Never legal clearance. */
export function TrademarksPanel({
  name,
  account,
  trademarks,
}: {
  name: string;
  account: VerifiedAccount;
  trademarks: LiveChecks["trademarks"] | null;
}) {
  const { isCurrent } = useAccountSession();
  const [mark, setMark] = useState(name);
  const [research, setResearch] = useState<TrademarkLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  const ready = Boolean(trademarks?.ready);

  async function search() {
    if (!trademarks || !ready || run.current || !mark.trim() || !isCurrent(account)) return;
    const controller = new AbortController();
    run.current = controller;
    setBusy(true);
    setError(null);
    setResearch(null);
    const live = () => !controller.signal.aborted && run.current === controller && isCurrent(account);
    try {
      const found = await trademarks.search(
        { tool: "trademarks", mark: mark.trim(), jurisdictions: ["EM"], niceClasses: [], mode: "exact_word" },
        controller.signal,
      );
      if (live()) setResearch(found);
    } catch (cause) {
      if (live()) setError(cause instanceof Error ? cause.message : "The EU register could not be searched.");
    } finally {
      if (run.current === controller) {
        run.current = null;
        setBusy(false);
      }
    }
  }
  const hits = research?.hits.length ?? 0;
  return (
    <div className="e-stack">
      <form
        className="e-stack"
        aria-label="Trademarks"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <div className={styles.markFields}>
          <TextField
            label="Word mark"
            value={mark}
            maxLength={160}
            onChange={(event) => {
              run.current?.abort();
              run.current = null;
              setBusy(false);
              setResearch(null);
              setMark(event.target.value);
            }}
          />
          <TextField label="Register" value="European Union (EUIPO)" readOnly />
        </div>
        {ready ? (
          <div>
            <Button type="submit" variant="primary" icon="search" loading={busy} disabled={!mark.trim()}>
              Search the EU register
            </Button>
          </div>
        ) : (
          <InlineMessage
            actions={
              <ButtonAnchor href={EUIPO_SEARCH} target="_blank" rel="noopener noreferrer" icon="external-link">
                Open the EU register
              </ButtonAnchor>
            }
          >
            {trademarks === null
              ? "Checking which lookups are connected…"
              : "Embel can’t search the EU register right now. You can search it yourself."}
          </InlineMessage>
        )}
      </form>
      {error && <InlineMessage tone="danger">{error}</InlineMessage>}
      {research && (
        <InlineMessage
          tone={!research.searched.length ? "warning" : hits ? "warning" : "neutral"}
          title={
            !research.searched.length
              ? "The EU register was not searched"
              : hits
                ? `${hits} exact ${hits === 1 ? "match" : "matches"} in the EU register`
                : "No exact match in the EU register"
          }
        >
          <p>
            Searched{" "}
            <a href={research.sourceUrl ?? EUIPO_SEARCH} target="_blank" rel="noopener noreferrer">
              EUIPO
            </a>{" "}
            for the exact words “{research.query.mark}” ·{" "}
            <time dateTime={research.checkedAt}>{checkedTime(research.checkedAt)}</time>. This is partial research, not
            legal clearance.
          </p>
          {research.interrupted && <p>Search interrupted. {lookupFailureMessage[research.interrupted]}</p>}
          {hits > 0 && (
            <ul className={styles.hits}>
              {research.hits.map((hit) => (
                <li key={hit.registryId}>
                  <a
                    href={`https://euipo.europa.eu/eSearch/#details/trademarks/${hit.registryId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {hit.mark} · {hit.registryId}
                  </a>{" "}
                  · {hit.status.replaceAll("_", " ")}
                  {hit.niceClasses.length > 0 && ` · Classes ${hit.niceClasses.join(", ")}`}
                </li>
              ))}
            </ul>
          )}
        </InlineMessage>
      )}
      <section className="e-stack e-stack--sm" aria-label="Search other registers yourself">
        <h3 className={styles.groupTitle}>Search other registers yourself</h3>
        <div className="e-cluster">
          {otherRegisters.map((register) => (
            <ButtonAnchor
              key={register.url}
              href={register.url}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              icon="external-link"
            >
              {register.label}
            </ButtonAnchor>
          ))}
        </div>
      </section>
    </div>
  );
}
