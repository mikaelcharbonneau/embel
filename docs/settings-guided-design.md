# Settings — approved Figma adaptation

Source: Fluid — Screens, file HP219GuYbpE8F1wHxj0h6N, page 3:13. The user requested this screen on 2026-10-10. Implemented Account (7:8958), Workspace (45:458), AI preferences (45:5218), Usage & billing (46:611), Notifications (46:856), Security & privacy (46:5635), and Integrations (46:5848).

All seven frames were inspected using design context and screenshots. Original shell icons, integration logos, switch artwork, select chevron and each native background grid were exported read-only through Figma's SVG export workflow. The inherited proxy rejected the temporary asset URL with CONNECT 403; no policy bypass was used. Artwork is under public/settings, with exact native dimensions. The implementation uses existing Geist tokens, React components and scoped CSS, not generated reference markup.

Tabs support click, Left/Right, Home/End, selected-tab focus and named panels. The content adapts at smaller widths, with horizontally scrollable tabs and stacked forms. Generic user avatars replace sample initials.

Profile editing, photo uploads, account-wide display and AI preferences, shared members/invitations, notification preferences, privacy controls, billing/invoices, full account export/deletion and app integrations have no existing supported backend. They remain disabled with explicit unavailable states. No sample name, email, card, price, invoice, credit balance, enabled switch, Figma connection or subscription model is asserted. Disabled switch artwork is labelled unavailable, without asserting an on/off setting. Private project visibility describes the existing ownership contract and cannot be changed here. Codex's connected plugins are not Embel account integrations.

Supported behavior is retained:

- Account status and account-menu sign-in/recheck/sign-out remain the existing verified session flow. Security also exposes those same browser-session controls, including unsaved-edit confirmation.
- Workspace shows real browser project drafts and explicit destructive confirmation for clearing only those drafts. Names workshop storage and saved account projects remain separate. Storage failures retain their honest tab-only warning.
- AI preferences retains read-only text readiness for hosted mode and the existing explicitly enabled local ChatGPT panel for local mode. Existing operation model selections and provider budgets are unchanged. Owned requests remain bounded, abortable and fenced by owner/session generation; mounting a tab never starts inference or authorization.
- Usage & billing retains the existing completed Strategy/Naming token history, its bounded coverage, unknown counts, explicit refresh, and ownership fences. It does not represent an account-wide total, credit balance or invoice ledger.

Unsupported preference save/cancel controls are disabled; no fake save receipt, local substitute for account settings, provider activation, migration, permission change, new credentials or live paid request is introduced. This design record does not authorize publication of a new review milestone.
