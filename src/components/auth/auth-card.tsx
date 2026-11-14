import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { Icon } from "@/components/ui/icon";

/**
 * The card every auth screen uses. In the overlay the dialog is the card's surface; on a direct visit the same
 * card sits on the page with a way back to Home under it.
 */
export function AuthCard({
  overlay,
  titleId,
  titleRef,
  title,
  intro,
  onLeave,
  children,
}: {
  overlay: boolean;
  titleId: string;
  titleRef?: Ref<HTMLHeadingElement>;
  title: string;
  /** One sentence under the title. */
  intro: ReactNode;
  /** Runs before the Return to Home link navigates, so forms can clear their passwords. */
  onLeave?: () => void;
  children: ReactNode;
}) {
  const card = (
    <section className="auth-card" aria-labelledby={titleId}>
      <header className="auth-card__header">
        <h1 ref={titleRef} tabIndex={-1} id={titleId} className="auth-card__title">
          {title}
        </h1>
        <p className="auth-card__intro">{intro}</p>
      </header>
      {children}
    </section>
  );
  if (overlay) return card;
  return (
    <div className="auth-page">
      {card}
      <Link className="e-link e-link--standalone auth-page__home" href="/" onClick={onLeave}>
        Return to Home
        <Icon name="arrow-right" size="sm" />
      </Link>
    </div>
  );
}
