"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import {
  availabilityAt, domainOrderSchema, orderLabel, prepareDomainSearch, purchasedDomainSchema,
  quoteBlockReason, readDomainCheck, readDomainQuote, unavailableDomainAdapter,
  type DomainBrandSource, type DomainCheck, type DomainLibrary, type DomainOrder,
  type DomainQuote, type DomainSearchAdapter,
} from "./model";
import { domainDraftSchema, emptyDomainDraft, type DomainDraft } from "./draft";
import styles from "./domain-workspace.module.css";

export type DomainsWorkspaceProps = {
  adapter?: DomainSearchAdapter;
  library?: DomainLibrary;
  /** Already owner-verified order records; invalid records are excluded explicitly. */
  orders?: unknown[];
  initialInput?: string;
  initialView?: "library" | "search";
  /** Controlled manual draft, validated by the account adapter before rendering. */
  draft?: DomainDraft;
  onDraftChange?: (draft: DomainDraft) => void;
  draftDisabled?: boolean;
  draftNotice?: string;
  draftControls?: ReactNode;
  onCreateBrand?: (source: DomainBrandSource) => void;
};
type Row = { domain: string; check: DomainCheck | null; quote: DomainQuote | null; status: "idle" | "checking" | "quoting"; error: string | null; requestAdapter?: DomainSearchAdapter };
function blankRows(domains: string[]): Row[] { return domains.map(domain => ({ domain, check: null, quote: null, status: "idle", error: null })); }
const defaultLibrary = { status: "unavailable", message: "Purchased-domain records are not connected." } as const;
function date(value: string) { return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`; }
function money(value: DomainQuote["total"]) {
  try {
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: value.currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(value.amountMinor / 10 ** digits);
  } catch { return `${value.amountMinor} minor units ${value.currency}`; }
}

/** The account/session wrapper must remount this component whenever ownership changes. */
export function DomainsWorkspace({ adapter = unavailableDomainAdapter, library = defaultLibrary, orders = [], initialInput = "", initialView = "library", draft, onDraftChange, draftDisabled = false, draftNotice = "Candidates stay in this tab until you leave.", draftControls, onCreateBrand }: DomainsWorkspaceProps) {
  const uid = useId();
  const [tab, setTab] = useState<"library" | "search">(initialView);
  const [localDraft, setLocalDraft] = useState(() => emptyDomainDraft(initialInput));
  const currentDraft = draft ?? localDraft;
  const { input, extensions, candidates } = currentDraft;
  const searchKey = JSON.stringify(currentDraft);
  const [storedRows, setStoredRows] = useState<{ key: string; value: Row[] } | null>(null);
  const rows = storedRows?.key === searchKey ? storedRows.value : blankRows(candidates);
  const setRows = useCallback((update: (current: Row[]) => Row[]) => {
    setStoredRows(current => ({ key: searchKey, value: update(current?.key === searchKey ? current.value : blankRows(candidates)) }));
  }, [candidates, searchKey]);
  const editingDisabled = draftDisabled || Boolean(draft && !onDraftChange);
  const [preparationErrors, setPreparationErrors] = useState<{ key: string; messages: string[] } | null>(null);
  const errors = preparationErrors?.key === searchKey ? preparationErrors.messages : [];
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const pending = useRef(new Map<string, AbortController>());
  const generation = useRef(0);
  useEffect(() => {
    const requests = pending.current, lifecycle = generation;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(timer); lifecycle.current++; requests.forEach(controller => controller.abort()); requests.clear(); };
  }, [adapter, searchKey]);
  function changeDraft(next: DomainDraft) {
    if (editingDisabled) return;
    const parsed = domainDraftSchema.safeParse(next);
    if (!parsed.success) { setPreparationErrors({ key: searchKey, messages: ["This search is too large to keep as one draft. Use fewer names or extensions."] }); return; }
    generation.current++;
    pending.current.forEach(controller => controller.abort()); pending.current.clear();
    setStoredRows(null); setPreparationErrors(null);
    setLocalDraft(parsed.data);
    onDraftChange?.(parsed.data);
  }
  function prepare() {
    if (editingDisabled) return;
    const prepared = prepareDomainSearch(input, extensions);
    setPreparationErrors({ key: searchKey, messages: prepared.errors.map(error => `${error.line ? `Line ${error.line}: ` : ""}${error.message}`) });
    if (prepared.errors.length) return;
    changeDraft({ ...currentDraft, candidates: prepared.domains });
  }
  const handleRead = useCallback(async (row: Row, operation: "check" | "quote") => {
    // Prevent a double-click before React renders the pending state.
    if (pending.current.has(row.domain) || adapter.status !== "ready") return;
    const controller = new AbortController(), version = generation.current;
    pending.current.set(row.domain, controller);
    setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: operation === "check" ? "checking" : "quoting", requestAdapter: adapter, error: null, ...(operation === "check" ? { check: null, quote: null } : { quote: null }) } : item));
    const timer = setTimeout(() => {
      controller.abort();
      if (version === generation.current) setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: "idle", error: "Request timed out. Try again." } : item));
      if (pending.current.get(row.domain) === controller) pending.current.delete(row.domain);
    }, 15000);
    try {
      const result = operation === "check"
        ? await readDomainCheck(adapter, row.domain, controller.signal)
        : await readDomainQuote(adapter, row.check!, Date.now, controller.signal);
      if (controller.signal.aborted || version !== generation.current) return;
      setNow(Date.now());
      setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: "idle", ...(operation === "check" ? { check: result as DomainCheck } : { quote: result as DomainQuote }) } : item));
    } catch {
      if (!controller.signal.aborted && version === generation.current) setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: "idle", error: operation === "check" ? "The check could not be verified. Availability remains unknown. Try again." : "The quote could not be verified. Try a fresh check and quote." } : item));
    } finally {
      clearTimeout(timer);
      if (pending.current.get(row.domain) === controller) pending.current.delete(row.domain);
    }
  }, [adapter, setRows]);
  const parsedItems = library.status === "ready" ? library.items.slice(0, 1000).map(item => purchasedDomainSchema.safeParse(item)) : [];
  const items = parsedItems.flatMap(parsed => parsed.success && Date.parse(parsed.data.order.confirmation!.confirmedAt) <= now ? [parsed.data] : []);
  const uniqueItems = items.filter((item, index) => items.findIndex(other => other.order.id === item.order.id) === index);
  const validOrders: DomainOrder[] = orders.slice(0, 1000).flatMap(value => { const parsed = domainOrderSchema.safeParse(value); return parsed.success && (!parsed.data.confirmation || Date.parse(parsed.data.confirmation.confirmedAt) <= now) ? [parsed.data] : []; });
  const matches = uniqueItems.filter(item => `${item.order.domain} ${item.project?.title ?? ""}`.toLowerCase().includes(filter.toLowerCase().trim()));
  return <div className={`page ${styles.workspace}`}>
    <header className={styles.heading}><div><h1>Domains</h1><p>Prepare searches and review domains purchased through Fluid.</p></div><span className="small-badge">{adapter.status === "ready" ? "Search connected" : "Registrar not connected"}</span></header>
    {draftControls}
    <nav className={styles.tabs} aria-label="Domain views">{(["library", "search"] as const).map(value => <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "library" ? "Library" : "Search"}</button>)}</nav>
    {tab === "library" ? <section aria-label="Purchased domains" className={styles.panel}>
      <div className={styles.sectionHeading}><h2>Purchased in Fluid</h2><label className={styles.librarySearch}><span className="sr-only">Search purchased domains</span><input type="search" placeholder="Search domain or brand" value={filter} onChange={event => setFilter(event.target.value)} /></label></div>
      <p className={styles.muted}>Only registrar-confirmed Fluid purchases appear here. Search candidates and pending orders stay separate.</p>
      {library.status === "loading" ? <p role="status">Loading purchased domains…</p> : library.status === "error" ? <p role="alert">{library.message ?? "Purchased domains could not be loaded."}</p> : library.status === "unavailable" ? <div className={styles.empty}><Icon name="domains" size={28} /><h3>Domain library unavailable</h3><p>{library.message ?? defaultLibrary.message}</p><button type="button" className="button secondary small" onClick={() => setTab("search")}>Prepare a domain search</button></div> : <>
        {(items.length !== parsedItems.length || (library.status === "ready" && library.items.length > 1000)) && <p role="alert">Some records are unverified or beyond this view’s limit and are not shown. Refresh through the account integration.</p>}
        {matches.length ? <ul className={styles.library}>{matches.map(item => <li key={item.order.id}><div><h3>{item.order.domain}</h3><p>{item.project?.title ?? "No linked brand"}</p><p className={styles.muted}>{item.order.provider} · confirmed {date(item.order.confirmation!.confirmedAt)}</p><p className={styles.muted}>{item.order.confirmation!.expiresAt ? `Recorded expiry: ${date(item.order.confirmation!.expiresAt)}` : "Expiry not supplied"}</p><span className={styles.badge}>Registration confirmed at purchase</span></div><button type="button" className="button secondary small" disabled={!onCreateBrand} onClick={() => onCreateBrand?.({ type: "domain", domain: item.order.domain, check: null, order: item.order })}>Create brand from domain</button></li>)}</ul> : <div className={styles.empty}><Icon name="domains" size={28} /><h3>{filter ? "No matching purchased domains" : "No confirmed purchases yet"}</h3><p>{filter ? "Try another domain or brand name." : "Prepare names to check in Search. Registration appears here after the registrar confirms it."}</p><button type="button" className="button secondary small" onClick={() => setTab("search")}>Prepare a domain search</button></div>}
      </>}
      {!onCreateBrand && <p className={styles.muted}>Brand creation from a domain is not connected.</p>}
    </section> : <section aria-label="Domain search workspace">
      <form className={styles.panel} onSubmit={event => { event.preventDefault(); prepare(); }}>
        <label className={styles.inputLabel} htmlFor={`${uid}-names`}>Names or full domains</label><textarea id={`${uid}-names`} rows={3} maxLength={4000} disabled={editingDisabled} value={input} onChange={event => changeDraft({ ...currentDraft, input: event.target.value, candidates: [] })} placeholder={"North Star\nnorthstar.com"} aria-describedby={`${uid}-help`} />
        <p className={styles.muted} id={`${uid}-help`}>Separate up to 20 entries with commas or new lines. Spaces in names are removed; full domains keep their extension. ASCII names only.</p>
        <fieldset className={styles.extensions} disabled={editingDisabled}><legend>Extensions for names</legend>{[...new Set(["com", "co", "io", "net", "org", ...extensions])].map(extension => <label key={extension}><input type="checkbox" checked={extensions.includes(extension)} onChange={event => changeDraft({ ...currentDraft, extensions: event.target.checked ? [...extensions, extension] : extensions.filter(item => item !== extension), candidates: [] })} />.{extension}</label>)}</fieldset>
        <div className={styles.actions}><button type="submit" className="button primary" disabled={editingDisabled}>Prepare search<Icon name="arrow" size={15} /></button><span className={styles.muted}>{draftNotice}</span></div>
        {errors.length > 0 && <div role="alert">{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      </form>
      <div className={styles.notice}><Icon name="offline" size={18} /><p>{adapter.status === "unavailable" ? adapter.reason : `Checks supplied by ${adapter.provider}. Each result shows its own evidence and validity.`} Extension choices prepare candidates; registrar support is not assumed.</p></div>
      {rows.length > 0 && <div className={styles.panel}><div className={styles.sectionHeading}><h2>Prepared domains</h2><span className={styles.muted}>{rows.length} candidates</span></div><p className={styles.muted}>Availability is unknown until a current provider check confirms it.</p><ul className={styles.results}>{rows.map(row => {
        const availability = availabilityAt(row.check, now), busy = row.status !== "idle" && row.requestAdapter === adapter;
        const block = row.quote ? quoteBlockReason(row.quote, row.check, now) : null;
        return <li key={row.domain}><div className={styles.rowHeading}><h3>{row.domain}</h3><span className={styles.badge} role="status" aria-label={`${row.domain} availability`}>{busy && row.status === "checking" ? "Checking…" : availability === "available" ? "Confirmed available" : availability === "taken" ? "Taken" : "Unknown"}</span></div>
          <p className={styles.muted}>{row.check ? `${row.check.provider} · checked ${date(row.check.checkedAt)} · valid until ${date(row.check.validUntil)} · evidence ${row.check.evidenceReference}${availability === "unknown" && row.check.availability !== "unknown" ? " · evidence expired or not current" : ""}` : "No availability evidence."}</p>
          {row.status !== "idle" && !busy && <p role="status">Previous request cancelled after a connection change.</p>}
          {row.error && <p role="alert">{row.error}</p>}
          <div className={styles.actions}><button type="button" className="button secondary small" disabled={busy || adapter.status !== "ready"} onClick={() => void handleRead(row, "check")}>{row.check || row.error ? "Check again" : "Check availability"}<span className="sr-only"> for {row.domain}</span></button><button type="button" className="button secondary small" disabled={busy || availability !== "available" || adapter.status !== "ready" || !adapter.quote || adapter.provider !== row.check?.provider} onClick={() => void handleRead(row, "quote")}>{busy && row.status === "quoting" ? "Requesting quote…" : "Request quote"}<span className="sr-only"> for {row.domain}</span></button><button type="button" className={styles.textButton} disabled={!onCreateBrand || busy} onClick={() => onCreateBrand?.({ type: "domain", domain: row.domain, check: row.check, order: null })}>Create brand<span className="sr-only"> from {row.domain}</span></button></div>
          {row.quote && <div className={styles.quote} aria-label={`Quote for ${row.domain}`}><h4>Quote review</h4><dl><div><dt>Registration period</dt><dd>{row.quote.periodYears} {row.quote.periodYears === 1 ? "year" : "years"}</dd></div><div><dt>Total quoted</dt><dd>{money(row.quote.total)}</dd></div><div><dt>Renewal price</dt><dd>{row.quote.renewal ? money(row.quote.renewal) : "Not supplied"}</dd></div><div><dt>Renewal terms</dt><dd>{row.quote.renewalTerms}</dd></div><div><dt>Valid until</dt><dd>{date(row.quote.expiresAt)}</dd></div><div><dt>Provider / quote</dt><dd>{row.quote.provider} / {row.quote.id}</dd></div></dl>{block && <p role="status">{block}</p>}<button type="button" className="button secondary small" disabled>Purchase unavailable</button><p className={styles.muted}>Checkout is not connected. A new check, reviewed contact details and explicit order approval are required before any purchase.</p></div>}
        </li>;
      })}</ul>{!onCreateBrand && <p className={styles.muted}>Brand creation from a domain is not connected.</p>}</div>}
    </section>}
    {validOrders.length > 0 && <section className={styles.panel} aria-label="Domain orders"><h2>Orders</h2><p className={styles.muted}>Payment confirmation alone does not confirm domain registration.</p><ul className={styles.results}>{validOrders.map(order => <li key={order.id}><h3>{order.domain}</h3><p>{orderLabel(order)}</p><p className={styles.muted}>Payment: {order.payment}{order.paymentReference ? ` · payment reference ${order.paymentReference}` : ""}</p><p className={styles.muted}>{order.provider} · order {order.id}{order.confirmation ? ` · registrar reference ${order.confirmation.registrationReference}` : " · no registration confirmation"}</p></li>)}</ul></section>}
    {validOrders.length !== orders.length && <p role="alert">Some order records could not be verified and are not shown.</p>}
    <p className={styles.footer}>Purchases are unavailable. Preparing a search or creating a brand does not reserve or register a domain.</p>
  </div>;
}
