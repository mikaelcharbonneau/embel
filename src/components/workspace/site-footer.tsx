import Link from "next/link";

const links = [
  { href: "/help", label: "Help" },
  { href: "/terms", label: "Terms" },
  { href: "/privacy", label: "Privacy" },
] as const;

/** Help and the legal pages, under every page that is not Home or an open project. */
export function SiteFooter() {
  return (
    <footer className="site-footer e-container">
      <nav aria-label="Help and legal">
        <ul className="site-footer__links">
          {links.map((link) => (
            <li key={link.href}>
              <Link className="e-link e-link--standalone" href={link.href}>
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <p className="site-footer__copyright">© {new Date().getFullYear()} Embel</p>
    </footer>
  );
}
