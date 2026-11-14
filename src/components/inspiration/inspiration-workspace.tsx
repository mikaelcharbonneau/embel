"use client";

import { EmbelIdentity } from "@/components/workspace/embel-identity";
import { journeyPartLabel } from "@/domain/journey";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  filterInspirationBrands,
  filterInspirationParts,
  hasInspirationChoice,
  inspirationBrands,
  inspirationCategories,
  inspirationLikeCount,
  partLiked,
  type InspirationBrand,
  type InspirationCategory,
  type InspirationPart,
  type InspirationPreferences,
} from "@/domain/inspiration";
import { AccountStatus, useAccountSession } from "@/components/workspace/account-session";
import { publishInspirationLikes } from "@/components/workspace/inspiration-likes-signal";
import { Icon } from "@/components/ui/icon";
import { bentoLayout, brandRows, cardShape, type BentoBox } from "@/domain/inspiration-layout";
import { useInspiration, type InspirationController } from "./use-inspiration";
import { BrandCard, BrandOverlay, PartCard, type BrandLikes } from "./inspiration-brands";
import { useYourReferences, type YourReferences } from "./your-references";
import "./inspiration.css";

const noChoice: InspirationPreferences = { ensemble: false, elements: [] };
const catalogPendingNote = "You can browse this brand now. Liking it will be available soon.";
// Brands and part images shown at first, and added by each "Show more".
const PAGE = { brands: 8, parts: 18 } as const;
// Each brand's image rows and card shape depend only on its images.
const brandLayouts = new Map(
  inspirationBrands.map((brand) => {
    const rows = brandRows(brand.parts);
    return [brand.id, { rows, shape: cardShape(rows) }];
  }),
);
const brandIds = new Set(inspirationBrands.map((brand) => brand.id));
function Recovery({ id, controller }: { id: string; controller: InspirationController }) {
  const intent = controller.intents.get(id);
  if (!intent) return null;
  if (controller.busy.has(id))
    return (
      <p className="inspiration-saving" role="status">
        Saving choices…
      </p>
    );
  return (
    <div className="inspiration-recovery" role="status">
      <p>{intent.error}</p>
      <div>
        <button type="button" onClick={() => void controller.check(id)}>
          Check saved choices
        </button>
        <button
          type="button"
          disabled={
            !controller.canSave ||
            !intent.checked ||
            intent.expectedRevision !==
              (controller.overview?.choices.find((choice) => choice.referenceId === id)?.revision ?? 0) ||
            intent.expectedProjectRevision !== controller.overview?.projectRevision
          }
          onClick={() => void controller.save(id, intent.desired, true)}
        >
          Save my changes
        </button>
        <button type="button" onClick={() => controller.keepSaved(id)}>
          Keep saved choices
        </button>
      </div>
    </div>
  );
}
/** The brand bento: brands share rows of equal height, each as wide as its
 * content needs. Cards keep their DOM identity while the width changes; before
 * the first measurement they fall back to a plain two-column grid. */
function BrandBento({
  brands,
  children,
}: {
  brands: readonly InspirationBrand[];
  children: (brand: InspirationBrand, box: BentoBox | undefined) => ReactNode;
}) {
  const grid = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.floor(entries[0]?.contentRect.width ?? 0);
      setWidth((previous) => (previous === next ? previous : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(
    () =>
      width > 0
        ? bentoLayout(
            brands.map((brand) => brandLayouts.get(brand.id)!.shape),
            width,
          )
        : null,
    [brands, width],
  );
  return (
    <div
      ref={grid}
      className="inspiration-brands"
      data-positioned={layout ? "true" : undefined}
      style={layout ? { height: layout.height } : undefined}
    >
      {brands.map((brand, index) => children(brand, layout?.boxes[index]))}
    </div>
  );
}
/** Keep image/focus identity while preserving the approved round-robin masonry. */
function InspirationGrid({ children }: { children: ReactNode }) {
  const grid = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = grid.current;
    if (!node) return;
    const cards = Array.from(node.children) as HTMLElement[];
    const layout = () => {
      const width = node.getBoundingClientRect().width;
      if (!width) return;
      const columns = width >= 1200 ? 5 : width >= 900 ? 4 : width >= 620 ? 3 : width >= 350 ? 2 : 1;
      const cardWidth = (width - (columns - 1) * 16) / columns;
      node.style.setProperty("--inspiration-card-width", `${cardWidth}px`);
      node.dataset.positioned = "true";
      const heights = Array<number>(columns).fill(0);
      cards.forEach((card, index) => {
        const column = index % columns;
        card.style.left = `${column * (cardWidth + 16)}px`;
        card.style.top = `${heights[column]}px`;
        heights[column]! += card.getBoundingClientRect().height + 20;
      });
      node.style.height = `${Math.max(0, ...heights) - (cards.length ? 20 : 0)}px`;
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(node);
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className="inspiration-columns" ref={grid}>
      {children}
    </div>
  );
}
/** "page" is the standalone Inspiration page; "conversation" is the same step
 * shown as one Embel message inside the project conversation. */
/** "workspace" is the gallery alone in the Workspace's work area: Embel's message is in the chat and Send in the
 * reply box moves on, so it has neither. */
type InspirationVariant = "page" | "conversation" | "workspace";
/** In the conversation, Continue reveals the next message (onContinue) instead of
 * opening a page; once that message is on screen the row is no longer needed. */
type InspirationProps = {
  projectId: string;
  variant?: InspirationVariant;
  lead?: string;
  onContinue?: () => void;
  continueHidden?: boolean;
  /** The number of likes (brands, parts and your own images) once saved choices are read. */
  onLikes?: (count: number) => void;
  /** The brand's name as the conversation shows it (the chosen name), which the project's title may not be yet. */
  brandName?: string;
};
export function InspirationWorkspace({
  projectId,
  variant = "page",
  lead,
  onContinue,
  continueHidden,
  onLikes,
  brandName,
}: InspirationProps) {
  const { session } = useAccountSession();
  if (session.status !== "ready")
    return variant === "page" ? (
      <div className="page">
        <h1>Inspiration</h1>
        <AccountStatus />
      </div>
    ) : null;
  return (
    <OwnedInspiration
      key={`${session.userId}:${session.generation}:${projectId}`}
      account={session}
      projectId={projectId}
      variant={variant}
      lead={lead}
      onContinue={onContinue}
      continueHidden={continueHidden}
      onLikes={onLikes}
      brandName={brandName}
    />
  );
}
function OwnedInspiration({
  account,
  projectId,
  variant,
  lead,
  onContinue,
  continueHidden,
  onLikes,
  brandName,
}: InspirationProps & { account: Extract<ReturnType<typeof useAccountSession>["session"], { status: "ready" }> }) {
  const controller = useInspiration(account, projectId),
    references = useYourReferences(account, projectId);
  const router = useRouter();
  // Let the Logo step below refresh its brief when saved likes change.
  const selectionRevision = controller.overview?.selectionRevision,
    referenceRevision = references.revision;
  useEffect(() => {
    if (selectionRevision !== undefined)
      publishInspirationLikes(account.userId, projectId, `${selectionRevision}:${referenceRevision ?? 0}`);
  }, [account.userId, projectId, selectionRevision, referenceRevision]);
  // A complete brand shows Inspiration in its conversation, right after Voice;
  // the standalone page only remains for projects without that conversation.
  // The page variant sits in the project conversation once the project is read.
  const inConversation = variant === "page" && Boolean(controller.overview);
  useEffect(() => {
    if (inConversation) router.replace(`/brands/account/${projectId}?view=strategy#journey-identity`);
  }, [inConversation, router, projectId]);
  if (inConversation) return null;
  return (
    <InspirationView
      controller={controller}
      projectId={projectId}
      variant={variant}
      lead={lead}
      onContinue={onContinue}
      continueHidden={continueHidden}
      references={references}
      onLikes={onLikes}
      brandName={brandName}
    />
  );
}
const defaultLead =
  "Let’s shape how your brand looks. Like the brands you’re drawn to: a whole brand, or just its logo, colors, typefaces, socials or visuals. Your likes guide the logo concepts.";
/** The view accepts the real controller contract so isolated browser checks use the same UI. */
/** references adds the user's own uploaded images (button, status and their
 * container); without it (isolated checks) the button links to Identity. */
export function InspirationView({
  controller,
  projectId,
  variant = "page",
  lead = defaultLead,
  onContinue,
  continueHidden = false,
  references,
  onLikes,
  brandName,
}: {
  controller: InspirationController;
  projectId: string;
  variant?: InspirationVariant;
  lead?: string;
  onContinue?: () => void;
  continueHidden?: boolean;
  references?: YourReferences;
  onLikes?: (count: number) => void;
  brandName?: string;
}) {
  const conversation = variant === "conversation";
  const workspace = variant === "workspace";
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState<InspirationCategory>("brands"),
    [liked, setLiked] = useState(false);
  const [limit, setLimit] = useState<number>(PAGE.brands);
  const [open, setOpen] = useState<{ brand: InspirationBrand; part?: InspirationPart } | null>(null);
  const saved = useMemo(
    () => new Map(controller.overview?.choices.map((choice) => [choice.referenceId, choice]) ?? []),
    [controller.overview],
  );
  const displayed = useMemo(() => {
    const choices = new Map<string, InspirationPreferences>(saved);
    controller.intents.forEach((intent, id) => choices.set(id, intent.desired));
    return choices;
  }, [saved, controller.intents]);
  // The whole brand counts as one like, and so does each liked part.
  // Each liked image of your own counts once too.
  const count =
    [...saved.values()]
      .filter((choice) => brandIds.has(choice.referenceId))
      .reduce((total, choice) => total + inspirationLikeCount(choice), 0) + (references?.liked ?? 0);
  const counted = Boolean(controller.overview);
  useEffect(() => {
    if (counted) onLikes?.(count);
  }, [counted, count, onLikes]);
  const yours = references?.section(liked) ?? null;
  const page = category === "brands" ? PAGE.brands : PAGE.parts;
  const reset = (next: { category?: InspirationCategory; liked?: boolean; query?: string }) => {
    const nextCategory = next.category ?? category;
    if (next.category !== undefined) setCategory(next.category);
    if (next.liked !== undefined) setLiked(next.liked);
    if (next.query !== undefined) setQuery(next.query);
    setLimit(nextCategory === "brands" ? PAGE.brands : PAGE.parts);
  };
  const likesFor = (brand: InspirationBrand, inCard: boolean): BrandLikes => {
    const choice = displayed.get(brand.id) ?? noChoice,
      busy = controller.busy.has(brand.id),
      pending = controller.intents.has(brand.id);
    const available = controller.overview?.availableReferenceIds?.includes(brand.id) ?? !brand.availableSince;
    const catalogPending = Boolean(controller.overview && !available);
    const status = inCard ? (
      busy ? (
        <p className="inspiration-saving" role="status">
          Saving…
        </p>
      ) : pending ? (
        <button className="inspiration-pending" type="button" onClick={() => setOpen({ brand })}>
          Review unsaved choices
        </button>
      ) : catalogPending ? (
        <p className="inspiration-element-label inspiration-availability" title={catalogPendingNote}>
          Browse only for now
        </p>
      ) : null
    ) : (
      <>
        {catalogPending && <p role="status">{catalogPendingNote}</p>}
        <Recovery id={brand.id} controller={controller} />
      </>
    );
    return {
      choice,
      status,
      disabled: !controller.canSave || pending || !available,
      onChange: (next) => void controller.save(brand.id, next),
    };
  };
  const brands = useMemo(
    () =>
      category === "brands"
        ? filterInspirationBrands(inspirationBrands, query).filter(
            (brand) => !liked || hasInspirationChoice(displayed.get(brand.id)),
          )
        : [],
    [category, query, liked, displayed],
  );
  const shownBrands = useMemo(() => brands.slice(0, limit), [brands, limit]);
  const parts =
    category === "brands"
      ? []
      : filterInspirationParts(inspirationBrands, category, query).filter(
          (item) => !liked || partLiked(displayed.get(item.brand.id), category),
        );
  const total = category === "brands" ? brands.length : parts.length;
  const noun = inspirationCategories.find((item) => item.value === category)!.label.toLowerCase();
  const message = workspace ? (
    <h2 className="e-section__title inspiration-question">What do you like?</h2>
  ) : (
    <>
      <EmbelIdentity label={journeyPartLabel("identity", "Inspiration")} />
      {!conversation && <h1 className="sr-only">Inspiration</h1>}
      <p className="guided-assistant-copy">{lead}</p>
      <h2 className="inspiration-question">What do you like?</h2>
    </>
  );
  // In the conversation the gallery is part of Embel's message, so it lines up
  // with the chat; on the page it keeps its own wide column.
  const Frame = conversation || workspace ? "article" : "section";
  return (
    <div
      className={
        conversation
          ? "inspiration-workspace inspiration-in-conversation"
          : workspace
            ? "inspiration-workspace inspiration-in-workspace"
            : "inspiration-workspace"
      }
    >
      <Frame
        className={
          conversation
            ? "guided-assistant-message identity-conversation-message inspiration-browse"
            : "inspiration-browse"
        }
        aria-label="Inspiration gallery"
      >
        {conversation || workspace ? (
          message
        ) : (
          <div className="guided-assistant-message identity-conversation-message inspiration-message">{message}</div>
        )}
        <div className="inspiration-toolbar">
          <div className="inspiration-views" role="group" aria-label="Inspiration views">
            <button type="button" aria-pressed={!liked} onClick={() => reset({ liked: false })}>
              Browse
            </button>
            <button type="button" aria-pressed={liked} onClick={() => reset({ liked: true })}>
              Liked <span>· {controller.overview ? count : "—"}</span>
            </button>
          </div>
          <label className="inspiration-search">
            <Icon name="search" size={16} />
            <input
              type="search"
              aria-label="Search brands"
              placeholder="Search brands, colors or styles…"
              value={query}
              maxLength={160}
              onChange={(event) => reset({ query: event.target.value })}
            />
          </label>
          <div className="inspiration-categories" role="group" aria-label="Categories">
            {inspirationCategories.map((item) => (
              <button
                type="button"
                key={item.value}
                aria-pressed={category === item.value}
                onClick={() => reset({ category: item.value })}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        {controller.error ? (
          <div className="inspiration-notice" role="status">
            <span>{controller.error}</span>
            <button type="button" onClick={() => void controller.refresh()} disabled={controller.loading}>
              Retry connection
            </button>
          </div>
        ) : controller.loading ? (
          <p className="inspiration-notice" role="status">
            Loading saved choices…
          </p>
        ) : controller.blocked ? (
          <p className="inspiration-notice">Save or resolve your project edits before changing inspiration.</p>
        ) : null}
        <div className="inspiration-feed">
          {liked && !controller.overview ? (
            <div className="inspiration-empty">
              <h2>Saved choices are not available yet</h2>
              <p>Reconnect to load this project’s liked brands.</p>
            </div>
          ) : !total && !yours ? (
            <div className="inspiration-empty">
              <Icon name="assets" size={30} />
              <h2>{liked && !query ? "Start with a few likes" : `No ${noun} match this search`}</h2>
              <p>
                {liked && !query
                  ? "Like a whole brand with the heart next to its name, or just one of its images."
                  : "Try a brand name, a color or a style."}
              </p>
              <button type="button" onClick={() => reset({ query: "", liked: false })}>
                Browse all {noun}
              </button>
            </div>
          ) : category === "brands" ? (
            <BrandBento brands={shownBrands}>
              {(brand, box) => (
                <BrandCard
                  key={brand.id}
                  brand={brand}
                  rows={brandLayouts.get(brand.id)!.rows}
                  box={box}
                  likes={likesFor(brand, true)}
                  onOpen={(part) => setOpen({ brand, part })}
                />
              )}
            </BrandBento>
          ) : (
            <InspirationGrid>
              {parts.slice(0, limit).map(({ brand, image }) => (
                <PartCard
                  key={`${brand.id}:${image.part}`}
                  brand={brand}
                  image={image}
                  likes={likesFor(brand, true)}
                  onOpen={() => setOpen({ brand, part: image.part })}
                />
              ))}
            </InspirationGrid>
          )}
          {total > limit && (
            <button type="button" className="inspiration-more" onClick={() => setLimit((value) => value + page)}>
              Show more {noun}
            </button>
          )}
          {yours && <div className="inspiration-yours-slot">{yours}</div>}
          <footer className="inspiration-footer">
            <span>
              {Math.min(limit, total)} of {total} {noun}
            </span>
            {references ? (
              references.action
            ) : (
              <Link className="inspiration-footer-link" href={`/brands/account/${projectId}/identity`}>
                Add your own references
              </Link>
            )}
          </footer>
          {references?.status}
        </div>
        {!continueHidden && (
          <div
            className={
              conversation ? "inspiration-continue-inline" : "inspiration-continue-row inspiration-continue-bar"
            }
          >
            <span>{count === 1 ? "1 liked" : `${count} liked`} · Next: Logo</span>
            {onContinue ? (
              <button type="button" className="inspiration-continue" onClick={onContinue}>
                Continue
                <Icon name="arrow" size={16} />
              </button>
            ) : (
              <Link className="inspiration-continue" href={`/brands/account/${projectId}/logo`}>
                Continue
                <Icon name="arrow" size={16} />
              </Link>
            )}
          </div>
        )}
      </Frame>
      {open && (
        <BrandOverlay
          key={open.brand.id}
          brand={open.brand}
          initialPart={open.part}
          likes={likesFor(open.brand, false)}
          onClose={() => setOpen(null)}
          footer={
            <p className="inspiration-detail-footer">
              Your choices stay with{" "}
              <span translate="no">{brandName?.trim() || controller.overview?.projectTitle || "this brand"}</span>.
              Change them anytime.
            </p>
          }
        />
      )}
    </div>
  );
}
