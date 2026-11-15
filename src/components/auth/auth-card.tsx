import type { ReactNode, Ref } from "react";

/**
 * The card every auth screen uses. In the overlay the dialog is the card's surface; on a direct visit the same
 * card sits on the page, under the navigation.
 */
export function AuthCard({
  overlay,
  titleId,
  titleRef,
  title,
  intro,
  children,
}: {
  overlay: boolean;
  titleId: string;
  titleRef?: Ref<HTMLHeadingElement>;
  title: string;
  /** One sentence under the title, only when the screen needs it (an idea kept for after sign-in). */
  intro?: ReactNode;
  children: ReactNode;
}) {
  const card = (
    <section className="auth-card" aria-labelledby={titleId}>
      <header className="auth-card__header">
        <h1 ref={titleRef} tabIndex={-1} id={titleId} className="auth-card__title">
          {title}
        </h1>
        {intro ? <p className="auth-card__intro">{intro}</p> : null}
      </header>
      {children}
    </section>
  );
  return overlay ? card : <div className="auth-page">{card}</div>;
}
