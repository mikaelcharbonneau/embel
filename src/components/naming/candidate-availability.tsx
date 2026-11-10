"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { createStandaloneLiveAdapters, loadStandaloneCapabilities } from "@/components/tools/standalone-live-client";
import { lookupFailureMessage, type TrademarkLookup } from "@/domain/standalone-live-checks";
import { availabilityAt, normalizeDomain, readDomainCheck, type DomainCheck } from "@/features/domain-workspace/model";
import {
  evidenceSchema,
  platforms,
  type HandleEvidence,
  type HandlePlatform,
} from "@/features/handles-workspace/domain";
import { handleProfileUrl } from "@/features/handles-workspace/manual-tools";
import { matchesLocalHandleSyntax } from "@/features/handles-workspace/search";
import { projectScreeningDomainError, projectScreeningDomainSuggestion } from "./project-screening-domain";
import styles from "./candidate-availability.module.css";

const tools = ["Domains", "Handles", "Trademarks"] as const;
type Tool = (typeof tools)[number];
type Result =
  | { tool: "Domains"; check: DomainCheck }
  | { tool: "Handles"; evidence: HandleEvidence }
  | { tool: "Trademarks"; research: TrademarkLookup };
const registries = [
  { code: "EM", label: "European Union", url: "https://euipo.europa.eu/eSearch/" },
  { code: "US", label: "United States", url: "https://www.uspto.gov/trademarks/search" },
  { code: "CA", label: "Canada", url: "https://ised-isde.canada.ca/cipo/trademark-search/srch?lang=eng" },
] as const;
const providerLabels: Record<string, string> = {
  namecom_core: "Name.com",
  cloudflare_registrar: "Cloudflare",
  vercel_registrar: "Vercel",
  "Public registry RDAP": "the public registry",
};

function Source({ url, label }: { url?: string | null; label: string }) {
  return url ? (
    <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {label}
    </a>
  ) : (
    <span>{label}</span>
  );
}
function CheckedTime({ at }: { at: string }) {
  return (
    <time dateTime={at}>{new Date(at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</time>
  );
}
type Tone = "positive" | "negative" | "neutral";
function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={styles.pill} data-tone={tone}>
      <span className={styles.dot} aria-hidden="true" />
      {children}
    </span>
  );
}
/** Provider details lead with one plain sentence; the remaining qualifications stay one click away. */
function Explanation({ text }: { text: string }) {
  const match = /^(.+?[.!?])\s+(\S[\s\S]*)$/u.exec(text.trim());
  if (!match) return <p>{text}</p>;
  return (
    <>
      <p>{match[1]}</p>
      <details className={styles.more}>
        <summary>Details</summary>
        <p>{match[2]}</p>
      </details>
    </>
  );
}
function Card({
  title,
  status,
  children,
  source,
}: {
  title: string;
  status: ReactNode;
  children?: ReactNode;
  source: ReactNode;
}) {
  return (
    <div className={styles.result} role="status">
      <div className={styles.resultHead}>
        <strong>{title}</strong>
        {status}
      </div>
      {children}
      <small className={styles.meta}>{source}</small>
    </div>
  );
}
function DomainResult({ check }: { check: DomainCheck }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const delay = Date.parse(check.validUntil) - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, delay + 1));
    return () => clearTimeout(timer);
  }, [check, now]);
  const status = availabilityAt(check, now),
    expired = now >= Date.parse(check.validUntil);
  const pill =
    status === "available" ? (
      <Status tone="positive">Available to register</Status>
    ) : status === "taken" ? (
      <Status tone="negative">Taken</Status>
    ) : (
      <Status tone="neutral">{expired ? "Check expired" : "Not confirmed"}</Status>
    );
  return (
    <Card
      title={check.domain}
      status={pill}
      source={
        <>
          Checked with <Source url={check.sourceUrl} label={providerLabels[check.provider] ?? check.provider} /> ·{" "}
          <CheckedTime at={check.checkedAt} />
        </>
      }
    >
      {expired ? (
        <p>This check has expired. Check again for a current result.</p>
      ) : (
        check.detail && <Explanation text={check.detail} />
      )}
    </Card>
  );
}
function Observation({ result }: { result: Result }) {
  if (result.tool === "Domains") return <DomainResult check={result.check} />;
  if (result.tool === "Handles") {
    const { evidence } = result;
    const pill =
      evidence.outcome === "confirmed_available" ? (
        <Status tone="positive">Available</Status>
      ) : evidence.outcome === "taken" ? (
        <Status tone="negative">Taken</Status>
      ) : (
        <Status tone="neutral">Not confirmed</Status>
      );
    return (
      <Card
        title={`@${evidence.handle}`}
        status={pill}
        source={
          <>
            Checked with <Source url={evidence.sourceUrl} label={evidence.source ? "YouTube" : "Lookup"} /> ·{" "}
            <CheckedTime at={evidence.checkedAt ?? evidence.observedAt} />
          </>
        }
      >
        <Explanation text={evidence.detail} />
      </Card>
    );
  }
  const { research } = result;
  const hits = research.hits.length;
  const pill = !research.searched.length ? (
    <Status tone="neutral">Not searched</Status>
  ) : hits ? (
    <Status tone="negative">
      {hits} exact {hits === 1 ? "match" : "matches"}
    </Status>
  ) : (
    <Status tone="positive">No exact match</Status>
  );
  return (
    <Card
      title={research.query.mark}
      status={pill}
      source={
        <>
          Searched <Source url={research.sourceUrl} label="EUIPO" /> · <CheckedTime at={research.checkedAt} />
        </>
      }
    >
      <p>
        {!research.searched.length
          ? "No registry was searched"
          : hits
            ? `${hits} exact-name ${hits === 1 ? "record" : "records"} returned`
            : "No exact-name records returned"}
        . Similar marks and legal clearance have not been assessed.
      </p>
      {research.interrupted && <p>Search interrupted. {lookupFailureMessage[research.interrupted]}</p>}
      {hits > 0 && (
        <details className={styles.more}>
          <summary>Matching records ({hits})</summary>
          <ul>
            {research.hits.map((hit) => (
              <li key={hit.registryId}>
                <Source
                  url={`https://euipo.europa.eu/eSearch/#details/trademarks/${hit.registryId}`}
                  label={`${hit.mark} · ${hit.registryId}`}
                />{" "}
                · {hit.status.replaceAll("_", " ")}
                {hit.niceClasses.length > 0 && ` · Classes ${hit.niceClasses.join(", ")}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

type Props = { name: string; account: VerifiedAccount };

// Domain checks the user ran from a name's details are kept while the page is
// open, so reopening that name shows its last result and when it was checked.
// Only the signed-in account's own checks are kept. Nothing here starts a
// lookup: a domain is checked only when the user clicks Check domain.
let rememberedOwner: string | null = null;
const rememberedDomains = new Map<string, DomainCheck>();
function rememberedDomainChecks(account: VerifiedAccount) {
  if (rememberedOwner !== account.userId) {
    rememberedDomains.clear();
    rememberedOwner = account.userId;
  }
  return rememberedDomains;
}

export function CandidateAvailability({ name, account }: Props) {
  const { isCurrent } = useAccountSession();
  return isCurrent(account) ? (
    <OwnedChecks key={JSON.stringify([account.userId, account.generation, name])} name={name} account={account} />
  ) : null;
}

function OwnedChecks({ name, account }: Props) {
  const { isCurrent } = useAccountSession();
  const [tool, setTool] = useState<Tool>("Domains"),
    id = useId();
  const [suggestedDomain] = useState(() => projectScreeningDomainSuggestion(name));
  const [domain, setDomain] = useState(suggestedDomain ?? "");
  const [handle, setHandle] = useState(name.trim().replace(/\s+/gu, "").toLowerCase());
  const [platform, setPlatform] = useState<HandlePlatform>("youtube");
  const [mark, setMark] = useState(name),
    [region, setRegion] = useState("EM");
  const [adapters, setAdapters] = useState<ReturnType<typeof createStandaloneLiveAdapters> | null>(null);
  const [connectionError, setConnectionError] = useState(false),
    [attempt, retry] = useState(0);
  const [results, setResults] = useState<Partial<Record<Tool, Result>>>(() => {
    const earlier = suggestedDomain ? rememberedDomainChecks(account).get(suggestedDomain) : undefined;
    return earlier ? { Domains: { tool: "Domains", check: earlier } } : {};
  });
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const { userId, generation } = account;
  useEffect(() => {
    const controller = new AbortController();
    const captured = { status: "ready" as const, userId, generation };
    const binding = { ownerId: userId, signal: controller.signal, isCurrent: () => isCurrent(captured) };
    void loadStandaloneCapabilities(binding)
      .then((caps) => {
        if (!controller.signal.aborted && binding.isCurrent()) setAdapters(createStandaloneLiveAdapters(caps, binding));
      })
      .catch(() => {
        if (!controller.signal.aborted && binding.isCurrent()) setConnectionError(true);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [userId, generation, isCurrent, attempt]);

  const registry = registries.find((r) => r.code === region)!;
  const exactHandle = handle.trim().replace(/^@/u, "").toLowerCase();
  const domainError = projectScreeningDomainError(domain),
    validHandle = matchesLocalHandleSyntax(platform, exactHandle);
  function criteriaNotice(): string {
    if (tool === "Domains")
      return (
        domainError ?? (adapters?.domains.status === "unavailable" ? "Domain checks aren’t available right now." : "")
      );
    if (tool === "Handles") {
      if (platform !== "youtube") return "Embel can only check YouTube handles for now.";
      if (!validHandle) return "Use a 3–30 character YouTube handle with letters or digits at both ends.";
      return adapters?.handles.availability === "unavailable" ? "YouTube checks are not connected." : "";
    }
    if (!mark.trim()) return "Enter a word mark to search.";
    if (region !== "EM") return "Live trademark search covers the European Union only.";
    return adapters && !adapters.trademarks.ready ? "EUIPO search is not connected." : "";
  }
  const notice = criteriaNotice();
  const result = results[tool];
  const manual =
    tool === "Domains"
      ? !domainError && {
          label: "Open ICANN lookup",
          url: `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(normalizeDomain(domain))}`,
        }
      : tool === "Handles"
        ? validHandle && { label: "Open profile", url: handleProfileUrl({ platform, handle: exactHandle }) }
        : { label: "Open registry", url: registry.url };

  function stop() {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setError("");
  }
  function edit(change: () => void) {
    stop();
    setResults((old) => ({ ...old, [tool]: undefined }));
    change();
  }
  function select(next: Tool) {
    if (next !== tool) {
      stop();
      setTool(next);
    }
  }
  async function check() {
    if (!adapters || !isCurrent(account) || request.current || notice) return;
    const pending = new AbortController();
    request.current = pending;
    setBusy(true);
    setError("");
    setResults((old) => ({ ...old, [tool]: undefined }));
    const current = () => !pending.signal.aborted && request.current === pending && isCurrent(account);
    try {
      let observation: Result;
      if (tool === "Domains")
        observation = { tool, check: await readDomainCheck(adapters.domains, normalizeDomain(domain), pending.signal) };
      else if (tool === "Handles")
        observation = {
          tool,
          evidence: evidenceSchema.parse(
            await adapters.handles.check({ platform, handle: exactHandle }, pending.signal),
          ),
        };
      else
        observation = {
          tool,
          research: await adapters.trademarks.search(
            { tool: "trademarks", mark: mark.trim(), jurisdictions: [region], niceClasses: [], mode: "exact_word" },
            pending.signal,
          ),
        };
      if (current()) {
        if (observation.tool === "Domains")
          rememberedDomainChecks(account).set(observation.check.domain, observation.check);
        setResults((old) => ({ ...old, [tool]: observation }));
      }
    } catch (cause) {
      if (current()) setError(cause instanceof Error ? cause.message : "The lookup could not be completed.");
    } finally {
      if (current()) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section className={styles.section} aria-label="Candidate availability">
      <div className={styles.tabs} role="tablist" aria-label="Availability tools">
        {tools.map((tab, index) => (
          <button
            key={tab}
            role="tab"
            type="button"
            id={`${id}-${tab}`}
            aria-selected={tool === tab}
            aria-controls={`${id}-panel`}
            tabIndex={tool === tab ? 0 : -1}
            onClick={() => select(tab)}
            onKeyDown={(event) => {
              const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!delta && event.key !== "Home" && event.key !== "End") return;
              event.preventDefault();
              const next =
                tools[
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tools.length - 1
                      : (index + tools.length + delta) % tools.length
                ]!;
              select(next);
              document.getElementById(`${id}-${next}`)?.focus();
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tool}`}>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void check();
          }}
        >
          {tool === "Domains" && (
            <label>
              Domain
              <input
                value={domain}
                onChange={(e) => edit(() => setDomain(e.target.value))}
                maxLength={253}
                placeholder="example.com"
                spellCheck={false}
              />
            </label>
          )}
          {tool === "Handles" && (
            <>
              <label>
                Platform
                <select value={platform} onChange={(e) => edit(() => setPlatform(e.target.value as HandlePlatform))}>
                  {platforms.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Handle
                <input
                  value={handle}
                  onChange={(e) => edit(() => setHandle(e.target.value))}
                  maxLength={65}
                  spellCheck={false}
                />
              </label>
            </>
          )}
          {tool === "Trademarks" && (
            <>
              <label>
                Jurisdiction
                <select value={region} onChange={(e) => edit(() => setRegion(e.target.value))}>
                  {registries.map((r) => (
                    <option key={r.code} value={r.code}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Word mark
                <input value={mark} onChange={(e) => edit(() => setMark(e.target.value))} maxLength={160} />
              </label>
            </>
          )}
          <button className="button secondary" type="submit" disabled={!adapters || busy || Boolean(notice)}>
            {tool === "Domains" ? "Check domain" : tool === "Handles" ? "Check handle" : "Search trademarks"}
          </button>
        </form>
        {busy && (
          <div className={styles.status}>
            <span role="status">Checking…</span>
            <button type="button" className="text-link" onClick={stop}>
              Cancel check
            </button>
          </div>
        )}
        {connectionError && (
          <div className={styles.status}>
            <span role="alert">Lookup connections could not be checked.</span>
            <button
              type="button"
              className="text-link"
              onClick={() => {
                setConnectionError(false);
                retry((n) => n + 1);
              }}
            >
              Retry connection
            </button>
          </div>
        )}
        {!adapters && !connectionError && <p role="status">Checking lookup connections…</p>}
        {notice && <p>{notice}</p>}
        {error && <p role="alert">{error}</p>}
        {(notice || error || connectionError) && manual && (
          <p>
            <Source url={manual.url} label={manual.label} />
          </p>
        )}
        {result && <Observation result={result} />}
      </div>
    </section>
  );
}
