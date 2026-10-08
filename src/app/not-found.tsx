import Link from "next/link";

export default function NotFound() {
  return <div className="page"><div className="empty-panel"><h1>Page not found</h1><p>This page is not part of the workspace.</p><Link className="button primary" href="/">Back to Home</Link></div></div>;
}
