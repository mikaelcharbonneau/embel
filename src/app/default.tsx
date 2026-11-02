import { notFound } from "next/navigation";

// The root auth overlay is a parallel slot. Preserve a 404 when a full-page
// navigation has no matching children page, rather than relaxing route matching.
export default function Default() {
  notFound();
}
