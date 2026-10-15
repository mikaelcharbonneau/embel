"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { BrowserNameDialog } from "@/components/naming/browser-name-picker";
import {
  availabilityAt, domainOrderSchema, DomainLookupError, orderLabel, prepareDomainSearch, purchasedDomainSchema,
  quoteBlockReason, readDomainCheck, readDomainQuote, unavailableDomainAdapter,
  type DomainBrandSource, type DomainCheck, type DomainLibrary, type DomainOrder,
  type DomainQuote, type DomainSearchAdapter,
} from "./model";
import { domainDraftSchema, domainDraftShortlistedDomains, emptyDomainDraft, toggleDomainShortlist, type DomainDraft } from "./draft";
import { DomainFilters, DomainNameInput, defaultViewFilters, type DomainViewFilters } from "./domain-search-controls";
import { boundedDomainRead, DomainReadCancelled, DomainReadTimeout } from "./bounded-read";
import { DomainResultTools, type DomainReadOutcome } from "./result-tools";
import styles from "./domain-workspace.module.css";

export type DomainsWorkspaceProps = {
  adapter?: DomainSearchAdapter;
  library?: DomainLibrary;
  /** Already owner-verified order records; invalid records are excluded explicitly. */
  orders?: unknown[];
  initialInput?: string;
  initialView?: "library" | "search" | "shortlist";
  /** Controlled manual draft, validated by the account adapter before rendering. */
  draft?: DomainDraft;
  onDraftChange?: (draft: DomainDraft) => void;
  draftDisabled?: boolean;
  draftNotice?: string;
  draftControls?: ReactNode;
  onOpenNameLibrary?: () => void;
  onCreateBrand?: (source: DomainBrandSource) => void;
};
type Row = { domain: string; check: DomainCheck | null; quote: DomainQuote | null; status: "idle" | "checking" | "quoting"; error: string | null; requestAdapter?: DomainSearchAdapter };
function blankRows(domains: string[]): Row[] { return domains.map(domain => ({ domain, check: null, quote: null, status: "idle", error: null })); }
const defaultLibrary = { status: "unavailable", message: "Purchased-domain records are not connected." } as const;
function date(value: string) { return new Date(value).toLocaleString("en-CA", { timeZone: "America/Toronto", timeZoneName: "short" }); }
function money(value: DomainQuote["total"]) {
  try {
    const formatter = new Intl.NumberFormat("en", { style: "currency", currency: value.currency });
    const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(value.amountMinor / 10 ** digits);
  } catch { return `${value.amountMinor} minor units ${value.currency}`; }
}

/** The account/session wrapper must remount this component whenever ownership changes. */
export function DomainsWorkspace({ adapter = unavailableDomainAdapter, library = defaultLibrary, orders = [], initialInput = "", initialView = "library", draft, onDraftChange, draftDisabled = false, draftNotice = "Candidates stay in this tab until you leave.", draftControls, onOpenNameLibrary, onCreateBrand }: DomainsWorkspaceProps) {
  const uid = useId();
  const [tab, setTab] = useState<"library" | "search" | "shortlist">(initialView);
  const [localDraft, setLocalDraft] = useState(() => emptyDomainDraft(initialInput));
  const currentDraft = draft ?? localDraft;
  const { input, extensions, candidates } = currentDraft;
  const shortlisted = useMemo(() => domainDraftShortlistedDomains(currentDraft), [currentDraft]);
  const [filtersExpanded, setFiltersExpanded] = useState(!candidates.length);
  const [viewFilters, setViewFilters] = useState<DomainViewFilters>({ ...defaultViewFilters });
  const [nameInputVersion, setNameInputVersion] = useState(0);
  const [expandedRows, setExpandedRows] = useState<string[]>([]);
  const [sort, setSort] = useState<{ key: "price" | "domain" | "registrar"; descending: boolean }>({ key: "price", descending: false });
  // A shortlist edit does not change the searched names or invalidate live evidence.
  const searchKey = JSON.stringify({ input, extensions, candidates });
  const allDomains = useMemo(() => [...new Set([...candidates, ...shortlisted])], [candidates, shortlisted]);
  const [storedRows, setStoredRows] = useState<{ key: string; value: Row[] } | null>(null);
  const evidenceRows = allDomains.map(domain => (storedRows?.key === searchKey ? storedRows.value.find(row => row.domain === domain) : null) ?? blankRows([domain])[0]!);
  const rows = (tab === "shortlist" ? shortlisted : candidates).map(domain => evidenceRows.find(row => row.domain === domain)!);
  const setRows = useCallback((update: (current: Row[]) => Row[]) => {
    setStoredRows(current => ({ key: searchKey, value: update(allDomains.map(domain => (current?.key === searchKey ? current.value.find(row => row.domain === domain) : null) ?? blankRows([domain])[0]!)) }));
  }, [allDomains, searchKey]);
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
  function changeDraft(next: DomainDraft, resetSearch = true) {
    if (editingDisabled) return;
    const parsed = domainDraftSchema.safeParse(next);
    if (!parsed.success) { setPreparationErrors({ key: searchKey, messages: ["This search is too large to keep as one draft. Use fewer names or extensions."] }); return; }
    if (resetSearch) {
      generation.current++;
      pending.current.forEach(controller => controller.abort()); pending.current.clear();
      setStoredRows(null);
      setExpandedRows([]);
    }
    setPreparationErrors(null);
    setLocalDraft(parsed.data);
    onDraftChange?.(parsed.data);
  }
  function toggleShortlist(domain: string) {
    if (editingDisabled) return;
    try { changeDraft(toggleDomainShortlist(currentDraft, domain), false); }
    catch { setPreparationErrors({ key: searchKey, messages: ["This shortlist is full or the draft is too large. Remove a domain before adding another."] }); }
  }
  function prepare() {
    if (editingDisabled) return;
    const prepared = prepareDomainSearch(input, extensions);
    setPreparationErrors({ key: searchKey, messages: prepared.errors.map(error => `${error.line ? `Line ${error.line}: ` : ""}${error.message}`) });
    if (prepared.errors.length) return;
    changeDraft({ ...currentDraft, candidates: prepared.domains });
    setNameInputVersion(value => value + 1);
    setFiltersExpanded(false);
  }
  const handleRead = useCallback(async (row: Row, operation: "check" | "quote", batchSignal?: AbortSignal): Promise<DomainReadOutcome> => {
    // Prevent a double-click before React renders the pending state.
    if (batchSignal?.aborted) return "cancelled";
    if (pending.current.has(row.domain) || adapter.status !== "ready") return "skipped";
    const controller = new AbortController(), version = generation.current;
    const cancel = () => controller.abort();
    batchSignal?.addEventListener("abort", cancel, { once: true });
    pending.current.set(row.domain, controller);
    setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: operation === "check" ? "checking" : "quoting", requestAdapter: adapter, error: null, ...(operation === "check" ? { check: null, quote: null } : { quote: null }) } : item));
    try {
      const result = await boundedDomainRead(async signal => {
        if (operation === "quote") return { check: row.check!, quote: await readDomainQuote(adapter, row.check!, Date.now, signal), priceError: null };
        const check = await readDomainCheck(adapter, row.domain, signal);
        if (!adapter.quotesWithCheck || !adapter.quote || availabilityAt(check, Date.now()) !== "available") return { check, quote: null, priceError: null };
        try { return { check, quote: await readDomainQuote(adapter, check, Date.now, signal), priceError: null }; }
        catch (error) {
          if (signal.aborted) throw error;
          return { check, quote: null, priceError: "Availability was checked, but no current matching price was supplied. Try a fresh check." };
        }
      }, controller);
      if (controller.signal.aborted || version !== generation.current) return "cancelled";
      setNow(Date.now());
      setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: "idle", check: result.check, quote: result.quote, error: result.priceError } : item));
      return "completed";
    } catch (error) {
      const outcome = error instanceof DomainReadTimeout ? "timeout" : error instanceof DomainReadCancelled ? "cancelled" : "failed";
      if (version === generation.current) setRows(current => current.map(item => item.domain === row.domain ? { ...item, status: "idle", error: outcome === "timeout" ? "Request timed out. Try again." : outcome === "cancelled" ? "Request cancelled." : error instanceof DomainLookupError ? error.message : operation === "check" ? "The check could not be verified. Availability remains unknown. Try again." : "The quote could not be verified. Try a fresh check and quote." } : item));
      return error instanceof DomainLookupError && error.retryAfterSeconds !== null ? { status: "rate_limited", retryAfterSeconds: error.retryAfterSeconds } : outcome;
    } finally {
      batchSignal?.removeEventListener("abort", cancel);
      if (pending.current.get(row.domain) === controller) pending.current.delete(row.domain);
    }
  }, [adapter, setRows]);
  const parsedItems = library.status === "ready" ? library.items.slice(0, 1000).map(item => purchasedDomainSchema.safeParse(item)) : [];
  const items = parsedItems.flatMap(parsed => parsed.success && Date.parse(parsed.data.order.confirmation!.confirmedAt) <= now ? [parsed.data] : []);
  const uniqueItems = items.filter((item, index) => items.findIndex(other => other.order.id === item.order.id) === index);
  const validOrders: DomainOrder[] = orders.slice(0, 1000).flatMap(value => { const parsed = domainOrderSchema.safeParse(value); return parsed.success && (!parsed.data.confirmation || Date.parse(parsed.data.confirmation.confirmedAt) <= now) ? [parsed.data] : []; });
  const matches = uniqueItems.filter(item => `${item.order.domain} ${item.project?.title ?? ""}`.toLowerCase().includes(filter.toLowerCase().trim()));
  const minimum = Number(viewFilters.minimum || 0), maximum = Number(viewFilters.maximum || Infinity);
  const validRange = Number.isFinite(minimum) && minimum >= 0 && maximum >= minimum;
  function verifiedQuote(row: Row) { return row.quote && quoteBlockReason(row.quote, row.check, now) === null ? row.quote : null; }
  function annualPrice(row: Row) {
    const quote = verifiedQuote(row);
    return quote?.periodYears === 1 && quote.total.currency === "USD" ? quote.total.amountMinor / 100 : null;
  }
  const visibleRows = rows.filter(row => {
    if (tab === "shortlist") return true;
    if (viewFilters.hideUnavailable && availabilityAt(row.check, now) === "taken") return false;
    const price = annualPrice(row);
    return !validRange || price === null || (price >= minimum && price <= maximum);
  }).sort((a, b) => {
    const first = sort.key === "price" ? annualPrice(a) : sort.key === "registrar" ? a.check?.provider ?? null : a.domain;
    const second = sort.key === "price" ? annualPrice(b) : sort.key === "registrar" ? b.check?.provider ?? null : b.domain;
    if (first === null) return second === null ? 0 : 1;
    if (second === null) return -1;
    const comparison = typeof first === "number" && typeof second === "number" ? first - second : String(first).localeCompare(String(second), "en");
    return sort.descending ? -comparison : comparison;
  });
  function selectSort(key: typeof sort.key) { setSort(current => ({ key, descending: key === current.key ? !current.descending : false })); }
  return <div className={styles.workspace}>
    <header className={styles.heading}><h1>A home for your brand<span>.</span></h1><p>Find the right domain for your next brand.</p></header>
    {tab === "library" ? <section aria-label="Purchased domains" className={styles.panel}>
      <div className={styles.sectionHeading}><h2>Purchased in Embel</h2><label className={styles.librarySearch}><span className="sr-only">Search purchased domains</span><input type="search" placeholder="Search domain or brand" value={filter} onChange={event => setFilter(event.target.value)} /></label></div>
      <p className={styles.muted}>Only registrar-confirmed Embel purchases appear here. Search candidates and pending orders stay separate.</p>
      {library.status === "loading" ? <p role="status">Loading purchased domains…</p> : library.status === "error" ? <p role="alert">{library.message ?? "Purchased domains could not be loaded."}</p> : library.status === "unavailable" ? <div className={styles.empty}><Icon name="domains" size={28} /><h3>Domain library unavailable</h3><p>{library.message ?? defaultLibrary.message}</p><button type="button" className="button secondary small" onClick={() => setTab("search")}>Prepare a domain search</button></div> : <>
        {(items.length !== parsedItems.length || (library.status === "ready" && library.items.length > 1000)) && <p role="alert">Some records are unverified or beyond this view’s limit and are not shown. Refresh through the account integration.</p>}
        {matches.length ? <ul className={styles.library}>{matches.map(item => <li key={item.order.id}><div><h3>{item.order.domain}</h3><p>{item.project?.title ?? "No linked brand"}</p><p className={styles.muted}>{item.order.provider} · confirmed {date(item.order.confirmation!.confirmedAt)}</p><p className={styles.muted}>{item.order.confirmation!.expiresAt ? `Recorded expiry: ${date(item.order.confirmation!.expiresAt)}` : "Expiry not supplied"}</p><span className={styles.badge}>Registration confirmed at purchase</span></div><button type="button" className="button secondary small" disabled={!onCreateBrand} onClick={() => onCreateBrand?.({ type: "domain", domain: item.order.domain, check: null, order: item.order })}>Create brand from domain</button></li>)}</ul> : <div className={styles.empty}><Icon name="domains" size={28} /><h3>{filter ? "No matching purchased domains" : "No confirmed purchases yet"}</h3><p>{filter ? "Try another domain or brand name." : "Prepare names to check in Search. Registration appears here after the registrar confirms it."}</p><button type="button" className="button secondary small" onClick={() => setTab("search")}>Prepare a domain search</button></div>}
      </>}
      {!onCreateBrand && <p className={styles.muted}>Brand creation from a domain is not connected.</p>}
    </section> : <section aria-label={tab === "shortlist" ? "Domain shortlist" : "Domain search workspace"} className={styles.searchWorkspace}>
      {tab === "shortlist" ? <div className={styles.shortlistIntro}>
        <h2>Your shortlist</h2><p>{draft ? "Your shortlist saves automatically to your account." : "Shortlisted domains stay in this tab."} Availability and prices need fresh checks when reopened.</p>
        {errors.length > 0 && <div role="alert" className={styles.filterError}>{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
        {!rows.length && <div className={styles.empty}><Icon name="domains" size={28} /><h3>No shortlisted domains yet</h3><p>Add domains from your search results to compare them here.</p><button type="button" className="button secondary small" onClick={() => setTab("search")}>Find domains</button></div>}
      </div> : <><form className={styles.searchCard} onSubmit={event => { event.preventDefault(); prepare(); }}>
        <div className={styles.searchLabelRow}><label htmlFor={`${uid}-names`}>Names or full domains</label>{onOpenNameLibrary ? <button type="button" className={styles.nameLibraryButton} disabled={editingDisabled} onClick={onOpenNameLibrary}><Icon name="names" size={15} />From name library<Icon name="plus" size={14} /></button> : <BrowserNameDialog disabled={editingDisabled} replacing={Boolean(input.trim())} onUse={name => { changeDraft({ ...currentDraft, input: name, candidates: [] }); setNameInputVersion(value => value + 1); }} />}</div>
        <div className={styles.searchEntryRow}><DomainNameInput key={nameInputVersion} id={`${uid}-names`} describedBy={`${uid}-help`} value={input} disabled={editingDisabled} onChange={next => changeDraft({ ...currentDraft, input: next, candidates: [] })} /><button type="submit" aria-label="Search domains" className={styles.searchButton} disabled={editingDisabled}>Search<Icon name="arrow" size={16} /></button></div>
        <p id={`${uid}-help`} className={styles.searchHint}>Separate multiple names with commas or new lines.</p>
        {errors.length > 0 && <div role="alert" className={styles.filterError}>{errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      </form>
      <DomainFilters extensions={extensions} onExtensionsChange={next => {
        if (next.length === extensions.length && next.every((value, index) => value === extensions[index])) return;
        changeDraft({ ...currentDraft, extensions: next, candidates: [] });
      }} disabled={editingDisabled} expanded={filtersExpanded} onExpandedChange={setFiltersExpanded} filters={viewFilters} onFiltersChange={setViewFilters} /></>}
      {rows.length > 0 && <section className={styles.domainResults} aria-label="Domain results">
        <DomainResultTools key={`${tab}:${searchKey}:${nameInputVersion}`} rows={rows} visibleRows={visibleRows} adapter={adapter} check={(row, signal) => handleRead(row, "check", signal)}>{(selected, select) => <>
        <header className={styles.resultsToolbar}><div><h2>Domain results</h2><span>{visibleRows.length} {visibleRows.length === 1 ? "result" : "results"}</span></div><div className={styles.sortChoices} aria-label="Sort domain results"><span>Sort by</span>{(["price", "domain", "registrar"] as const).map(key => <button key={key} type="button" aria-pressed={sort.key === key} aria-label={`Sort by ${key}${sort.key === key ? `, ${sort.descending ? "descending" : "ascending"}` : ""}`} onClick={() => selectSort(key)}>{key === "price" ? "Price" : key === "domain" ? "Domain" : "Registrar"}{sort.key === key && <Icon name="arrow-up" size={12} className={sort.descending ? styles.sortDescending : undefined} />}</button>)}</div></header>
        {visibleRows.length ? <ul className={styles.results}>{visibleRows.map(row => {
          const availability = availabilityAt(row.check, now), busy = row.status !== "idle" && row.requestAdapter === adapter;
          const block = row.quote ? quoteBlockReason(row.quote, row.check, now) : null;
          const quote = verifiedQuote(row), expanded = expandedRows.includes(row.domain);
          return <li key={row.domain} className={styles.resultRow}>
            <div className={styles.resultSummary}><div className={styles.resultIdentity}><h3>{row.domain}</h3><p>Registrar: {row.check?.provider ?? (adapter.status === "ready" ? adapter.provider : "Not connected")}<span aria-hidden="true"> · </span><span role="status" aria-label={`${row.domain} availability`}>{busy && row.status === "checking" ? "Checking…" : availability === "available" ? "Confirmed available" : availability === "taken" ? "Taken" : "Unknown"}</span></p></div>
              <div className={styles.resultPrice}><strong>{quote ? money(quote.total) : "—"}</strong><span>{quote ? `${quote.total.currency} / ${quote.periodYears === 1 ? "year" : `${quote.periodYears} years`}` : "Not quoted"}</span>{quote?.renewal && <span className={styles.renewalPrice}>Renewal {money(quote.renewal)} / {quote.periodYears === 1 ? "year" : `${quote.periodYears} years`}</span>}</div>
              <button type="button" className={styles.shortlistButton} disabled={editingDisabled} aria-pressed={shortlisted.includes(row.domain)} aria-label={`${shortlisted.includes(row.domain) ? "Remove" : "Add"} ${row.domain} ${shortlisted.includes(row.domain) ? "from" : "to"} shortlist`} title={shortlisted.includes(row.domain) ? "Remove from shortlist" : "Add to shortlist"} onClick={() => toggleShortlist(row.domain)}><Icon name={shortlisted.includes(row.domain) ? "check" : "plus"} size={16} /><span className={styles.shortlistButtonLabel}>{shortlisted.includes(row.domain) ? "Shortlisted" : "Shortlist"}</span></button>
              <button type="button" className={styles.resultArrow} aria-label={`View ${row.domain} details`} aria-expanded={expanded} aria-controls={`${uid}-details-${row.domain}`} onClick={() => setExpandedRows(current => expanded ? current.filter(domain => domain !== row.domain) : [...current, row.domain])}><Icon name="arrow" size={15} /></button>
            </div>
            <div className={styles.rowDetails} id={`${uid}-details-${row.domain}`} hidden={!expanded}>
              <label className={styles.selectDomain}><input type="checkbox" aria-label={`Select ${row.domain}`} checked={selected.includes(row.domain)} onChange={event => select(row.domain, event.target.checked)} />Select domain</label>
              <p className={styles.muted}>{row.check ? `${row.check.provider} · checked ${date(row.check.checkedAt)} · recheck after ${date(row.check.validUntil)} · evidence ${row.check.evidenceReference}${availability === "unknown" && row.check.availability !== "unknown" ? " · evidence expired or not current" : ""}` : "No availability evidence."}</p>
              {row.check?.detail && <p className={styles.muted}>{row.check.detail}{row.check.sourceUrl && <> <a href={row.check.sourceUrl} target="_blank" rel="noopener noreferrer">Open source</a></>}</p>}
              {row.status !== "idle" && !busy && <p role="status">Previous request cancelled after a connection change.</p>}
              {row.error && <p role="alert">{row.error}</p>}
              <div className={styles.actions}><button type="button" className="button secondary small" disabled={busy || adapter.status !== "ready"} onClick={() => void handleRead(row, "check")}>{row.check || row.error ? "Check again" : "Check availability"}<span className="sr-only"> for {row.domain}</span></button><button type="button" className="button secondary small" disabled={busy || availability !== "available" || adapter.status !== "ready" || !adapter.quote || adapter.provider !== row.check?.provider} onClick={() => void handleRead(row, "quote")}>{busy && row.status === "quoting" ? "Requesting quote…" : "Request quote"}<span className="sr-only"> for {row.domain}</span></button><button type="button" className={styles.textButton} disabled={!onCreateBrand || busy || !candidates.includes(row.domain)} title={!candidates.includes(row.domain) ? "Use this domain in the current search and wait for it to save before creating a brand." : undefined} onClick={() => onCreateBrand?.({ type: "domain", domain: row.domain, check: row.check, order: null })}>Create brand<span className="sr-only"> from {row.domain}</span></button></div>
              {tab === "shortlist" && !candidates.includes(row.domain) && <p className={styles.muted}>To create a brand from this domain, <button type="button" className={styles.textButton} disabled={editingDisabled} onClick={() => { changeDraft({ ...currentDraft, input: row.domain, candidates: [row.domain] }); setFiltersExpanded(false); setTab("search"); }}>use it in the current search</button> and wait for it to save.</p>}
              {row.quote && <div className={styles.quote} aria-label={`Quote for ${row.domain}`}><h4>Quote review</h4><dl><div><dt>Registration period</dt><dd>{row.quote.periodYears} {row.quote.periodYears === 1 ? "year" : "years"}</dd></div><div><dt>Total quoted</dt><dd>{money(row.quote.total)}</dd></div><div><dt>Renewal price</dt><dd>{row.quote.renewal ? `${money(row.quote.renewal)} / ${row.quote.periodYears === 1 ? "year" : `${row.quote.periodYears} years`}` : "Not supplied"}</dd></div><div><dt>Renewal terms</dt><dd>{row.quote.renewalTerms}</dd></div><div><dt>Recheck after</dt><dd>{date(row.quote.expiresAt)}</dd></div><div><dt>Provider / quote</dt><dd>{row.quote.provider} / {row.quote.id}</dd></div></dl>{block && <p role="status">{block}</p>}<button type="button" className="button secondary small" disabled>Purchase unavailable</button><p className={styles.muted}>Prices and availability may change; renewal is today’s quoted price for the displayed term. Taxes and final checkout totals are not established here. Checkout is not connected.</p></div>}
            </div>
          </li>;
        })}</ul> : <div className={styles.empty}><h3>No domains match these filters</h3><p>Try a wider price range or include unavailable domains.</p><button type="button" className="button secondary small" onClick={() => setViewFilters({ ...defaultViewFilters, hideUnavailable: false })}>Clear result filters</button></div>}
        </>}</DomainResultTools>
      </section>}
      <p className={styles.evidenceNote} data-results={rows.length > 0}>{adapter.status === "unavailable" ? adapter.reason : adapter.description ?? `Checks supplied by ${adapter.provider}.`}{rows.length > 0 && (tab === "shortlist" ? " All shortlisted domains remain visible." : " Unpriced results stay visible. Price filters use current one-year USD quotes.")}</p>
    </section>}
    <nav className={styles.tabs} aria-label="Domain views">{(["search", "shortlist", "library"] as const).map(value => <button type="button" key={value} aria-current={tab === value ? "page" : undefined} onClick={() => setTab(value)}>{value === "library" ? "Library" : value === "shortlist" ? `Shortlist${shortlisted.length ? ` (${shortlisted.length})` : ""}` : "Search"}</button>)}</nav>
    {draftControls && <div className={styles.draftControls}>{draftControls}</div>}
    {validOrders.length > 0 && <section className={styles.panel} aria-label="Domain orders"><h2>Orders</h2><p className={styles.muted}>Payment confirmation alone does not confirm domain registration.</p><ul className={styles.results}>{validOrders.map(order => <li key={order.id}><h3>{order.domain}</h3><p>{orderLabel(order)}</p><p className={styles.muted}>Payment: {order.payment}{order.paymentReference ? ` · payment reference ${order.paymentReference}` : ""}</p><p className={styles.muted}>{order.provider} · order {order.id}{order.confirmation ? ` · registrar reference ${order.confirmation.registrationReference}` : " · no registration confirmation"}</p></li>)}</ul></section>}
    {validOrders.length !== orders.length && <p role="alert">Some order records could not be verified and are not shown.</p>}
    <p className={styles.footer}>{draftNotice} Preparing a search or creating a brand does not reserve or register a domain.</p>
  </div>;
}
