# Sign-up, sign-in and password-reset CAPTCHA (Cloudflare Turnstile)

_November 9, 2026 · Part of step 2.2 of `docs/architecture-review.md`._

A CAPTCHA stops bots from mass-creating accounts and guessing passwords. Embel uses
Cloudflare Turnstile through Supabase Auth. It is mostly invisible to real people.

**Right now it is switched off.** The code is in the app but does nothing until you set the
public site key. With no key, no widget appears, no Cloudflare script loads, and sign-up,
sign-in and reset work exactly as before.

## What the app does when it is on

- The sign-up, sign-in, "forgot password" and "resend confirmation" forms show the Turnstile
  check. The form will not send until the check has passed.
- The check result (a token) goes with the request to Supabase, which verifies it with Cloudflare.
- A token works once, so the check is reset after every attempt.
- If the check fails, the person sees: "The security check didn't pass. Please try again."
- Choosing a new password from the emailed link is not affected (it is already protected by the
  one-time link).
- Embel has no content security policy today, so nothing needs allowing for Cloudflare.
  If one is added later, allow `https://challenges.cloudflare.com` for scripts, frames and
  connections, and only when the site key is set.

## Setup (in this order)

The order matters. If Supabase's CAPTCHA is switched on before the site key is live in the app,
**nobody can sign in, sign up or reset a password**, because Supabase will demand a check the
forms do not yet show.

1. **Create the widget in Cloudflare.** Cloudflare dashboard → Turnstile → Add widget. Name it
   "Embel". Add your hostnames: the production domain (and `localhost` if you want to test
   locally). Widget mode: Managed. Copy the **Site Key** (public) and the **Secret Key** (private).
2. **Put the site key in Vercel first.** Vercel → Embel project → Settings → Environment
   Variables → add `NEXT_PUBLIC_TURNSTILE_SITE_KEY` with the Site Key, for **Production**
   (add Preview too only if you add the preview hostnames in Cloudflare).
3. **Redeploy.** The key is built into the app, so a new deployment is required
   (Deployments → latest deployment → Redeploy).
4. **Check the widget shows, with Supabase still off.** Open the sign-in, sign-up and
   forgot-password pages. You should see the Turnstile check, and signing in should still work.
5. **Switch on Supabase.** Supabase dashboard → Authentication → Attack Protection → enable
   CAPTCHA protection → provider Turnstile → paste the **Secret Key** → Save.
6. **Test all three.** In a private window: create an account (and confirm the email), sign in,
   and request a password reset. Each should succeed. Also try the "Resend confirmation" link on
   the sign-up confirmation screen.

Never put the Secret Key in Vercel, in the code or in chat. It belongs only in Supabase.

## Rollback

If sign-in, sign-up or reset stops working after step 5:

1. **Supabase first:** Authentication → Attack Protection → turn CAPTCHA protection **off**
   → Save. Logins work again immediately, even though the widget is still shown.
2. If you also want the widget gone: Vercel → delete `NEXT_PUBLIC_TURNSTILE_SITE_KEY` →
   Redeploy.

Always turn Supabase off before removing the Vercel key, never the other way round.
Rolling back the code (reverting this change) is also safe, but only after Supabase's CAPTCHA
is off.

## Notes for developers

- Env var: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (public by design; read in
  `src/components/auth/turnstile-widget.tsx`).
- The widget loads Cloudflare's official script
  (`https://challenges.cloudflare.com/turnstile/v0/api.js`) at runtime. Cloudflare serves it at a
  fixed address and requires that it is not self-hosted, so there is no npm package or version
  to pin.
- Routes accept an optional `captchaToken` and pass it to Supabase as `options.captchaToken`
  (`src/server/auth/captcha.ts`). Supabase's `captcha_failed` error becomes the app error
  `captcha_failed` (HTTP 400). Unknown-account answers stay unchanged.
- The Turnstile secret key is verified by Supabase; Embel's server never sees it.
