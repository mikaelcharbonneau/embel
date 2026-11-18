import Link from "next/link";
import type { ReactNode } from "react";

export type DocumentSection = { id: string; title: string; body: ReactNode };

/** A reading page for Terms, Privacy and Help: title, an optional date and summary, a list of the sections that
 * jumps to each one, then the sections. The pages are static and read the same signed in or out. */
export function DocumentPage({
  title,
  updated,
  intro,
  sections,
}: {
  title: string;
  updated?: string;
  intro: ReactNode;
  sections: DocumentSection[];
}) {
  return (
    <article className="doc-page e-container e-container--reading e-page" aria-labelledby="doc-title">
      <header className="doc-page__header">
        <h1 id="doc-title" className="doc-page__title">
          {title}
        </h1>
        {updated && <p className="doc-page__updated">Last updated {updated}</p>}
        <div className="doc-page__intro">{intro}</div>
      </header>
      <nav className="doc-page__contents" aria-label="On this page">
        <h2 className="doc-page__contents-title">On this page</h2>
        <ol>
          {sections.map((section) => (
            <li key={section.id}>
              <a className="e-link" href={`#${section.id}`}>
                {section.title}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {sections.map((section) => (
        <section key={section.id} id={section.id} className="doc-page__section" aria-labelledby={`${section.id}-title`}>
          <h2 id={`${section.id}-title`} className="doc-page__section-title">
            {section.title}
          </h2>
          {section.body}
        </section>
      ))}
    </article>
  );
}

/** A link to another page of the app inside document text. */
export function DocLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link className="e-link" href={href}>
      {children}
    </Link>
  );
}

export function MailLink({ address }: { address: string }) {
  return (
    <a className="e-link" href={`mailto:${address}`}>
      {address}
    </a>
  );
}
