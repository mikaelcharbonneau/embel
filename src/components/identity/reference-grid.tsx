"use client";
import { ContextDetails } from "@/components/ui/context-details";
import { useEffect, useRef, useState } from "react";
import type { IdentityReferenceEntry } from "@/domain/identity-references";
import { Icon } from "@/components/ui/icon";
import { ReferenceControls, referenceElementLabels } from "./reference-controls";
import { ReferencePreview } from "./reference-preview";
import type { IdentityReferencesController } from "./use-identity-references";
function ReferenceCard({
  entry,
  reference,
}: {
  entry: IdentityReferenceEntry;
  reference: IdentityReferencesController;
}) {
  const [hovered, setHovered] = useState(false),
    { attribution } = entry.reference;
  return (
    <article
      className="identity-reference-card"
      aria-label={attribution.label}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse" && matchMedia("(hover: hover)").matches) setHovered(true);
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <ReferencePreview media={entry.reference.media} label={attribution.label} client={reference.client} />
      <ReferenceControls
        entry={entry}
        hovered={hovered}
        busy={reference.pending.has(entry.reference.id)}
        blocked={reference.intents.has(entry.reference.id)}
        onChange={(choices) => void reference.react(entry, choices)}
      />
      <div className="identity-reference-attribution">
        <h3>{attribution.label}</h3>
        {attribution.creator && <p>{attribution.creator}</p>}
        <ContextDetails title={<>Attribution</>}>
          <p>
            {entry.reference.source === "user_supplied" ? "User supplied reference" : "Attributed catalog reference"}
          </p>
          {attribution.sourceUrl && (
            <a
              className="text-link"
              href={attribution.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              View source
              <Icon name="arrow" size={12} />
            </a>
          )}
          {attribution.rightsNote ? <p>Rights note: {attribution.rightsNote}</p> : null}
          <p>Attribution does not verify usage rights.</p>
        </ContextDetails>
      </div>
    </article>
  );
}
export function ReferenceGrid({ reference }: { reference: IdentityReferencesController }) {
  const [tagSearch, setTagSearch] = useState("");
  const tagPicker = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      if (tagPicker.current?.open && !tagPicker.current.contains(event.target as Node)) tagPicker.current.open = false;
    }
    document.addEventListener("click", closeOutside);
    return () => document.removeEventListener("click", closeOutside);
  }, []);
  const { page, query } = reference,
    filters = page ?? reference.filterMetadata;
  const matchingTags = (filters?.availableTags ?? []).filter((tag) =>
    tag.toLocaleLowerCase().includes(tagSearch.toLocaleLowerCase()),
  );
  const recoveries = [...reference.intents.entries()].filter(([id]) => !reference.pending.has(id));
  return (
    <section className="identity-references" aria-label="Brand references">
      <div className="identity-reference-section-heading">
        <div>
          <h2>References</h2>
          <p>Choose the elements you want to explore.</p>
        </div>
        <button className="text-link" type="button" disabled={reference.loading} onClick={reference.refresh}>
          Check references
        </button>
      </div>
      {page?.feed.status === "unavailable" && (
        <p className="identity-reference-feed-note">
          Reference discovery is not connected.
          {page.references.items.length ? " Your saved references remain available." : ""}
        </p>
      )}
      {reference.error && (
        <div role="alert" className="identity-reference-notice">
          <p>{reference.error}</p>
          <button className="button secondary small" type="button" onClick={reference.refresh}>
            Check references again
          </button>
        </div>
      )}
      {recoveries.map(([id, intent]) => (
        <div key={id} className="identity-reference-recovery" role="alert">
          <h3>Pending choices · {intent.entry.reference.attribution.label}</h3>
          <p>{intent.error}</p>
          <p>
            Your choices:{" "}
            {[
              ...(intent.choices.ensemble ? ["Ensemble"] : []),
              ...intent.choices.elements.map((element) => referenceElementLabels[element]),
            ].join(", ") || "None"}
            .
          </p>
          <div>
            <button className="button secondary small" type="button" onClick={() => void reference.checkIntent(id)}>
              Check latest choices
            </button>
            {intent.phase === "conflict" && (
              <>
                <button
                  className="button primary small"
                  type="button"
                  onClick={() => void reference.react(intent.entry, intent.choices, true)}
                >
                  Save my choices
                </button>
                <button className="text-link" type="button" onClick={() => reference.keepSaved(id)}>
                  Keep saved choices
                </button>
              </>
            )}
            {intent.phase === "unconfirmed" && (
              <button className="text-link" type="button" onClick={() => reference.keepSaved(id)}>
                Discard pending choices
              </button>
            )}
          </div>
        </div>
      ))}
      {filters && (
        <>
          <div className="identity-reference-toolbar">
            <span>
              {filters.selectedReferenceCount} {filters.selectedReferenceCount === 1 ? "reference" : "references"}{" "}
              selected in this project
            </span>
            <details
              className="identity-reference-tags"
              ref={tagPicker}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.currentTarget.open = false;
                  event.currentTarget.querySelector("summary")?.focus();
                }
              }}
            >
              <summary>Exclude tags{query.excludedTags.length ? ` (${query.excludedTags.length})` : ""}</summary>
              <div>
                <label>
                  Find a tag
                  <input
                    type="search"
                    value={tagSearch}
                    maxLength={80}
                    onChange={(event) => setTagSearch(event.target.value)}
                    placeholder="Search returned tags"
                  />
                </label>
                {!filters.tagsComplete && (
                  <p>These suggestions are incomplete. More tags may appear as references load.</p>
                )}
                <div className="identity-reference-tag-options">
                  {matchingTags.slice(0, 50).map((tag) => (
                    <label key={tag}>
                      <input
                        type="checkbox"
                        checked={query.excludedTags.includes(tag)}
                        disabled={!query.excludedTags.includes(tag) && query.excludedTags.length >= 50}
                        onChange={(event) => {
                          setTagSearch("");
                          reference.changeExclusions(
                            event.target.checked
                              ? [...query.excludedTags, tag]
                              : query.excludedTags.filter((value) => value !== tag),
                          );
                        }}
                      />
                      <span>{tag}</span>
                    </label>
                  ))}
                </div>
                {!matchingTags.length && <p>No matching tags in this response.</p>}
                {matchingTags.length > 50 && (
                  <p>Showing 50 of {matchingTags.length} returned tags. Search to narrow the list.</p>
                )}
              </div>
            </details>
          </div>
        </>
      )}
      {query.excludedTags.length > 0 && (
        <div className="identity-reference-exclusions" aria-label="Excluded tags">
          {query.excludedTags.map((tag) => (
            <button
              type="button"
              key={tag}
              onClick={() => reference.changeExclusions(query.excludedTags.filter((value) => value !== tag))}
              aria-label={`Include ${tag} again`}
            >
              {tag}
              <Icon name="close" size={12} />
            </button>
          ))}
          <button className="text-link" type="button" onClick={() => reference.changeExclusions([])}>
            Clear exclusions
          </button>
        </div>
      )}
      {reference.loading && (
        <p role="status" className="identity-reference-muted identity-reference-loading">
          Loading saved references…
        </p>
      )}
      {page && (
        <>
          {page.references.items.length ? (
            <div className="identity-reference-grid">
              {page.references.items.map((entry) => (
                <ReferenceCard key={entry.reference.id} entry={entry} reference={reference} />
              ))}
            </div>
          ) : (
            !reference.loading && (
              <div className="identity-reference-empty">
                <Icon name="assets" size={31} />
                <h3>{query.excludedTags.length ? "No references match these filters" : "No saved references yet"}</h3>
                <p>
                  {query.excludedTags.length
                    ? "Remove an excluded tag to review more references."
                    : page.feed.status === "unavailable"
                      ? "Reference discovery is not connected. No sample references have been added to your project."
                      : "References added to your project will appear here."}
                </p>
              </div>
            )
          )}
          <div className="identity-reference-pagination">
            <span>{page.references.items.length} references loaded</span>
            {page.references.nextCursor && (
              <button
                className="button secondary small"
                type="button"
                disabled={reference.loading || reference.loadingMore || reference.pending.size > 0}
                onClick={() => void reference.loadMore()}
              >
                {reference.loadingMore ? "Loading more…" : "Load more references"}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
