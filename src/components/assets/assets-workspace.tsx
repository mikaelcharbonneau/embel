"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { z } from "zod";
import { Button, ButtonLink } from "@/components/ui/button";
import { Badge, EmptyState, Skeleton } from "@/components/ui/feedback";
import { SelectField, TextField } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { InlineMessage } from "@/components/ui/message";
import { AccountStatus, useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { readViewFromAddress, writeViewToAddress } from "@/components/workspace/address-view";
import { SignedOutEmptyState } from "@/components/workspace/signed-out-empty-state";
import { assetFileTypeSchema, type AssetLibraryItem, type AssetLibraryQuery } from "@/domain/asset-library";
import { assetTitle, groupLibrary, type LibraryEntry } from "./asset-labels";
import { AssetDetailDialog } from "./asset-detail";
import { AssetPreview } from "./asset-preview";
import { useAssetLibrary } from "./use-asset-library";

type Tab = AssetLibraryQuery["tab"];
const tabs: { id: Tab; label: string }[] = [
  { id: "my_selection", label: "In your brands" },
  { id: "all_generations", label: "Everything made" },
];

/** The Library view kept in the address (D-097): tab, project, format and search.
 * Unknown values are ignored, so an old or edited link still opens the Library. */
function libraryViewFromAddress() {
  const params = readViewFromAddress();
  const tab = tabs.find((item) => item.id === params.get("tab"))?.id ?? "my_selection";
  const projectId = z.uuid().safeParse(params.get("project")).data;
  const format = assetFileTypeSchema.safeParse(params.get("format")).data;
  return {
    query: { tab, ...(projectId ? { projectId } : {}), ...(format ? { format } : {}) },
    search: (params.get("q") ?? "").slice(0, 120),
  };
}

/** "Nov 12", with the year when it is not this year. */
export function shortDate(iso: string, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** "Version 2 · PNG · Nov 12": the version only when there is more than one. */
function fileLine(item: AssetLibraryItem) {
  const version = item.displayedVersion;
  return [
    version && item.asset.versionCount > 1 ? `Version ${version.versionNumber}` : null,
    version ? version.format.toUpperCase() : "No file",
    shortDate(version?.createdAt ?? item.asset.createdAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function AssetsWorkspace() {
  const { session } = useAccountSession();
  return (
    <div className="e-container e-page assets-guided library-page">
      <header className="e-page-header library-heading">
        <div className="e-stack e-stack--xs">
          <h1 className="text-title-lg" tabIndex={-1} id="assets-heading">
            Library
          </h1>
          <p className="e-muted">Everything Embel has made for you, by brand.</p>
        </div>
      </header>
      {session.status === "ready" ? (
        <OwnedAssetLibrary key={`${session.userId}:${session.generation}`} account={session} />
      ) : session.status === "checking" ? (
        <div className="library-checking" aria-busy="true">
          <span className="e-sr" role="status">
            Loading your library…
          </span>
          <LibrarySkeleton slots={3} />
        </div>
      ) : (
        <SignedOutEmptyState
          title="Sign in to see your library"
          text="Your logos, direction boards and brand images are kept in your account."
          fallback={<AccountStatus signedOut="Sign in to see your library." />}
        />
      )}
    </div>
  );
}

/** Cards in the final shape while the Library loads; holds no names, pictures or controls. */
function LibrarySkeleton({ slots }: { slots: number }) {
  return (
    <div className="assets-query-placeholders" aria-hidden="true" inert>
      <Skeleton shape="title" width={25} />
      <div className="assets-grid">
        {Array.from({ length: slots }, (_, index) => (
          <div className="e-card assets-query-placeholder" key={index}>
            <span className="e-skeleton e-skeleton--block assets-query-placeholder__media" />
            <div className="e-card__body">
              <Skeleton shape="title" width={60} />
              <Skeleton shape="line" width={25} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OwnedAssetLibrary({ account }: { account: VerifiedAccount }) {
  const [initialView] = useState(libraryViewFromAddress);
  const library = useAssetLibrary(account, initialView.query);
  const [search, setSearch] = useState(initialView.search);
  const [opened, setOpened] = useState<{ item: AssetLibraryItem; name: string } | null>(null);
  const resultsBody = useRef<HTMLDivElement | null>(null);
  const [geometry, setGeometry] = useState<{ client: typeof library.client; slots: number; height: number } | null>(
    null,
  );
  const tab = library.query.tab;
  const filtered = Boolean(library.query.projectId || library.query.format);
  useEffect(() => {
    writeViewToAddress({
      tab: tab === "my_selection" ? null : tab,
      project: library.query.projectId ?? null,
      format: library.query.format ?? null,
      q: search.trim() || null,
    });
  }, [tab, library.query.projectId, library.query.format, search]);
  const needle = search.trim().toLocaleLowerCase();
  const items = library.page?.items ?? [];
  // Numbers ("Logo concept 3") are only given when every file of each brand is loaded and none is filtered out.
  const brands = groupLibrary(items, tab === "all_generations" && !filtered && !library.page?.nextCursor);
  const visibleBrands = brands
    .map((brand) => {
      const entries = brand.entries.filter(
        (entry) =>
          !needle ||
          `${entry.name} ${assetTitle(entry.item.asset.kind)} ${brand.project.title} ${entry.item.displayedVersion?.format ?? ""}`
            .toLocaleLowerCase()
            .includes(needle),
      );
      return {
        ...brand,
        entries,
        sections: brand.sections
          .map((section) => ({ ...section, entries: section.entries.filter((entry) => entries.includes(entry)) }))
          .filter((section) => section.entries.length > 0),
      };
    })
    .filter((brand) => brand.entries.length > 0);
  const visibleCount = visibleBrands.reduce((count, brand) => count + brand.entries.length, 0);
  const libraryEmpty = Boolean(library.page) && !items.length && !filtered && !library.page?.nextCursor;

  function captureGeometry() {
    if (!library.page || !library.client.current()) return;
    const height = resultsBody.current?.getBoundingClientRect().height;
    if (height === undefined || !Number.isFinite(height) || height < 0) return;
    // Presentation only: never retain old rows, private previews, or cursors
    // after the hook invalidates the actual query window.
    setGeometry({ client: library.client, slots: visibleCount, height });
  }
  function changeQuery(next: Omit<AssetLibraryQuery, "cursor" | "limit">) {
    captureGeometry();
    library.changeQuery(next);
  }
  function chooseTab(next: Tab) {
    changeQuery({ ...library.query, tab: next });
  }
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? "my_selection"
        : event.key === "End"
          ? "all_generations"
          : current === "my_selection"
            ? "all_generations"
            : "my_selection";
    chooseTab(next);
    document.getElementById(`assets-tab-${next}`)?.focus();
  }
  // Owner/generation changes unmount this component. A replaced or disposed
  // client cannot expose even the previous owner's numeric display metadata.
  const reservation = geometry && geometry.client === library.client && library.client.current() ? geometry : null;
  // The open detail follows the list, so a like or save made in it shows at once. "In your brands" drops a file
  // only after an acknowledged change left nothing keeping it there: then it is neither liked nor saved.
  const listed = opened ? items.find((row) => row.asset.id === opened.item.asset.id) : undefined;
  const live = opened
    ? (listed ??
      (library.page?.query.tab === "my_selection"
        ? { ...opened.item, asset: { ...opened.item.asset, liked: false, saved: false } }
        : opened.item))
    : null;

  return (
    <section className="library" aria-label="Account asset library">
      <div className="assets-toolbar">
        <div className="e-tabs" role="tablist" aria-label="Library views">
          {tabs.map((option) => (
            <button
              id={`assets-tab-${option.id}`}
              key={option.id}
              type="button"
              role="tab"
              className="e-tab"
              aria-controls="assets-results"
              aria-selected={tab === option.id}
              tabIndex={tab === option.id ? 0 : -1}
              disabled={library.busy}
              onClick={() => chooseTab(option.id)}
              onKeyDown={(event) => onTabKey(event, option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {!libraryEmpty && (
        <div className="assets-filters">
          <TextField
            className="assets-search"
            label="Search your library"
            hideLabel
            type="search"
            name="search"
            autoComplete="off"
            placeholder="Search your library"
            maxLength={120}
            value={search}
            onChange={(event) => {
              captureGeometry();
              setSearch(event.target.value);
            }}
            onClear={() => setSearch("")}
            aria-describedby={needle && library.page?.nextCursor ? "assets-search-note" : undefined}
          />
          <SelectField
            className="assets-filter"
            label="Project"
            hideLabel
            value={library.query.projectId ?? ""}
            disabled={library.busy}
            onChange={(event) => changeQuery({ ...library.query, projectId: event.target.value || undefined })}
          >
            <option value="">All projects</option>
            {library.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </SelectField>
          <SelectField
            className="assets-filter"
            label="File type"
            hideLabel
            value={library.query.format ?? ""}
            disabled={library.busy}
            onChange={(event) =>
              changeQuery({
                ...library.query,
                format: event.target.value ? assetFileTypeSchema.parse(event.target.value) : undefined,
              })
            }
          >
            <option value="">All formats</option>
            {assetFileTypeSchema.options.map((format) => (
              <option key={format} value={format}>
                {format === "other" ? "Other files" : format.toUpperCase()}
              </option>
            ))}
          </SelectField>
        </div>
      )}
      <div
        role="tabpanel"
        id="assets-results"
        aria-labelledby={`assets-tab-${tab}`}
        aria-busy={library.status === "loading"}
      >
        <p className="e-sr assets-loading" role="status">
          {library.status === "loading" ? (library.page ? "Refreshing…" : "Loading your library…") : ""}
        </p>
        <div
          ref={resultsBody}
          className="assets-results-body"
          style={!library.page && reservation ? { minHeight: reservation.height } : undefined}
        >
          {needle && library.page?.nextCursor && (
            <p id="assets-search-note" className="e-muted">
              Search covers the files shown. Show more to search the rest.
            </p>
          )}
          {library.error &&
            (library.page ? (
              <InlineMessage
                tone="danger"
                actions={
                  <Button size="sm" disabled={library.busy} onClick={library.refresh}>
                    Try again
                  </Button>
                }
              >
                {library.error}
              </InlineMessage>
            ) : (
              <div role="alert">
                <EmptyState
                  danger
                  icon="circle-alert"
                  title="Your library couldn’t be loaded"
                  text="Your files are saved. Check your connection, then try again."
                  action={
                    <Button variant="primary" icon="rotate-ccw" disabled={library.busy} onClick={library.refresh}>
                      Try again
                    </Button>
                  }
                />
              </div>
            ))}
          {!library.page && !library.error && <LibrarySkeleton slots={reservation?.slots ?? 3} />}
          {library.page &&
            (visibleCount > 0 ? (
              visibleBrands.map((brand) => (
                <section
                  key={brand.project.id}
                  className="library-brand"
                  aria-labelledby={`library-brand-${brand.project.id}`}
                >
                  <div className="library-brand__head">
                    <h2 className="library-brand__title" id={`library-brand-${brand.project.id}`}>
                      {brand.project.title}
                      <Badge>{brand.entries.length}</Badge>
                    </h2>
                    <Link className="e-link e-link--standalone" href={`/brands/account/${brand.project.id}`}>
                      Open project
                      <Icon name="arrow-right" size="sm" />
                    </Link>
                  </div>
                  {tab === "all_generations" ? (
                    brand.sections.map((section) => (
                      <div key={section.id} className="library-section">
                        <h3 className="library-section__title">{section.title}</h3>
                        <div
                          className={
                            section.id === "logo-concepts" ? "assets-grid assets-grid--compact" : "assets-grid"
                          }
                        >
                          {section.entries.map((entry) => (
                            <LibraryCard
                              key={entry.item.asset.id}
                              entry={entry}
                              headingLevel={4}
                              client={library.client}
                              onOpen={() => setOpened({ item: entry.item, name: entry.name })}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="assets-grid">
                      {brand.entries.map((entry) => (
                        <LibraryCard
                          key={entry.item.asset.id}
                          entry={entry}
                          client={library.client}
                          onOpen={() => setOpened({ item: entry.item, name: entry.name })}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))
            ) : library.status === "loading" ? null : needle && items.length ? (
              <div role="status">
                <EmptyState
                  variant="results"
                  icon="search"
                  title={`No files match “${search.trim()}”`}
                  text="Check the spelling, or search for a brand or a kind of file."
                  action={<Button onClick={() => setSearch("")}>Clear search</Button>}
                />
              </div>
            ) : filtered ? (
              <EmptyState
                variant="results"
                icon="sliders-horizontal"
                title="No files match these filters"
                text="Choose another project or format to see more of your library."
                action={<Button onClick={() => changeQuery({ tab })}>Clear filters</Button>}
              />
            ) : tab === "my_selection" && library.projects.length > 0 ? (
              <EmptyState
                icon="images"
                title="Nothing in your brands yet"
                text="The logo and direction you choose, and files you like or save, appear here, grouped by brand."
                action={<Button onClick={() => chooseTab("all_generations")}>See everything made</Button>}
              />
            ) : (
              <EmptyState
                icon="images"
                title="Your library is empty"
                text="Logo concepts, direction boards and brand images are kept here as you make them, grouped by brand."
                action={
                  <ButtonLink variant="primary" href="/" icon="plus">
                    New project
                  </ButtonLink>
                }
              />
            ))}
          <div className="assets-pagination">
            <span className="e-sr">
              {library.page
                ? needle
                  ? `${visibleCount} matches in ${items.length} loaded assets`
                  : `${items.length} assets loaded`
                : library.status === "loading"
                  ? "Matching asset count pending."
                  : "Matching asset count unavailable."}
            </span>
            {library.page?.nextCursor && (
              <Button disabled={library.busy || library.status !== "ready"} onClick={() => void library.loadMore()}>
                Load more assets
              </Button>
            )}
          </div>
        </div>
      </div>
      {opened && live && (
        <AssetDetailDialog
          key={opened.item.asset.id}
          item={live}
          name={opened.name}
          client={library.client}
          onClose={() => setOpened(null)}
          onSelected={library.refresh}
          retention={{
            busy: library.busy || library.needsCheck,
            onToggle: (field) => void library.retain(live, field),
          }}
        />
      )}
    </section>
  );
}

/** One file: its picture whole in a square (IMG-012), "Chosen" when it is in the brand, its name and file line.
 * The whole card opens the detail view. */
function LibraryCard({
  entry,
  client,
  onOpen,
  headingLevel = 3,
}: {
  entry: LibraryEntry;
  /** 4 under a section title (Everything made), 3 directly under the brand. */
  headingLevel?: 3 | 4;
  client: ReturnType<typeof useAssetLibrary>["client"];
  onOpen: () => void;
}) {
  const { item, name, chosen } = entry;
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <article className="e-card e-card--interactive assets-card" aria-label={`${name} · ${item.project.title}`}>
      <div className="assets-card__media">
        <AssetPreview
          version={item.displayedVersion}
          client={client}
          retryable={false}
          label={`${name} for ${item.project.title}`}
        />
        {chosen && (
          <span className="assets-card__chosen">
            <Badge icon="check">Chosen</Badge>
          </span>
        )}
      </div>
      <div className="e-card__body">
        <Heading className="e-card__title e-card__title--two-line">
          <button type="button" className="e-card__link assets-open" onClick={onOpen}>
            {name}
          </button>
        </Heading>
        <p className="e-card__meta">{fileLine(item)}</p>
      </div>
    </article>
  );
}
