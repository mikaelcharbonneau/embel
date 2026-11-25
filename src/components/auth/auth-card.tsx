import Image from "next/image";
import type { ReactNode, Ref } from "react";

/**
 * The card every auth screen uses. In the overlay it is the dialog's form panel, with the Embel mark above a
 * centred title; on a direct visit the same card sits on the page, under the navigation.
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
        {overlay ? (
          <Image className="auth-card__mark" src="/embel-mark.svg" width={36} height={36} alt="Embel" unoptimized />
        ) : null}
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
