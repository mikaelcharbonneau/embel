# Continue with Google, Apple or ChatGPT

_November 25, 2026: production had only email switched on; Google was being switched on. A button
appears by itself once its provider is on._ People can sign in or create an account with a provider instead of an email and
password. Supabase Auth runs the provider exchange; Embel only starts it and finishes it. A provider
button is shown only when that provider is really switched on in the Supabase project.

## How it works

| Step | What happens | Where |
|---|---|---|
| Which buttons to show | `getEnabledAuthProviders()` asks Supabase which providers are on. Uncertain means none | `src/server/auth/providers.ts` |
| Start | The button is a plain form post to `POST /api/auth/oauth/{google,apple,chatgpt}` with one optional field `next` (`/` or `/brands`, default `/brands`). The route checks the request origin, checks the provider is on, stores a PKCE verifier and the destination in HttpOnly cookies and answers 303 to this project's Supabase `/auth/v1/authorize` | `src/app/api/auth/oauth/[provider]/route.ts` |
| Provider | Supabase sends the browser to the provider and receives its answer at `https://<project>.supabase.co/auth/v1/callback` | Supabase |
| Finish | Supabase returns to `/auth/callback?sb_flow_id=...&code=...`. The route exchanges the code with the verifier from this browser, checks the account has a confirmed email, sets the session cookies and answers 303 to the stored destination | `src/app/auth/callback/route.ts` |

Any failure (unknown or switched-off provider, wrong origin, cancelled or refused at the provider,
missing or reused code, another browser, unconfirmed email) ends on `/sign-in?provider=failed`. The
provider's own error text is never put in the address or the logs.

The destination is not part of the callback address. Supabase compares that address, query string
included, with the project's redirect allow-list, and the production list already accepts
`/auth/callback?sb_flow_id=...`; an extra parameter could stop it matching. Instead the start route sets
a cookie named after the flow (`embel-provider-flow-<flow id>`, HttpOnly, SameSite=Lax, path
`/auth/callback`, ten minutes) holding `/` or `/brands`, and the callback reads and removes it. Nothing
in the address can choose where the browser lands.

`/auth/callback` also still finishes email links (confirmation and password reset,
[account-creation.md](account-creation.md)). It tells the two apart by that cookie: a flow without one
ends on `/sign-in?confirmation=...` as before.

## Provider identifiers

One map in `src/server/auth/providers.ts`:

| Embel id | Supabase provider | Kind |
|---|---|---|
| `google` | `google` | built in |
| `apple` | `apple` | built in |
| `chatgpt` | `custom:chatgpt` | custom OIDC provider that must be created in the project with exactly this identifier |

**ChatGPT.** OpenAI's "Sign in with ChatGPT" is standard OpenID Connect: issuer
`https://auth.openai.com`, scopes `openid profile email`, public or confidential clients, exact
registered callback addresses ([OpenAI guide](https://developers.openai.com/siwc/website), read
November 25, 2026). Supabase supports any such provider as a
[custom OIDC provider](https://supabase.com/docs/guides/auth/custom-oauth-providers) whose identifier
starts with `custom:`. OpenAI currently gives client ids to selected commercial partners only (a limited
trial with a waitlist), so Embel has none yet and the button stays hidden. Not verified: an actual
sign-in through Supabase with a real OpenAI client id.

## How "switched on" is decided

- Google and Apple: Supabase's public settings (`GET /auth/v1/settings` with the publishable key) list
  `external.google` and `external.apple`. Only a literal `true` counts.
- ChatGPT: custom providers are not in those public settings (the Auth server's settings reply lists
  built-in providers only), so the server asks the Auth admin API
  (`GET /auth/v1/admin/custom-providers/custom:chatgpt`) with `EMBEL_ENGINE_SUPABASE_SECRET_KEY` and
  shows the button only for an exact `identifier` with `enabled: true`. This is the request the pinned
  auth-js makes for `auth.admin.customProviders.getProvider`, and matches the supabase/auth source; it
  has not been tried against the live project. Where that key is not set (previews, local development)
  ChatGPT is off.
- Supabase not configured, a timeout (2.5 seconds), a network error or an unexpected reply: no providers.
- The answer is remembered for one minute per server instance (five seconds after a failure), so turning
  a provider on or off in Supabase reaches the pages within about a minute. Supabase itself refuses a
  provider that was just turned off, which ends on `/sign-in?provider=failed`.

## Accounts

- Supabase marks an account's email confirmed when the provider says the email is verified. Embel's
  usual check (`isConfirmedAuthResult`) applies unchanged: without a confirmed email no session is set.
  A provider that returns no email, or an unverified one, cannot sign in.
- The only database work at sign-up is the existing trigger on `auth.users`
  (`embel_shared_account_auth_changed`), which records the account id in
  `fluid_private.shared_accounts` and reads no name or metadata. Other rows are created on first use.
  Provider accounts need no extra provisioning and no migration.
- Apple gives no name on the web and may give a private relay email. Nothing at first sign-in needs a
  name.
- Same email as an existing account: Supabase links a provider identity to the existing account when
  both emails are verified, so a person who signed up with a password and later uses Google with the
  same address reaches the same account. Supabase does not link unverified emails. Apple's "Hide My
  Email" gives a relay address, which is a different email and so a separate account. Embel adds no
  linking of its own ([Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)).
- An account created with a provider has no password. "Forgot password" should let it set one (Supabase
  sends reset links to any account with an email); not tested.

## Setup the owner or release lead does (nothing here is done by code)

1. **Supabase, URL Configuration.** Nothing new: the provider flow returns to the same address as email
   links, `https://www.embel.xyz/auth/callback?sb_flow_id=<id>`, which the production allow-list already
   accepts. Any other origin (preview, local) needs its own entry, as for email links. If an address
   is not allowed, Supabase silently returns to the Site URL instead and the sign-in cannot finish.
2. **Each provider.** Register Supabase's callback, `https://fricsfwqibyhemknqgyf.supabase.co/auth/v1/callback` (production),
   as the redirect address (Google: OAuth client, Authorized redirect URIs; Apple: Services ID, Return
   URLs; OpenAI: the registered callback of the client id).
3. **Supabase, Auth Providers.** Enable Google and Apple with their client id and secret. For ChatGPT,
   New Provider, Auto-discovery (OIDC), identifier `custom:chatgpt`, issuer `https://auth.openai.com`,
   scopes `openid profile email`.
4. Secrets live only in Supabase and at the providers. Embel has no new environment variable.

## Protection

- The start route accepts only a same-origin form post (`assertMutationOrigin`), and SameSite=Lax
  cookies; the code can only be exchanged by the browser that holds the verifier.
- No BotID: BotID attaches its challenge to script requests, and this is a plain form post so that the
  buttons work before the page's script loads. The route starts no paid work, sends no email and creates
  no account; the provider and Supabase decide that later.
- WAF rate limit: see [security-rate-limits.md](security-rate-limits.md).

## Tests

`tests/server/auth-oauth.test.ts` uses the real pinned Supabase SDK with a synthetic transport and
cookie jar: which providers are reported, fail-closed cases, the cache, the start redirect and its
verifier cookie, refused starts, the full code exchange to `/` and `/brands`, provider errors, other
browsers, a refused or failed code exchange, unconfirmed emails, an Apple account without a name,
`next` in the address being ignored and two flows in one browser. No request reaches Supabase or a provider.
