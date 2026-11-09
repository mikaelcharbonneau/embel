import { NextResponse, type NextRequest } from "next/server";
import { getApplicationOrigin } from "@/server/config";
import { confirmationStatus } from "@/server/auth/confirmation";

// Must list the same paths as the matcher below.
const AUTH_PAGES = ["/sign-in", "/sign-up", "/forgot-password", "/reset-password"];

/** Production credentials belong to the configured site, not its deployment aliases. */
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (process.env.VERCEL !== "1" || process.env.VERCEL_ENV !== "production" ||
      !["GET", "HEAD"].includes(request.method) || !AUTH_PAGES.includes(path)) {
    return NextResponse.next();
  }

  let origin: string;
  try { origin = getApplicationOrigin(); }
  catch { return NextResponse.next(); }
  if (request.nextUrl.origin === origin) return NextResponse.next();

  // Only navigation moves. API bodies, callbacks and browser draft pages retain
  // their existing origin boundaries. Never derive the destination from headers.
  const destination = new URL(path, origin);
  const confirmation = confirmationStatus(request.nextUrl.searchParams.get("confirmation"));
  if (confirmation) destination.searchParams.set("confirmation", confirmation);
  const response = NextResponse.redirect(`${destination.href}#`, 307);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

export const config = { matcher: ["/sign-in", "/sign-up", "/forgot-password", "/reset-password"] };
