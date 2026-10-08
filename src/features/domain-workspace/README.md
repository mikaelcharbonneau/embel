# Domains workspace integration

This independent module prepares the roadmap’s domain workspace. The account consumer supports manual draft persistence and explicit owned saved-name imports through the shared standalone-workspace contract. It does not connect a registrar or perform registration. There are no live provider requests or selections in its default configuration.

## Public entry

`DomainsWorkspace` and `DomainsWorkspaceProps` are exported from `src/features/domain-workspace/index.ts`; pure schemas/helpers/types are exported from the same entry (server users should import `model.ts` directly to avoid the client boundary).

- `adapter`: explicit `unavailable` default, or a client-side **read-only** `check(domain, signal)` and optional `quote(domain, checkId, signal)`. Responses are untrusted `unknown`, validated against evidence-bearing schemas, and bound to the exact domain/provider/check. There is no order submission or payment callback.
- `library`: unavailable/loading/error/ready state. Ready records must be authenticated and ownership-verified upstream. Only registrar-confirmed orders with origin `fluid` pass the purchased record schema. Pending/paid-only/external records are excluded with a visible warning. Confirmation records describe historical purchase evidence, not current DNS/renewal status.
- `orders`: optional owner-verified order snapshots, separate from the purchased library; payment, pending registration, failure, reconciliation and confirmed registration remain distinct.
- `initialInput`: optional entered names or exact domains. Preparation constructs candidates locally; it neither checks nor reserves them.
- `draft` / `onDraftChange`: controlled strict manual draft. Text or extension edits clear candidates and transient evidence; `draftDisabled` blocks editing during account recovery. `initialView`, `draftNotice` and `draftControls` let the account consumer compose its save/import controls without changing the standalone default.
- `onCreateBrand(source)`: optional client callback preserving domain and its original check/order evidence. It carries no purchase/availability/strategy approval. Absent callback shows unavailable messaging and disabled buttons.

The component opens on Library by default; its account consumer opens Search. Search accepts up to 20 comma/newline entries, bounded at 4,000 characters. Space removal for ASCII seed names is disclosed. Syntax validation is deliberately distinct from public-suffix/registrability/TLD support: no suffix list, registrar coverage or internationalized-name support is invented. No AI suggestions, DNS, transfer or renewal controls are introduced. The default uncontrolled component keeps state in the mounted tab. `AccountDomainsWorkspace` explicitly saves only the strict manual draft to its account API; it never saves provider evidence. See [account integration](../../../docs/domains-account-integration.md).

## Integration lead ownership and unfinished contracts

1. Activate the component in shared `ToolWorkspace`/routing. This patch changes neither.
2. Wire provider-held standalone draft memory into `AccountDomainsWorkspace`, synchronous session fences and unsaved sign-out/exit guards. The supplied wrapper hides unverified account data and remounts on the verified owner/session-generation key. Function adapters must be built in that client wrapper, not passed from a Server Component. Abort signals and component request fencing do not replace server ownership enforcement.
3. The account wrapper consumes the separately owned shared standalone draft API. Library/order APIs and durable order/webhook semantics remain separate future contracts. Adapters must return authentic evidence from authorized read-only endpoints; fixtures cannot become runtime fallbacks.
4. Choose/authorize registrar, extensions, payment, renewal/contact/checkout contracts separately. Even a valid quote remains non-actionable in this UI. Future submit logic must recheck expiry and domain/check binding with current **server** time, require explicit checkout approval, contact/terms completeness, fresh availability, ownership and idempotency. No purchase activation is delivered here.
5. Integrate explicit brand creation with the shared promotion contract; preserve source IDs and check dates and guide missing strategy. The source callback does not silently change a project name.

`applyDomainOrderEvent` is pure fixture/state logic for **already authenticated, signature-verified** events. It is not a webhook endpoint or authorization boundary. Exact replay is idempotent within a bounded history because `appliedEvents` retains each canonical parsed payload alongside `appliedEventIds`. Reusing an ID with changed type/order/payment/registrar evidence throws a reconciliation error before replay can return. Legacy snapshots with IDs but no retained payload remain readable; replay of those IDs requires reconciliation rather than assuming a match. Future durable integrations must persist both fields atomically (or reconstruct receipts only from the original verified event log), never infer original event payloads from current order state. Mismatched order/domain/provider evidence is rejected, payment confirmation cannot set registration success, conflicting evidence requires reconciliation, and late failure cannot erase registrar confirmation. Durable deduplication/reconciliation/refund policy remains a server integration dependency. Confirmed purchases may have unknown expiry; no current ownership or auto-renew assertion is inferred.

## Local fixture verification

`fixtures.ts` contains explicitly synthetic examples, is never imported by the runtime entry, and uses no real provider/account/purchase evidence.

- `npx vitest run tests/features/domain-workspace`
- `npx eslint src/features/domain-workspace src/components/tools/domain-account-workspace.tsx tests/features/domain-workspace`
- `npx tsc --noEmit -p tests/features/domain-workspace/tsconfig.json`
- `node tests/features/domain-workspace/browser-check.mjs`
- `node tests/features/domain-workspace/account-browser-check.mjs`

The browser checker bundles only this module and shared styles, serves an ephemeral loopback port, launches its own headless Chromium, blocks external-origin expectations, and writes screenshots/evidence under ignored `.tmp/domains-preview`. It never uses the shared live browser or app server. No provider calls, purchases, credentials, generation, migrations or deployment are involved. Evidence from this checker is synthetic UI evidence only.

The account checker additionally bundles the shared account hook/client/memory with fixture-only provider memory binding and synthetic API replies. Its output is `.tmp/domains-account-preview`. It does not establish real-account persistence, hosted activation, production session guard integration or database tenant isolation. Both checkers support `FLUID_TEST_CHROMIUM_EXECUTABLE` for an existing dedicated headless browser executable; no browser download is performed.
