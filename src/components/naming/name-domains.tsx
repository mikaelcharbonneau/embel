"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import {
  DomainLookupError,
  availabilityAt,
  readDomainCheck,
  readDomainQuote,
  type DomainSearchAdapter,
} from "@/features/domain-workspace/model";
import {
  MAX_EXTENSIONS,
  currentQuote,
  defaultFilters,
  defaultTweaks,
  domainRows,
  domainStatus,
  extensionGroups,
  filterDomainRows,
  formatUsd,
  noTweaks,
  popularExtensions,
  prefixOptions,
  searchWords,
  sortDomainRows,
  sortLabels,
  suffixOptions,
  tweakCount,
  tweakPreview,
  tweakSwitches,
  tweakWordError,
  type DomainFilters,
  type DomainResult,
  type DomainRow,
  type DomainSort,
  type DomainStatus,
  type DomainTweaks,
} from "@/features/domain-workspace/name-search";
import { checkedTime, providerLabels, rememberedDomainChecks } from "./use-live-checks";
import { WorkAreaLayer } from "./work-area-layer";
import styles from "./name-details.module.css";

const PAGE = 12;
type Panel = "extensions" | "tweaks" | "filters" | null;

/** The Domains tab's state. It lives with the name details so its second dialogs can open beside the first. */
export function useDomainSearch(name: string, account: VerifiedAccount, adapter: DomainSearchAdapter | null) {
  const { isCurrent } = useAccountSession();
  const initial = searchWords(name, name).join("");
  const [field, setField] = useState(initial);
  const [query, setQuery] = useState(initial);
  const [extensions, setExtensions] = useState<string[]>([...popularExtensions]);
  const [tweaks, setTweaks] = useState<DomainTweaks>(defaultTweaks);
  const [filters, setFilters] = useState<DomainFilters>(defaultFilters);
  const [sort, setSort] = useState<DomainSort>("best");
  const [limit, setLimit] = useState(PAGE);
  const [panel, setPanel] = useState<Panel>(null);
  const [results, setResults] = useState<Map<string, DomainResult>>(() => new Map(rememberedDomainChecks(account)));
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [checking, setChecking] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  // A check is current for a minute (Embel's recheck policy). Repaint when the next one expires.
  useEffect(() => {
    const next = Math.min(
      ...[...results.values()].map((result) => Date.parse(result.check.validUntil)).filter((at) => at > now),
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(2_147_483_647, next - Date.now() + 1));
    return () => clearTimeout(timer);
  }, [results, now]);

  const words = useMemo(() => searchWords(query, name), [query, name]);
  const rows = useMemo(() => domainRows(words, extensions, tweaks), [words, extensions, tweaks]);
  const result = (domain: string) => results.get(domain);
  const visible = (active: DomainFilters) => filterDomainRows(rows, result, active, now);
  const filtered = sortDomainRows(visible(filters), sort, result, now);
  const shown = filtered.slice(0, limit);

  function stop() {
    run.current?.abort();
    run.current = null;
    setChecking(null);
  }
  /** One deliberate press checks these domains, one after another, through the connected provider. */
  async function check(domains: readonly string[]) {
    if (!adapter || adapter.status !== "ready" || run.current || !domains.length || !isCurrent(account)) return;
    const controller = new AbortController();
    run.current = controller;
    setNotice(null);
    const live = () => !controller.signal.aborted && run.current === controller && isCurrent(account);
    try {
      for (const domain of domains) {
        if (!live()) return;
        setChecking(domain);
        setErrors((old) => {
          const next = new Map(old);
          next.delete(domain);
          return next;
        });
        try {
          const found = await readDomainCheck(adapter, domain, controller.signal);
          let quote = null;
          if (adapter.quote && availabilityAt(found, Date.now()) === "available")
            quote = await readDomainQuote(adapter, found, Date.now, controller.signal).catch(() => null);
          if (!live()) return;
          rememberedDomainChecks(account).set(domain, { check: found, quote });
          setNow(Date.now());
          setResults((old) => new Map(old).set(domain, { check: found, quote }));
        } catch (cause) {
          if (!live()) return;
          const message = cause instanceof Error ? cause.message : "This domain could not be checked.";
          setErrors((old) => new Map(old).set(domain, message));
          // The provider asked Embel to wait: the rest stay unchecked rather than failing one by one.
          if (cause instanceof DomainLookupError && cause.retryAfterSeconds !== null) {
            setNotice(message);
            return;
          }
        }
      }
    } finally {
      if (run.current === controller) {
        run.current = null;
        setChecking(null);
      }
    }
  }
  return {
    name,
    pricesAvailable: adapter?.status === "ready" && Boolean(adapter.quotesWithCheck),
    words,
    field,
    setField,
    search: () => {
      stop();
      setQuery(field);
      setLimit(PAGE);
    },
    extensions,
    setExtensions: (next: string[]) => {
      setExtensions(next);
      setLimit(PAGE);
    },
    tweaks,
    setTweaks: (next: DomainTweaks) => {
      setTweaks(next);
      setLimit(PAGE);
    },
    filters,
    setFilters: (next: DomainFilters) => {
      setFilters(next);
      setLimit(PAGE);
    },
    countFor: (draft: DomainFilters) => visible(draft).length,
    sort,
    setSort,
    total: rows.length,
    filtered,
    shown,
    more: () => setLimit((value) => value + PAGE),
    panel,
    setPanel,
    result,
    errors,
    checking,
    notice,
    now,
    check,
    stop,
  };
}
export type DomainSearch = ReturnType<typeof useDomainSearch>;

const statusText: Record<DomainStatus, string> = {
  not_checked: "Not checked",
  available: "Available",
  premium: "Premium",
  taken: "Taken",
  not_confirmed: "Not confirmed",
  expired: "Check expired",
};
const statusTone: Partial<Record<DomainStatus, string>> = {
  available: "e-badge--positive",
  premium: "e-badge--warning",
  taken: "e-badge--danger",
};
function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" className="e-chip" aria-pressed={pressed} onClick={onClick}>
      <Icon name="check" size="sm" className="e-chip__check" />
      {children}
    </button>
  );
}
function price(amountMinor: number, years: number) {
  return years === 1 ? `${formatUsd(amountMinor)} / year` : `${formatUsd(amountMinor)} / ${years} years`;
}

export function DomainsPanel({ search, adapter }: { search: DomainSearch; adapter: DomainSearchAdapter | null }) {
  const { filters, setFilters, now } = search;
  const ready = adapter?.status === "ready";
  const prices = ready && Boolean(adapter.quotesWithCheck);
  const unchecked = search.shown
    .filter((row) => ["not_checked", "expired"].includes(domainStatus(search.result(row.domain), now)))
    .map((row) => row.domain);
  const toggle = (patch: Partial<DomainFilters>) => setFilters({ ...filters, ...patch });
  return (
    <div className="e-stack">
      <form
        className={styles.searchRow}
        role="search"
        aria-label="Domains"
        onSubmit={(event) => {
          event.preventDefault();
          search.search();
        }}
      >
        <TextField
          type="search"
          label="Domain name"
          hideLabel
          value={search.field}
          maxLength={63}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => search.setField(event.target.value)}
        />
        <Button variant="primary" type="submit">
          Search
        </Button>
      </form>
      <div className={styles.toolbar}>
        <div className="e-cluster">
          <Button onClick={() => search.setPanel("extensions")} aria-haspopup="dialog">
            Extensions · {search.extensions.length}
          </Button>
          <Button icon="zap" onClick={() => search.setPanel("tweaks")} aria-haspopup="dialog">
            Tweaks · {tweakCount(search.tweaks)}
          </Button>
          <Button icon="sliders-horizontal" onClick={() => search.setPanel("filters")} aria-haspopup="dialog">
            Filters
          </Button>
        </div>
        <div className="e-cluster">
          <span className="e-muted" role="status">
            {search.shown.length} of {search.filtered.length} results
          </span>
          <Menu
            trigger={(props) => (
              <button {...props} type="button" className="e-button e-button--secondary" aria-label="Sort domains">
                {sortLabels[search.sort]}
                <Icon name="chevron-down" size="sm" />
              </button>
            )}
            items={(Object.keys(sortLabels) as DomainSort[])
              .filter((sort) => sort !== "price" || prices)
              .map((sort) => ({
                kind: "choice" as const,
                label: sortLabels[sort],
                checked: search.sort === sort,
                onSelect: () => search.setSort(sort),
              }))}
          />
        </div>
      </div>
      <div className="e-cluster" role="group" aria-label="Quick filters">
        <Chip
          pressed={!filters.show.taken}
          onClick={() => toggle({ show: { ...filters.show, taken: !filters.show.taken } })}
        >
          Hide taken
        </Chip>
        <Chip
          pressed={!filters.show.premium}
          onClick={() => toggle({ show: { ...filters.show, premium: !filters.show.premium } })}
        >
          Hide premium
        </Chip>
        {prices && (
          <Chip
            pressed={filters.maxPrice === 20}
            onClick={() => toggle({ maxPrice: filters.maxPrice === 20 ? null : 20 })}
          >
            Under $20
          </Chip>
        )}
        <Chip pressed={filters.exactOnly} onClick={() => toggle({ exactOnly: !filters.exactOnly })}>
          Exact name only
        </Chip>
      </div>
      <DomainTable search={search} adapter={adapter} prices={prices} />
      {search.filtered.length > search.shown.length && (
        <div>
          <Button size="sm" icon="chevron-down" onClick={search.more}>
            Show {Math.min(PAGE, search.filtered.length - search.shown.length)} more
          </Button>
        </div>
      )}
      {search.notice && <InlineMessage tone="warning">{search.notice}</InlineMessage>}
      <div className={styles.note}>
        {ready ? (
          <>
            <p className="e-muted">
              {adapter.description ?? "Domains are checked with the connected provider."} Embel checks a domain only
              when you press Check, and a result is current for one minute. Checking doesn’t reserve a domain.
            </p>
            {search.checking ? (
              <Button size="sm" variant="quiet" onClick={search.stop}>
                Stop checking
              </Button>
            ) : (
              unchecked.length > 1 && (
                <Button size="sm" onClick={() => void search.check(unchecked)}>
                  Check the {unchecked.length} shown
                </Button>
              )
            )}
          </>
        ) : (
          <p className="e-muted">
            {adapter === null
              ? "Checking which lookups are connected…"
              : `${adapter.reason} Look up opens the public registration record.`}
          </p>
        )}
      </div>
    </div>
  );
}

function DomainTable({
  search,
  adapter,
  prices,
}: {
  search: DomainSearch;
  adapter: DomainSearchAdapter | null;
  prices: boolean;
}) {
  const ready = adapter?.status === "ready";
  return (
    <table className="e-table">
      <caption className="e-sr">Domains for {search.name}</caption>
      <thead>
        <tr>
          <th scope="col">Domain</th>
          <th scope="col">Status</th>
          {prices && (
            <>
              <th scope="col" className="is-num">
                First year
              </th>
              <th scope="col" className="is-num">
                Renews at
              </th>
            </>
          )}
          <th scope="col">
            <span className="e-sr">Check</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {search.shown.length ? (
          search.shown.map((row) => (
            <DomainRowView key={row.domain} row={row} search={search} ready={ready} prices={prices} />
          ))
        ) : (
          <tr>
            <td colSpan={prices ? 5 : 3}>
              {search.total
                ? "No domains match these filters."
                : "Enter a name with letters or numbers to see its domains."}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function DomainRowView({
  row,
  search,
  ready,
  prices,
}: {
  row: DomainRow;
  search: DomainSearch;
  ready: boolean;
  prices: boolean;
}) {
  const result = search.result(row.domain);
  const status = domainStatus(result, search.now);
  const quote = currentQuote(result, search.now);
  const error = search.errors.get(row.domain);
  const checking = search.checking === row.domain;
  const lookup = `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(row.domain)}`;
  return (
    <tr>
      <td>
        <span className={styles.domain}>{row.domain}</span>
        {row.variant.tweak && <span className="e-sr"> ({row.variant.tweak})</span>}
      </td>
      <td>
        <div className={styles.statusCell}>
          {checking ? (
            <span className="e-cluster">
              <Spinner />
              <span>Checking…</span>
            </span>
          ) : (
            <span className={["e-badge", statusTone[status]].filter(Boolean).join(" ")} data-status={status}>
              {statusText[status]}
            </span>
          )}
          {result && !checking && status !== "expired" && (
            <small className="e-muted">
              Checked with{" "}
              {result.check.sourceUrl ? (
                <a href={result.check.sourceUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
                  {providerLabels[result.check.provider] ?? result.check.provider}
                </a>
              ) : (
                (providerLabels[result.check.provider] ?? result.check.provider)
              )}{" "}
              at <time dateTime={result.check.checkedAt}>{checkedTime(result.check.checkedAt)}</time>
            </small>
          )}
          {error && !checking && <small className={styles.error}>{error}</small>}
        </div>
      </td>
      {prices && (
        <>
          <td className="is-num">{quote ? price(quote.total.amountMinor, quote.periodYears) : "—"}</td>
          <td className="is-num">{quote?.renewal ? formatUsd(quote.renewal.amountMinor) : "—"}</td>
        </>
      )}
      <td className={styles.rowAction}>
        {!ready ? (
          <a className="e-link" href={lookup} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
            Look up<span className="e-sr"> {row.domain}</span>
          </a>
        ) : (
          (status === "not_checked" || status === "expired" || error) &&
          !checking && (
            <Button
              size="sm"
              disabled={Boolean(search.checking)}
              aria-label={`Check ${row.domain}`}
              onClick={() => void search.check([row.domain])}
            >
              {status === "expired" ? "Check again" : "Check"}
            </Button>
          )
        )}
      </td>
    </tr>
  );
}

/** The second dialogs of the Domains tab. Rendered beside the name details, never inside it. */
export function DomainPanels({ search, host }: { search: DomainSearch; host: HTMLElement | null | undefined }) {
  const close = () => search.setPanel(null);
  if (search.panel === "extensions")
    return (
      <WorkAreaLayer host={host} onEscape={close}>
        <ExtensionsDialog
          modal={!host}
          selected={search.extensions}
          onClose={close}
          onApply={(next) => {
            search.setExtensions(next);
            close();
          }}
        />
      </WorkAreaLayer>
    );
  if (search.panel === "tweaks")
    return (
      <WorkAreaLayer host={host} onEscape={close}>
        <TweaksDialog
          modal={!host}
          words={search.words}
          tweaks={search.tweaks}
          onClose={close}
          onApply={(next) => {
            search.setTweaks(next);
            close();
          }}
        />
      </WorkAreaLayer>
    );
  if (search.panel === "filters")
    return (
      <WorkAreaLayer host={host} onEscape={close}>
        <FiltersDialog
          modal={!host}
          filters={search.filters}
          prices={search.pricesAvailable}
          countFor={search.countFor}
          onClose={close}
          onApply={(next) => {
            search.setFilters(next);
            close();
          }}
        />
      </WorkAreaLayer>
    );
  return null;
}
function ExtensionsDialog({
  modal,
  selected,
  onClose,
  onApply,
}: {
  modal: boolean;
  selected: string[];
  onClose: () => void;
  onApply: (extensions: string[]) => void;
}) {
  const [draft, setDraft] = useState(selected);
  const [find, setFind] = useState("");
  const term = find.trim().replace(/^\./, "").toLowerCase();
  const full = draft.length >= MAX_EXTENSIONS;
  const toggle = (extension: string) =>
    setDraft((old) => (old.includes(extension) ? old.filter((value) => value !== extension) : [...old, extension]));
  return (
    <Dialog
      title="Extensions"
      size="lg"
      modal={modal}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" className={styles.footerStart} onClick={() => setDraft([])}>
            Clear all
          </Button>
          <Button onClick={() => setDraft([...popularExtensions])}>Select popular</Button>
          <Button variant="primary" disabled={!draft.length} onClick={() => onApply(draft)}>
            Search {draft.length} {draft.length === 1 ? "extension" : "extensions"}
          </Button>
        </>
      }
    >
      <TextField
        type="search"
        label="Find an extension"
        hideLabel
        placeholder="Find an extension…"
        value={find}
        onChange={(event) => setFind(event.target.value)}
      />
      <p className="e-muted" role="status">
        {draft.length} selected{full ? ` · up to ${MAX_EXTENSIONS} at once` : ""}
      </p>
      {extensionGroups.map((group) => {
        const matches = group.extensions.filter((extension) => extension.includes(term));
        if (!matches.length) return null;
        return (
          <section key={group.label} className="e-stack e-stack--sm" aria-label={group.label}>
            <h3 className={styles.groupTitle}>{group.label}</h3>
            <div className="e-cluster">
              {matches.map((extension) => {
                const on = draft.includes(extension);
                return (
                  <button
                    key={extension}
                    type="button"
                    className="e-chip"
                    aria-pressed={on}
                    disabled={!on && full}
                    onClick={() => toggle(extension)}
                  >
                    <Icon name="check" size="sm" className="e-chip__check" />.{extension}
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </Dialog>
  );
}

function OwnWord({ onAdd, label }: { onAdd: (word: string) => void; label: string }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!open)
    return (
      <button type="button" className="e-chip" onClick={() => setOpen(true)}>
        <Icon name="plus" size="sm" />
        Your own
      </button>
    );
  return (
    <form
      className={styles.ownWord}
      onSubmit={(event) => {
        event.preventDefault();
        const problem = tweakWordError(value);
        if (problem) return setError(problem);
        onAdd(value.trim().toLowerCase());
        setValue("");
        setOpen(false);
      }}
    >
      <TextField
        label={label}
        value={value}
        maxLength={16}
        error={error}
        autoFocus
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
      />
      <Button size="sm" type="submit">
        Add
      </Button>
    </form>
  );
}

function TweaksDialog({
  modal,
  words,
  tweaks,
  onClose,
  onApply,
}: {
  modal: boolean;
  words: string[];
  tweaks: DomainTweaks;
  onClose: () => void;
  onApply: (tweaks: DomainTweaks) => void;
}) {
  const [draft, setDraft] = useState(tweaks);
  const count = tweakCount(draft);
  const words$ = (field: "prefixes" | "suffixes", options: readonly string[]) => [
    ...new Set([...options, ...draft[field]]),
  ];
  const flip = (field: "prefixes" | "suffixes", word: string) =>
    setDraft((old) => ({
      ...old,
      [field]: old[field].includes(word) ? old[field].filter((value) => value !== word) : [...old[field], word],
    }));
  return (
    <Dialog
      title="Tweaks"
      description="Tweaks try variations of your name, so you find a good domain when the exact one is taken."
      modal={modal}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" className={styles.footerStart} onClick={() => setDraft(noTweaks)}>
            Turn all off
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)}>
            {count ? `Apply ${count} ${count === 1 ? "tweak" : "tweaks"}` : "Search without tweaks"}
          </Button>
        </>
      }
    >
      {(
        [
          ["prefixes", "Add a word before", prefixOptions],
          ["suffixes", "Add a word after", suffixOptions],
        ] as const
      ).map(([field, title, options]) => (
        <section key={field} className="e-stack e-stack--sm" aria-label={title}>
          <h3 className={styles.groupTitle}>{title}</h3>
          <div className="e-cluster">
            {words$(field, options).map((word) => (
              <Chip key={word} pressed={draft[field].includes(word)} onClick={() => flip(field, word)}>
                {word}
              </Chip>
            ))}
            <OwnWord
              label={field === "prefixes" ? "Your word before" : "Your word after"}
              onAdd={(word) =>
                setDraft((old) => ({ ...old, [field]: old[field].includes(word) ? old[field] : [...old[field], word] }))
              }
            />
          </div>
        </section>
      ))}
      <div className="e-stack e-stack--sm">
        {tweakSwitches.map(({ id, label }) => {
          const preview = tweakPreview(words, id);
          return (
            <label key={id} className="e-check">
              <input
                type="checkbox"
                role="switch"
                className="e-switch"
                checked={draft[id]}
                onChange={(event) => setDraft((old) => ({ ...old, [id]: event.target.checked }))}
              />
              <span className="e-check__text">
                <span>{label}</span>
                <span className={`e-muted ${styles.small}`}>{preview ?? "Not used for this name"}</span>
              </span>
            </label>
          );
        })}
      </div>
    </Dialog>
  );
}

const numberOrNull = (value: string) => {
  const parsed = Number(value);
  return value.trim() === "" || !Number.isFinite(parsed) || parsed < 0 ? null : parsed;
};

function FiltersDialog({
  modal,
  filters,
  prices,
  countFor,
  onClose,
  onApply,
}: {
  modal: boolean;
  filters: DomainFilters;
  prices: boolean;
  countFor: (filters: DomainFilters) => number;
  onClose: () => void;
  onApply: (filters: DomainFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const count = countFor(draft);
  const show = (key: keyof DomainFilters["show"], label: string, hint: string) => (
    <label className="e-check">
      <input
        type="checkbox"
        role="switch"
        className="e-switch"
        checked={draft.show[key]}
        onChange={(event) => setDraft((old) => ({ ...old, show: { ...old.show, [key]: event.target.checked } }))}
      />
      <span className="e-check__text">
        <span>{label}</span>
        <span className={`e-muted ${styles.small}`}>{hint}</span>
      </span>
    </label>
  );
  const flag = (key: "exactOnly" | "noHyphens", label: string, hint: string) => (
    <label className="e-check">
      <input
        type="checkbox"
        role="switch"
        className="e-switch"
        checked={draft[key]}
        onChange={(event) => setDraft((old) => ({ ...old, [key]: event.target.checked }))}
      />
      <span className="e-check__text">
        <span>{label}</span>
        <span className={`e-muted ${styles.small}`}>{hint}</span>
      </span>
    </label>
  );
  const amount = (key: "minPrice" | "maxPrice" | "maxRenewal" | "maxLength") => ({
    value: draft[key] ?? "",
    inputMode: "decimal" as const,
    onChange: (event: { target: { value: string } }) =>
      setDraft((old) => ({ ...old, [key]: numberOrNull(event.target.value) })),
  });
  return (
    <Dialog
      title="Filters"
      modal={modal}
      onClose={onClose}
      footer={
        <>
          <Button variant="quiet" className={styles.footerStart} onClick={() => setDraft(defaultFilters)}>
            Reset filters
          </Button>
          <Button variant="primary" onClick={() => onApply(draft)}>
            Show {count} {count === 1 ? "result" : "results"}
          </Button>
        </>
      }
    >
      <fieldset className={styles.fieldset}>
        <legend className={styles.groupTitle}>Show</legend>
        {show("available", "Available", "Ready to register at the regular price")}
        {show("premium", "Premium", "Available, at a higher price set by the registry or owner")}
        {show("taken", "Taken", "Already registered by someone")}
        {show("unchecked", "Not checked yet", "Not checked, not confirmed or the check has expired")}
      </fieldset>
      {prices && (
        <>
          <div className="e-grid-fields">
            <TextField label="Lowest first-year price, USD" placeholder="0" {...amount("minPrice")} />
            <TextField label="Highest first-year price, USD" placeholder="No limit" {...amount("maxPrice")} />
          </div>
          <TextField label="Highest renewal price, USD" optional placeholder="No limit" {...amount("maxRenewal")} />
          <p className={`e-muted ${styles.small}`}>Price filters show only domains whose price has been checked.</p>
        </>
      )}
      <TextField label="Longest domain, in characters" optional placeholder="No limit" {...amount("maxLength")} />
      {flag("exactOnly", "Exact name only", "Hide results made by tweaks")}
      {flag("noHyphens", "No hyphens", "Hide domains with a hyphen")}
    </Dialog>
  );
}
