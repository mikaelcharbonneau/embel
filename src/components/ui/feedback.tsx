import type { ReactNode } from "react";
import { Icon, type IconName } from "./icon";

/**
 * What a page or section shows when it has nothing yet. Page: one icon in a 56 px circle, a title saying what will
 * appear here, one sentence and one action. Results: names what was searched and offers to clear it. Section: one
 * sentence with a link, inside a card. Page errors (404, an unavailable project) use the danger visual.
 */
export function EmptyState({
  icon = "folder",
  title,
  text,
  action,
  variant = "page",
  danger = false,
  headingLevel = 2,
}: {
  icon?: IconName;
  title?: ReactNode;
  text?: ReactNode;
  action?: ReactNode;
  variant?: "page" | "results" | "section";
  danger?: boolean;
  headingLevel?: 1 | 2 | 3;
}) {
  if (variant === "section") return <p className="e-empty e-empty--section">{text}</p>;
  const Heading = `h${headingLevel}` as const;
  return (
    <div className={variant === "results" ? "e-empty e-empty--results" : "e-empty"}>
      <span className={danger ? "e-empty__visual e-empty__visual--danger" : "e-empty__visual"} aria-hidden="true">
        <Icon name={icon} size="lg" />
      </span>
      {title ? <Heading className="e-empty__title">{title}</Heading> : null}
      {text ? <p className="e-empty__text">{text}</p> : null}
      {action ? <div className="e-empty__action">{action}</div> : null}
    </div>
  );
}

/** A small static label that states something. A tone badge always carries an icon and a clear word. */
export function Badge({
  tone = "neutral",
  icon,
  children,
}: {
  tone?: "neutral" | "positive" | "warning" | "danger";
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <span className={tone === "neutral" ? "e-badge" : `e-badge e-badge--${tone}`}>
      {icon ? <Icon name={icon} size="sm" /> : null}
      {children}
    </span>
  );
}

/** A placeholder in the exact shape of content that is loading; hidden from assistive technology. */
export function Skeleton({
  shape = "line",
  width,
  className,
}: {
  shape?: "line" | "title" | "block" | "circle";
  /** A share of the row, for text lines. */
  width?: 25 | 40 | 60 | 80;
  className?: string;
}) {
  const classes = ["e-skeleton", `e-skeleton--${shape}`, width && `e-skeleton--w${width}`, className]
    .filter(Boolean)
    .join(" ");
  return <span className={classes} aria-hidden="true" />;
}

/** Wraps skeletons so the region announces "Loading" once. */
export function LoadingRegion({ label = "Loading", children }: { label?: string; children: ReactNode }) {
  return (
    <div role="status" aria-label={label} aria-busy="true">
      {children}
    </div>
  );
}
