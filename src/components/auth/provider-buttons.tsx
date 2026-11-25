"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { authProviderLabels, authProviders, type AuthProvider } from "@/domain/auth-providers";

/* Provider marks, drawn inline so no request leaves the page. The Google mark keeps its own four colours;
   the others take the text colour. */
function ProviderMark({ provider }: { provider: AuthProvider }) {
  if (provider === "google")
    return (
      <svg className="auth-provider__mark" aria-hidden="true" width="18" height="18" viewBox="0 0 48 48">
        <path
          fill="#EA4335"
          d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
        />
        <path
          fill="#4285F4"
          d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
        />
        <path
          fill="#FBBC05"
          d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
        />
        <path
          fill="#34A853"
          d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
        />
      </svg>
    );
  return (
    <svg
      className="auth-provider__mark"
      aria-hidden="true"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="currentColor"
    >
      <path d={provider === "apple" ? appleMark : chatgptMark} />
    </svg>
  );
}

const appleMark =
  "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701";
const chatgptMark =
  "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

/**
 * "Continue with Google / Apple / ChatGPT", above the email form. Each button is its own plain form post, so it
 * works before the page's script loads: the server answers with a redirect to the provider and the browser leaves
 * the app. Only providers the server reports as enabled are drawn; with none, nothing is drawn at all.
 */
export function ProviderButtons({
  providers,
  next,
  disabled = false,
  onLeave,
}: {
  providers: readonly AuthProvider[];
  /** Where the person lands once signed in: an in-app path. */
  next: string;
  /** Another request is on its way, or the session is still being checked. */
  disabled?: boolean;
  /** Runs as the browser starts leaving for the provider (typed passwords are cleared here). */
  onLeave?: () => void;
}) {
  // The ref stops a second submission in the same tick; the state draws the pressed button as busy.
  const leaving = useRef(false);
  const [pending, setPending] = useState<AuthProvider | null>(null);

  // Back from the provider, the browser may restore this page as it was left: the buttons work again.
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      leaving.current = false;
      setPending(null);
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);

  // Fixed order, whatever order the server lists them in; unknown names are never drawn.
  const shown = authProviders.filter((provider) => providers.includes(provider));
  if (shown.length === 0) return null;
  return (
    <div className="auth-providers">
      <div className="auth-providers__list" role="group" aria-label="Continue with another account">
        {shown.map((provider) => (
          <form
            key={provider}
            className="auth-providers__item"
            method="post"
            action={`/api/auth/oauth/${provider}`}
            onSubmit={(event) => {
              if (disabled || leaving.current) {
                event.preventDefault();
                return;
              }
              leaving.current = true;
              setPending(provider);
              onLeave?.();
            }}
          >
            <input type="hidden" name="next" value={next} />
            {/* Busy keeps the pressed button enabled, so the post it started is not withdrawn. */}
            <Button
              type="submit"
              variant="secondary"
              block
              className="auth-provider"
              aria-label={`Continue with ${authProviderLabels[provider]}`}
              translate="no"
              loading={pending === provider}
              disabled={disabled || (pending !== null && pending !== provider)}
            >
              {pending === provider ? null : <ProviderMark provider={provider} />}
              <span className="auth-provider__name">{authProviderLabels[provider]}</span>
            </Button>
          </form>
        ))}
      </div>
      <p className="auth-providers__divider">or continue with email</p>
    </div>
  );
}
