from pv import *
import zlib
SP = '<span class="e-spinner" aria-hidden="true"></span>'
def btn(label, kind='secondary', extra='', attrs=''):
    return f'<button type="button" class="e-button e-button--{kind} {extra}"{attrs}>{label}</button>'
def ib(icon, kind='quiet', label='Close', extra='', attrs=''):
    return f'<button type="button" class="e-icon-button e-icon-button--{kind} {extra}" aria-label="{label}"{attrs}>{ic(icon)}</button>'
CLOSE = ib('x', 'quiet', 'Close', 'e-icon-button--sm')

# ---------------------------------------------------------------- Dialog
def dialog(size, title, bodyhtml, footer, tag='div', attrs=' data-static', bodycls=''):
    return (f'<{tag} class="e-dialog e-dialog--{size}" role="dialog" aria-modal="true" aria-labelledby="t-{zlib.crc32(title.encode())%9999}"{attrs}>'
            f'<div class="e-dialog__header"><h2 class="e-dialog__title" id="t-{zlib.crc32(title.encode())%9999}">{title}</h2>{CLOSE.replace("<button", "<button data-e-close") if tag=="dialog" else CLOSE}</div>'
            f'<div class="e-dialog__body {bodycls}">{bodyhtml}</div>' + (f'<div class="e-dialog__footer">{footer}</div>' if footer else '') + f'</{tag}>')
std = dialog('md', 'Generation activity', '<p>Research for <span translate="no">Kestrel Analytics</span> finished a moment ago. Nothing else is running.</p>', btn('Close') )
conf_body = '<p>This moves the project to Deleted projects and stops any work in progress. Its assets and history are kept, and you can restore it later.</p>'
conf = dialog('sm', 'Delete Orchard Lane Cider?', conf_body, btn('Cancel', attrs=' data-force="focus"') + btn('Delete project', 'danger-filled'))
media = dialog('lg', 'Direction 1: Editorial Soft Shapes', '<div class="e-media"><img src="{{img:kestrel-direction-1}}" alt="Direction board for Kestrel Analytics: deep navy and signal amber"></div>',
               btn('Previous') + btn('Next') + btn('Choose this direction', 'primary'), bodycls='e-dialog__body--media')
loading = dialog('md', 'Brand details', '<span class="e-skeleton e-skeleton--title e-skeleton--w40"></span><span class="e-skeleton e-skeleton--line e-skeleton--w80"></span><span class="e-skeleton e-skeleton--line e-skeleton--w60"></span>', btn('Close'))
error = dialog('sm', 'Delete Orchard Lane Cider?', conf_body + '<div class="e-message e-message--block e-message--danger" role="alert">' + ic('circle-alert') + '<div class="e-message__body"><p>The project wasn’t deleted. Check your connection and try again.</p></div></div>',
               btn('Cancel') + btn('Delete project', 'danger-filled'))
busy = dialog('sm', 'Delete Orchard Lane Cider?', conf_body, btn('Cancel') + f'<button type="button" class="e-button e-button--danger-filled" aria-busy="true" aria-disabled="true">{SP}Delete project</button>')
stage = lambda h: f'<div class="pv-stage">{h}</div>'
live = ('<dialog class="e-dialog e-dialog--sm" id="live-dialog" aria-labelledby="live-t"><div class="e-dialog__header"><h2 class="e-dialog__title" id="live-t">Sign out of Embel?</h2>'
        + CLOSE.replace('<button', '<button data-e-close') + '</div><div class="e-dialog__body"><p>Your work stays saved in your account.</p></div><div class="e-dialog__footer">'
        + btn('Cancel', attrs=' data-e-close autofocus') + btn('Sign out', 'primary', attrs=' data-e-close') + '</div></dialog>')
body = sec('Try it', '<div class="pv-row">' + btn('Open a dialog', attrs=' data-e-open="live-dialog"') + '</div>' + live, note='A native dialog: focus moves in, is trapped, and returns to the opener. It opens from 97% over 200 ms and closes at once. Below 640 px it is a bottom sheet.')
body += sec('Standard (medium, 560 px)', stage(std))
body += sec('Confirmation (small, 440 px): focus starts on Cancel', stage(conf))
body += sec('Media (large, 860 px)', stage(media))
body += sec('Content states', grid(cell('Loading', stage(loading), True), cell('Action running: the dialog stays open', stage(busy), True), cell('Error: shown inside the dialog', stage(error), True), cls='pv-grid--wide'))
write('Dialog', 'Overlays', body, '''
# Dialog

A modal surface for one decision or one focused view. You provide the title, the body and the actions.

- Parts: a header with the title and one close button, a scrolling body, a footer with actions right-aligned and the primary action last.
- Sizes: small 440 px (`dialog-width-sm`, confirmations), medium 560 px, large 860 px (media), extra large 1100 px (the large brand view). At compact width every dialog is a bottom sheet, full width, up to 90% of the height.
- Always a native `<dialog>` opened with `showModal()`: focus moves in, is trapped, and returns to the opener. Escape closes it.
- One scrim, `color-bg-scrim`, no blur. One shadow, `shadow-modal`. Radius `radius-panel`.
- Opening uses `enter-scale` and `duration-base`; closing is instant.
- While an action runs, its button shows the loading state and the dialog stays open. A failure appears inside the dialog as a danger Inline message.
- Scrolling bodies set scroll padding so a focused control never sits under the header.
''', height=1900)

# ---------------------------------------------------------------- Drawer
drawer = ('<div class="e-drawer" data-static role="dialog" aria-modal="true" aria-label="Asset details" style="height:auto;max-height:none">'
          '<div class="e-dialog__header"><h2 class="e-dialog__title">Concept 1 · Version 2</h2>' + CLOSE + '</div>'
          '<div class="e-dialog__body"><div class="e-media e-media--contain"><img src="{{img:kestrel-logo-1}}" alt="Kestrel Analytics logo, version 2"></div>'
          '<dl class="e-stack e-stack--sm"><div class="e-cluster e-cluster--between"><dt class="e-muted">Project</dt><dd translate="no">Kestrel Analytics</dd></div>'
          '<div class="e-cluster e-cluster--between"><dt class="e-muted">Made</dt><dd>Nov 11, 2026</dd></div><div class="e-cluster e-cluster--between"><dt class="e-muted">Format</dt><dd>PNG, transparent</dd></div></dl></div>'
          '<div class="e-dialog__footer">' + btn(ic('heart') + 'Keep') + btn(ic('download') + 'Download PNG', 'primary') + '</div></div>')
body = sec('Right-edge drawer (480 px)', '<div class="pv-stage pv-stage--end">' + drawer + '</div>',
           note='For a detail view beside a list. It slides in over 300 ms with the drawer easing. Below 640 px it becomes the same bottom sheet as a dialog. Focus rules are the Dialog’s.')
write('Drawer', 'Overlays', body, '''
# Drawer and sheet

A panel that slides from an edge. You provide the title, the content and the actions.

- **Right-edge drawer**: a detail view next to a list (an asset in Library). Widths 480 px and 860 px.
- **Bottom sheet**: the compact form of every dialog and drawer.
- Slides with `ease-drawer` over `duration-slow`; closes instantly. Under reduced motion it fades.
- Same parts, scrim, shadow and focus rules as Dialog. A sticky header reserves scroll padding so focus is never hidden under it.
''', height=820)

# ---------------------------------------------------------------- Menu and popover
def mi(label, icon='', f='', cls='', attrs='', check=False):
    return f'<button type="button" class="e-menu__item {cls}" role="menuitem"{force(f)}{attrs}>{ic(icon) if icon else ""}{label}{ic("check", "e-menu__check") if check else ""}</button>'
menu_states = ('<div class="e-menu" role="menu" aria-label="Row states" style="animation:none">'
               + mi('Default', 'pencil') + mi('Hover', 'pencil', 'hover') + mi('Focus-visible', 'pencil', 'focus') + mi('Active', 'pencil', 'active')
               + mi('Selected', 'pencil', attrs=' aria-checked="true"', check=True) + mi('Disabled', 'pencil', attrs=' disabled')
               + '<div class="e-menu__separator" role="separator"></div>' + mi('Danger', 'trash-2', cls='e-menu__item--danger') + mi('Danger, hover', 'trash-2', 'hover', 'e-menu__item--danger') + '</div>')
account = ('<div class="e-menu" role="menu" aria-label="Account" style="animation:none"><span class="e-menu__label">audit-pro@example.test</span>'
           + mi('Settings', 'settings') + mi('Plans', 'credit-card') + '<div class="e-menu__separator" role="separator"></div>' + mi('Sign out', 'log-out') + '</div>')
card_menu = '<div class="e-menu" role="menu" aria-label="Project options" style="animation:none">' + mi('Delete', 'trash-2', cls='e-menu__item--danger') + '</div>'
pop = ('<div class="e-popover" role="dialog" aria-label="Add files" style="animation:none"><p class="e-field__label">Add files</p><p class="e-field__hint">Images or PDFs that describe your idea.</p>'
       + btn(ic('upload') + 'Choose files') + '</div>')
live = ('<span class="e-anchor e-anchor--start">' + btn(ic('arrow-up-down') + 'Sort', attrs=' data-e-menu="live-menu" aria-haspopup="menu" aria-expanded="false"')
        + '<div class="e-menu" id="live-menu" role="menu" aria-label="Sort projects" hidden><span class="e-menu__label">Sort by</span>'
        + mi('Last updated', attrs=' aria-checked="true"', check=True) + mi('Name', check=True) + mi('Date created', check=True) + '</div></span>')
body = sec('Try it', '<div class="pv-row" style="min-height:240px;align-items:flex-start">' + live + '</div>', note='Opens from the corner nearest its trigger over 150 ms. Closes on Escape, on an outside press and when focus leaves. The first press outside only closes.')
body += sec('Row states', grid(cell('Every state of a row', menu_states), cell('Account menu', account), cell('A card’s menu', card_menu), cell('Popover: a small non-modal panel', pop), cls='pv-grid--wide'))
write('Menu', 'Overlays', body, '''
# Menu and popover

A floating list of actions or choices, and a small non-modal panel. You provide the trigger and the rows.

- **Menu**: rows of actions (`menuitem`) or choices (`menuitemradio`, with a tick on the current one). A destructive row is the danger row, last, after a separator.
- **Popover**: a small panel for a few controls, such as adding files or voice input.
- Minimum width 200 px; rows 40 px, 44 px at compact width. Radius `radius-card`, rows `radius-small`, `shadow-overlay`, `z-popover`.
- Opens over `menu-duration` from the corner nearest its trigger. Closes on Escape (focus returns to the trigger), on an outside press and when focus leaves. The press that closes it is not passed to what is underneath.
- Do not build menus on `<details>`.
''', height=760)

# ---------------------------------------------------------------- Toast
def toast(text, action='', f=''):
    a = f'<button type="button" class="e-toast__action"{force(f)}>{action}</button>' if action else ''
    return f'<div class="e-toast e-on-inverse" style="animation:none"><span class="e-toast__text">{text}</span>{a}<button type="button" class="e-toast__close" aria-label="Dismiss">{ic("x", "e-icon--sm")}</button></div>'
body = sec('Try it', '<div class="pv-row">' + btn('Copy #0F2A3D', attrs=' id="t1"') + btn('Delete a project', attrs=' id="t2"') + '</div>',
           note='Bottom centre, above the composer. It leaves after 5 s, pauses on hover and focus, and is announced politely. Errors are never toasts.')
body += sec('Forms', grid(cell('Confirmation', toast('Copied')), cell('With one action', toast('Moved to Deleted projects', 'Undo')), cell('Action hover', toast('Moved to Deleted projects', 'Undo', 'hover')),
                          cell('Action focus-visible: the ring flips on ink', toast('Moved to Deleted projects', 'Undo', 'focus')), cls='pv-grid--wide'))
write('Toast', 'Feedback', body, '''
# Toast

A brief neutral confirmation for a result the person cannot see where they are looking. You provide one short sentence and, optionally, one action.

- Use for: copied, downloaded, saved in the background, moved to Deleted. Offer **Undo** when the action can be reversed.
- One size, bottom centre, above the composer (`z-toast`). Ink fill with white text; `radius-control`; `shadow-raised`.
- Appears with `enter-shift`, leaves after `toast-duration` (5 s) or on dismiss, pauses on hover and focus, and is announced politely (`role="status"`).
- One toast at a time. Never use a toast for an error, a warning or anything the person must read.
- On the ink surface the focus ring flips: a paper ring with an ink halo.
''', height=420, script="document.getElementById('t1').addEventListener('click',function(){Embel.toast('Copied')});document.getElementById('t2').addEventListener('click',function(){Embel.toast('Moved to Deleted projects',{action:'Undo',onAction:function(){Embel.toast('Project restored')}})});")

# ---------------------------------------------------------------- Inline message
TONES = [('neutral', 'info', 'Your work is saved. A paid plan adds more credits every month.', 'You’re out of credits for this month'),
         ('positive', 'circle-check', 'You’re on the Pro plan. 150 credits were added.', 'Payment confirmed'),
         ('warning', 'triangle-alert', 'You have changes on this page that aren’t saved yet.', 'Unsaved changes'),
         ('danger', 'circle-alert', 'Your changes weren’t saved. They are still here: check your connection, then save again.', 'Changes not saved')]
def msg(tone, icon, text, title='', form='block', actions='', dismiss=False):
    t = f'<p class="e-message__title">{title}</p>' if title else ''
    a = f'<div class="e-message__actions">{actions}</div>' if actions else ''
    d = ib('x', 'quiet', 'Dismiss', 'e-icon-button--sm') if dismiss else ''
    role = 'alert' if tone in ('danger', 'warning') else 'status'
    return f'<div class="e-message e-message--{form} e-message--{tone}" role="{role}">{ic(icon)}<div class="e-message__body">{t}<p>{text}</p>{a}</div>{d}</div>'
body = sec('Block: in a card or section', grid(*[cell(t.capitalize(), msg(t, i, x, ti, actions=(btn('Not now', 'quiet', 'e-button--sm') + btn('See plans', 'primary', 'e-button--sm')) if t == 'neutral' else (btn('Try again', extra='e-button--sm') if t == 'danger' else ''), dismiss=(t == 'positive')), True) for t, i, x, ti in TONES], cls='pv-grid--wide'),
           note='Always an icon and words as well as colour. The recovery action is a real button. Danger and warning are announced assertively, the rest politely.')
body += sec('Field: text under a field', grid(*[cell(t.capitalize(), msg(t, i, x, form='field')) for t, i, x in [('neutral', 'info', 'Checking that this name is free…'), ('positive', 'circle-check', 'This name is free.'), ('warning', 'triangle-alert', 'A similar name is already registered.'), ('danger', 'circle-alert', 'Enter a full email address, like name@example.com.')]], cls='pv-grid--wide'))
body += sec('Banner: full width under the navigation', '<div class="e-stack e-stack--sm">' + ''.join(msg(t, i, x, form='banner') for t, i, x, _ in TONES) + '</div>')
write('InlineMessage', 'Feedback', body, '''
# Inline message

The one way to tell the person something in place. You provide the tone, the words and, where there is one, the action that recovers.

- Tones: **neutral** (information; no blue), **positive**, **warning**, **danger**.
- Forms: **field** (text under a field), **block** (in a card or section, with an optional title, actions and dismiss), **banner** (full width under the navigation).
- Always an icon plus text; colour is never the only signal. Body text is `color-text` on the soft fill; only field-level text takes the tone colour.
- Say what happened in the person's terms and what to do next. The recovery action is a secondary Button inside the message, never a faint link.
- Danger and warning use `role="alert"`; neutral and positive use `role="status"`.
- Errors are never toasts and never bare coloured text. A positive block is for outcomes that matter after the moment ("Payment confirmed"); a passing confirmation is a Toast.
''', height=1100)

# ---------------------------------------------------------------- Table
rows = ''.join(f'<tr><td data-label="Step">Voice · Name</td><td data-label="Date">Nov 11, 2026</td><td class="is-num" data-label="Tokens used">4,800</td></tr>' for _ in range(3))
table = lambda body, cap='Recent requests': (f'<table class="e-table e-table--stack"><caption>{cap}</caption><thead><tr><th scope="col">Step</th>'
        '<th scope="col" aria-sort="descending"><button type="button" class="e-table__sort">Date' + ic('arrow-down') + '</button></th><th scope="col" class="is-num">Tokens used</th></tr></thead><tbody>' + body + '</tbody></table>')
sk = ''.join('<tr><td><span class="e-skeleton e-skeleton--line e-skeleton--w60"></span></td><td><span class="e-skeleton e-skeleton--line e-skeleton--w60"></span></td><td><span class="e-skeleton e-skeleton--line e-skeleton--w40" style="margin-left:auto"></span></td></tr>' for _ in range(3))
body = sec('Data table', table(rows.replace('<tr>', '<tr data-force="hover">', 1)), '<p class="e-field__hint">3 requests · 14,400 tokens used. Logo and image requests are not included.</p>', note='A caption, a header row, text and right-aligned numeric columns with tabular figures. The first row shows hover (pointer only); Date is the sorted column.')
body += sec('Loading: skeleton rows', table(sk))
body += sec('Empty', table('<tr><td colspan="3"><span class="e-empty e-empty--section">No requests yet. They appear here after your first brand.</span></td></tr>'))
body += sec('Compact width', '<p class="pv-note">Below 640 px each row becomes a stacked card with its column names as labels. Open the Settings validation screen at 390 to see it in a page.</p>')
write('Table', 'Data', body, '''
# Table

Rows of comparable data. You provide a caption, the column headers and the rows.

- Always a real `<table>` with a `<caption>` and `<th scope="col">`. A list of colour tokens is a table too.
- Rows 48 px. Text columns align left; numeric columns align right with tabular figures.
- Row hover (pointer only) is `color-bg-hover`. A sortable header is a button; the sorted column sets `aria-sort` and shows an arrow.
- Loading shows skeleton rows of the same height. Empty shows one sentence in place of the rows.
- Below 640 px each row stacks into a card and every cell carries its column name (`data-label`).
''', height=900)

# ---------------------------------------------------------------- Card
def pcard(name, action, img='', desc='', f='', attrs='', date='Today', sel=False):
    media = (f'<img src="{{{{img:{img}}}}}" alt="{name} logo">' if img else f'<p class="e-card__media-text">{desc}</p><span class="e-badge">No logo yet</span>')
    return (f'<article class="e-card e-card--interactive"{force(f)}{" data-selected" if sel else ""}{attrs}><div class="e-card__media">{media}</div>'
            f'<span class="e-card__corner"><span class="e-tooltip-host"><button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm" aria-label="Options for {name}" aria-haspopup="menu">{ic("ellipsis")}</button></span></span>'
            f'<div class="e-card__body"><div class="e-cluster e-cluster--between e-cluster--nowrap"><h3 class="e-card__title" translate="no"><a class="e-card__link" href="#">{name}</a></h3><span class="e-card__meta">{date}</span></div>'
            f'<span class="e-card__next">{action}{ic("arrow-right")}</span></div></article>')
skel = ('<div class="e-card" aria-hidden="true"><div class="e-card__media"><span class="e-skeleton" style="position:absolute;inset:0;border-radius:0"></span></div>'
        '<div class="e-card__body"><span class="e-skeleton e-skeleton--title e-skeleton--w60"></span><span class="e-skeleton e-skeleton--line e-skeleton--w40"></span></div></div>')
TW = 'Guided sea kayak tours and sunset paddles around the islands of Tofino, British Columbia, for beginners and families.'
body = sec('Interactive: the whole card is one link', grid(
    cell('Default', pcard('Kestrel Analytics', 'View brand kit', 'kestrel-logo-1'), True), cell('Hover: a stronger hairline, no lift', pcard('Tidewater Kayak Tours', 'Choose a logo', desc=TW, f='hover'), True),
    cell('Focus-visible', pcard('Tidewater Kayak Tours', 'Choose a logo', desc=TW, f='focus'), True), cell('Active', pcard('Kestrel Analytics', 'View brand kit', 'kestrel-logo-1', f='active'), True),
    cell('Selected', pcard('Kestrel Analytics', 'View brand kit', 'kestrel-logo-1', sel=True), True), cell('Loading: a skeleton in the card’s shape', skel, True), cls='pv-grid--wide'),
    note='Cards are for objects: a project, an asset, a plan, a choice. Page sections sit directly on the canvas.')
static = '<div class="e-card e-card--pad"><div class="e-stack e-stack--sm"><h3 class="e-card__title">Logo types</h3><p class="e-muted">Wordmark, Lettermark or monogram, Pictorial mark, Abstract mark, Combination mark, Emblem</p></div></div>'
mediac = ('<figure class="e-card"><div class="e-media e-media--16x9" style="border-radius:calc(var(--radius-card) - 1px) calc(var(--radius-card) - 1px) 0 0"><img src="{{img:kestrel-direction-3}}" alt="Direction board for Kestrel Analytics: indigo and coral"></div>'
          '<figcaption class="e-card__body"><div class="e-cluster e-cluster--between"><span class="e-card__title">Direction 3: Split Blocks</span><span class="e-cluster">' + ib('heart', 'quiet', 'Keep', 'e-icon-button--sm') + ib('download', 'quiet', 'Download', 'e-icon-button--sm') + '</span></div><span class="e-card__meta">Kestrel Analytics · Nov 11, 2026</span></figcaption></figure>')
summary = ('<div class="e-card e-card--pad"><div class="e-cluster e-cluster--between e-cluster--top"><div class="e-cluster e-cluster--lg e-cluster--top"><div class="e-stat"><span class="e-stat__label">Plan</span><span class="e-stat__value">Pro</span></div>'
           '<div class="e-stat"><span class="e-stat__label">Credits left this month</span><span class="e-stat__value">112</span></div></div>' + btn('See plans') + '</div></div>')
body += sec('Static, media and summary', grid(cell('Static: a bounded group', static, True), cell('Summary: a few labelled numbers', summary, True), cell('Media: image, caption and actions', mediac, True), cls='pv-grid--wide'))
write('Card', 'Data', body, '''
# Card

A bounded object on the page. You provide the content; for an interactive card, the one destination it links to.

- A card is for a thing: a project, an asset, a plan, a choice. Page sections (Settings groups, form sections) are **not** cards; they sit on the canvas under a heading.
- **Static**: a bounded group of content. No states.
- **Interactive**: the whole card is one link (a project). Hover is a stronger hairline, never a lift; pressed scales to 0.97; focus draws the two-part ring around the card. Other controls on it (the options button) sit above the link.
- **Media**: an image in a Media frame with a caption and actions.
- **Summary**: a few labelled numbers (plan and credits), with tabular figures.
- Paper on canvas with a `color-border` hairline, `radius-card`, no shadow. Padding `space-card`.
- Loading is a skeleton in the card's exact shape, so nothing moves when content arrives.
- A long name truncates on one line and shows in full in a tooltip. Dates show a formatted date in a tooltip, never a raw timestamp.
''', height=1300)

# ---------------------------------------------------------------- Navigation
def nav(current='Projects', signed=True, f_item=None, loading=False):
    def item(label, icon):
        cur = ' aria-current="page"' if label == current else ''
        fo = force(f_item[1]) if f_item and f_item[0] == label else ''
        return f'<a class="e-nav__item" href="#"{cur}{fo}>{ic(icon, "e-nav__icon")}<span class="e-nav__label">{label}</span></a>'
    acct = ('<span class="e-nav__account"><span class="e-skeleton e-skeleton--circle"></span></span>' if loading else
            '<span class="e-nav__account"><button type="button" class="e-avatar" aria-label="Account" aria-haspopup="menu">A</button></span>' if signed else
            '<a class="e-nav__item e-nav__item--keep-label" href="#"><span class="e-nav__label">Sign in</span></a><a class="e-button e-button--primary e-button--sm" href="#">Create account</a>')
    return ('<nav class="e-nav" aria-label="Main"><a class="e-nav__brand" href="#" translate="no"><span class="e-mark"></span><span class="e-nav__label">Embel</span></a><span class="e-nav__sep"></span>'
            + item('Home', 'house') + item('Projects', 'folder') + item('Library', 'library') + '<span class="e-nav__sep"></span>' + acct + '</nav>')
def step(label, n, state, f=''):
    if state == 'complete': m = f'<span class="e-step__mark">{ic("check")}</span>'; a = ' data-state="complete"'
    elif state == 'current': m = '<span class="e-step__mark"></span>'; a = ' aria-current="step"'
    else: m = f'<span class="e-step__mark">{n}</span>'; a = ' aria-disabled="true"'
    sr = {'complete': ', complete', 'current': ', current step', 'todo': ', not reached yet'}[state]
    return f'<a class="e-step" href="#"{a}{force(f)}>{m}<span>{label}<span class="e-sr">{sr}</span></span></a>'
def pbar(name, states, current, saved='Saved'):
    steps = ''.join(step(l, i + 1, s) for i, (l, s) in enumerate(zip(['Strategy', 'Voice', 'Identity', 'Assets'], states)))
    n = states.index('current') + 1
    return ('<nav class="e-nav" aria-label="Project"><a class="e-nav__brand" href="#" aria-label="Embel home"><span class="e-mark"></span></a>'
            f'<button type="button" class="e-nav__item e-nav__item--keep-label e-nav__project" aria-haspopup="menu"><span class="e-nav__label" translate="no">{name}</span>{ic("chevron-down", "e-icon--sm")}</button><span class="e-nav__sep"></span>'
            f'<span class="e-steps" role="list">{steps}</span>'
            f'<button type="button" class="e-nav__item e-nav__item--keep-label e-steps-compact" aria-haspopup="menu"><span class="e-nav__label">{current}<span class="e-nav__extra"> · {n} of 4</span></span>{ic("chevron-down", "e-icon--sm")}</button>'
            f'<span class="e-nav__sep"></span><span class="e-nav__status" role="status">{ic("check")}<span>{saved}</span></span><span class="e-nav__account"><button type="button" class="e-avatar" aria-label="Account" aria-haspopup="menu">A</button></span></nav>')
body = sec('App navigation', grid(cell('Signed in', nav()), cell('Signed out', nav('Home', signed=False)), cell('Checking the session: the account area keeps its width', nav(loading=True)), cls='pv-grid--one'),
           note='A floating pill, 56 px tall, 16 px from the top. Below 640 px the destinations become icons and keep their names for assistive technology.')
body += sec('Item states', grid(cell('Default', nav('')), cell('Hover on Home', nav('', f_item=('Home', 'hover'))), cell('Focus-visible on Home', nav('', f_item=('Home', 'focus'))), cell('Active on Home', nav('', f_item=('Home', 'active'))), cell('Selected: the current page', nav('Library')), cls='pv-grid--one'))
body += sec('Project bar', grid(cell('Complete, current and not-reached steps', pbar('Tidewater Kayak Tours', ['complete', 'complete', 'current', 'todo'], 'Identity')),
                                cell('All four steps', pbar('Kestrel Analytics', ['complete', 'complete', 'complete', 'current'], 'Assets')),
                                cell('Step states', '<span class="e-steps">' + step('Strategy', 1, 'complete') + step('Strategy', 1, 'complete', 'hover') + step('Voice', 2, 'complete', 'focus') + step('Identity', 3, 'current') + step('Assets', 4, 'todo') + '</span>'), cls='pv-grid--one'),
            note='Below 1024 px the four steps collapse into one menu button that names the current step, so step names are always reachable.')
write('Navigation', 'Navigation', body, '''
# Navigation: floating pill and project bar

The app's two bars. You provide the current destination, or the project and the state of its four steps.

- **App navigation**: the Embel mark and wordmark, the three destinations (Home, Projects, Library) and the account button. Signed out, the account area holds "Sign in" and "Create account".
- **Project bar**: the mark (home), the project switcher, the four journey steps (Strategy, Voice, Identity, Assets) and the save status.
- 56 px tall (`nav-height`), `radius-pill`, `shadow-raised`, `z-nav`, 16 px from the top (`nav-offset`).
- Item states: default, hover, focus-visible, active, selected (`aria-current`: ink fill), disabled. Steps add complete (a filled tick) and not reached (a number, `aria-disabled`).
- Loading: while the session is checked, the account area holds a skeleton of the same width, so the pill does not change size.
- Compact: destinations become icons that keep their accessible names. Below 1024 px the steps collapse into one menu button ("Identity · 3 of 4") that opens a Menu of the four steps.
- "Saved" appears only after the server confirms.
''', height=1150, width=1200)

# ---------------------------------------------------------------- Tabs and segmented control
def tabs(sel=0, f=None, labels=('Account', 'Usage'), disabled=None):
    out = ''
    for i, l in enumerate(labels):
        fo = force(f[1]) if f and f[0] == i else ''
        out += f'<button type="button" class="e-tab" role="tab" aria-selected="{"true" if i == sel else "false"}"{fo}{" disabled" if disabled == i else ""}>{l}</button>'
    return f'<div class="e-tabs" role="tablist" aria-label="Settings sections">{out}</div>'
def seg(sel=0, f=None, disabled=None):
    out = ''
    for i, l in enumerate(['Brands', 'Logos', 'Colors', 'Typefaces', 'Socials', 'Visuals']):
        fo = force(f[1]) if f and f[0] == i else ''
        out += f'<button type="button" class="e-segmented__item" role="tab" aria-selected="{"true" if i == sel else "false"}"{fo}{" disabled" if disabled == i else ""}>{l}</button>'
    return f'<div class="e-segmented" role="tablist" aria-label="Gallery category">{out}</div>'
body = sec('Underline tabs: page sections', grid(cell('Selected: Account', tabs(), True), cell('Hover on Usage', tabs(f=(1, 'hover')), True), cell('Focus-visible on Usage', tabs(f=(1, 'focus')), True),
                                                cell('Active on Usage', tabs(f=(1, 'active')), True), cell('Disabled', tabs(labels=('Kept assets', 'All generations'), disabled=1), True), cls='pv-grid--wide'),
           note='One tab stop; arrow keys move between tabs and select. Try it with the keyboard.')
body += sec('Segmented control: switching a view in place', grid(cell('Selected: Brands', seg()), cell('Hover on Logos', seg(f=(1, 'hover'))), cell('Focus-visible on Logos', seg(f=(1, 'focus'))), cell('Active on Logos', seg(f=(1, 'active'))), cell('Disabled: Visuals', seg(disabled=5)), cls='pv-grid--wide'))
write('Tabs', 'Navigation', body, '''
# Tabs and segmented control

Switching between views of one page. You provide the labels and which one is selected.

- **Underline tabs**: sections of a page (Settings: Account, Usage; Library: Kept assets, All generations). The selected tab is ink with a 2 px ink underline; the others are muted and gain a grey underline on hover.
- **Segmented control**: switching a view in place (gallery categories, name availability). The selected segment is an ink pill with white text.
- 44 px tall. One tab stop; arrow keys move and select; each tab controls a labelled panel (`role="tablist"`, `tab`, `tabpanel`).
- Tabs do not animate.
''', height=640)

# ---------------------------------------------------------------- Badge and chip
def chip(label, f='', attrs='', extra=''):
    return f'<button type="button" class="e-chip {extra}"{force(f)}{attrs}>{ic("check", "e-chip__check")}{label}</button>'
body = sec('Badge: not interactive', grid(cell('Neutral', '<span class="e-badge">No logo yet</span>'), cell('Neutral', '<span class="e-badge">Current plan</span>'), cell('Positive', '<span class="e-badge e-badge--positive">' + ic('check') + 'Complete</span>'),
                                         cell('Warning', '<span class="e-badge e-badge--warning">' + ic('triangle-alert') + 'Out of date</span>'), cell('Danger', '<span class="e-badge e-badge--danger">' + ic('circle-alert') + 'Failed</span>'), cell('Counter', '<span class="e-cluster">Liked <span class="e-counter">2</span></span>')),
           note='24 px tall. A status badge carries an icon or a word as well as its colour.')
body += sec('Chip: interactive', grid(cell('Default', chip('A neighborhood coffee shop')), cell('Hover', chip('A neighborhood coffee shop', 'hover')), cell('Focus-visible', chip('A neighborhood coffee shop', 'focus')), cell('Active', chip('A neighborhood coffee shop', 'active')),
                                    cell('Selected', chip('Adventurous and welcoming', attrs=' aria-pressed="true"')), cell('Disabled', chip('A skincare studio', attrs=' disabled')),
                                    cell('Removable', '<span class="e-chip e-chip--static">brief.pdf<button type="button" class="e-icon-button e-icon-button--quiet e-icon-button--sm" aria-label="Remove brief.pdf" style="margin-right:calc(var(--space-3)*-1)">' + ic('x') + '</button></span>'), cls='pv-grid--wide'),
            note='36 px tall inside a 44 px target. Selected adds a tick and an ink edge.')
write('Badge', 'Data', body, '''
# Badge and chip

Small labels. A badge states something; a chip does something. You provide the words and, for a badge, the tone.

- **Badge** (static, 24 px): status in neutral, positive, warning or danger; "Current plan", "No logo yet", "Complete". Tone badges always carry an icon or a clear word.
- **Chip** (interactive, 36 px in a 44 px target): a starter prompt, a filter, a removable item. Selected (`aria-pressed`) adds a tick and an ink edge on `color-bg-selected`.
- **Counter**: a small tabular number beside a label.
- Both are pills, which is what tells them apart from buttons.
''', height=560)

# ---------------------------------------------------------------- Avatar
body = sec('Avatar', grid(cell('Initials, 32 px', '<span class="e-avatar">A</span>'), cell('Initials, 40 px', '<span class="e-avatar e-avatar--md">A</span>'),
                          cell('Image, when one exists', '<span class="e-avatar e-avatar--md"><img src="{{img:kestrel-logo-2}}" alt=""></span>'),
                          cell('As the account button', '<button type="button" class="e-avatar" aria-label="Account">A</button>'), cell('Hover', '<button type="button" class="e-avatar" aria-label="Account" data-force="hover">A</button>'),
                          cell('Focus-visible', '<button type="button" class="e-avatar" aria-label="Account" data-force="focus">A</button>')))
write('Avatar', 'Data', body, '''
# Avatar

A person, shown as initials or an image. You provide the name (for the initial and the accessible name) and an image when one exists.

- 32 px in the navigation, 40 px in lists and menus. Initials in `text-label` on `color-bg-sunken`.
- As the account button it is a real button named "Account" and takes hover, focus-visible and active states.
''', height=220)

# ---------------------------------------------------------------- Empty state
page = ('<div class="e-empty"><span class="e-empty__visual">' + ic('images') + '</span><h3 class="e-empty__title">No kept assets yet</h3>'
        '<p class="e-empty__text">Like or save an asset to bring it here. Assets used in a brand appear here too.</p><div class="e-empty__action"><a class="e-button e-button--primary" href="#">Browse all generations' + ic('arrow-right') + '</a></div></div>')
nores = ('<div class="e-empty e-empty--results"><span class="e-empty__visual">' + ic('search') + '</span><h3 class="e-empty__title">No projects match “kestrl”</h3>'
         '<p class="e-empty__text">Check the spelling, or clear the search to see all eight projects.</p><div class="e-empty__action">' + btn('Clear search') + '</div></div>')
section = '<div class="e-card e-card--pad"><p class="e-empty e-empty--section">No recent brands yet. <a class="e-link" href="#">Start with an idea</a>.</p></div>'
body = sec('Page', page, note='One icon in a 56 px circle, a title that says what will appear here, one sentence, and the one action that fills the page. Never a dashed box.')
body += sec('No results', nores)
body += sec('Section: inside a card', section)
write('EmptyState', 'Feedback', body, '''
# Empty state

What a page or section shows when it has nothing yet. You provide the title, one sentence and the one action that fills it.

- **Page**: the visual slot (one 24 px icon in a 56 px circle, the same everywhere), a title that says what will appear here, one sentence, and one primary action. It sits directly on the canvas with generous space (`space-16`).
- **No results**: names what was searched and offers to clear the search.
- **Section**: inside a card, a single sentence with a link.
- Page errors (404, a crash, an unavailable project) use the page layout with the danger visual.
- No illustration, no dashed border, and never instructions for an empty page while saved work is still loading.
''', height=980)

# ---------------------------------------------------------------- Skeleton
body = sec('Shapes', grid(cell('Text lines', '<div class="e-stack e-stack--sm"><span class="e-skeleton e-skeleton--title e-skeleton--w40"></span><span class="e-skeleton e-skeleton--line e-skeleton--w80"></span><span class="e-skeleton e-skeleton--line e-skeleton--w60"></span></div>', True),
                          cell('Block: a field or button', '<span class="e-skeleton e-skeleton--block"></span>', True), cell('Image frame, at the final ratio', '<span class="e-media" data-state="loading"></span>', True), cell('Card, in the real card’s shape', skel, True), cls='pv-grid--wide'),
           note='A 1.6 s opacity pulse from 1 to 0.55. Under reduced motion the pulse stays, because it moves nothing.')
write('Skeleton', 'Feedback', body, '''
# Skeleton

A placeholder in the exact shape and size of content that is loading. You provide the shape.

- Shapes: text line, title line, block, circle, image frame (a Media frame in its loading state) and card.
- Fill `color-bg-skeleton`, with a 1.6 s opacity pulse (`duration-loop-pulse`). The pulse is kept under reduced motion.
- A skeleton always matches the final layout, so nothing moves when content arrives. It is hidden from assistive technology; the region announces "Loading" once.
- Use it for content with a known shape. For an action the person just took use the button spinner; for AI work use the progress bar.
''', height=560)

# ---------------------------------------------------------------- Spinner, progress bar, thinking indicator
def prog(state, text, action=''):
    return f'<div class="e-progress" data-state="{state}" role="status"><div class="e-progress__row"><p class="e-progress__status">{text}</p>{action}</div><div class="e-progress__track"></div></div>'
body = sec('Spinner: inside a pressed button', grid(cell('16 px', '<span class="e-spinner"></span>'), cell('20 px', '<span class="e-spinner e-spinner--md"></span>'),
                                                   cell('In a button', f'<button type="button" class="e-button e-button--primary" aria-busy="true" aria-disabled="true">{SP}Save changes</button>')))
body += sec('Progress bar: AI work, with one sentence and a stop control', grid(
    cell('Running', prog('running', 'Drawing six logo concepts for Tidewater Kayak Tours…', btn(ic('square') + 'Stop', extra='e-button--sm')), True),
    cell('Stopping', prog('stopping', 'Stopping…', f'<button type="button" class="e-button e-button--secondary e-button--sm" aria-busy="true" aria-disabled="true">{SP}Stop</button>'), True),
    cell('Done', prog('done', 'Six concepts are ready.'), True),
    cell('Failed', prog('failed', 'The concepts couldn’t be drawn. Nothing was charged.', btn(ic('rotate-ccw') + 'Try again', extra='e-button--sm')), True), cls='pv-grid--wide'),
    note='No percentages and no invented progress. Under reduced motion the bar is a static filled track with its sentence.')
body += sec('Thinking indicator: the assistant is composing', '<span class="e-thinking" role="status"><span class="e-mark"></span>Thinking…</span>')
write('Progress', 'Feedback', body, '''
# Spinner, progress bar, thinking indicator

The three ways Embel shows work in progress. You provide the status sentence.

- **Spinner** (16 or 20 px): inside the button that was pressed, within 100 ms. The label stays.
- **Progress bar** (4 px): AI work that takes seconds or minutes. It sits where the result will appear, with one plain sentence and a Stop control. States: running, stopping, done, failed. It shows no percentage.
- **Thinking indicator**: the Embel mark pulsing beside "Thinking…" while the assistant composes a reply.
- Loops: spin 0.8 s, sweep 2.4 s, pulse 1.6 s. Under reduced motion the spinner pulses instead of turning and the bar is a static filled track; the sentence carries the status.
''', height=760)

# ---------------------------------------------------------------- Tooltip
tip = lambda inner, text, forced=True: f'<span class="e-tooltip-host">{inner}<span class="e-tooltip" role="tooltip"{" data-force=\'open\'" if forced else ""}>{text}</span></span>'
body = sec('Uses', '<div class="pv-row" style="padding-top:var(--space-10);gap:var(--space-16)">'
           + tip(ib('maximize-2', 'outlined', 'Enlarge'), 'Enlarge') + tip('<span class="e-card__title" tabindex="0" style="max-width:220px" translate="no">Northern Lights Community Physiotherapy and Sports Rehabilitation Collective</span>', 'Northern Lights Community Physiotherapy and Sports Rehabilitation Collective')
           + tip('<span class="e-card__meta" tabindex="0">Today</span>', 'Nov 12, 2026 at 9:41 AM') + '</div>',
           note='The name of an icon-only control; the full value of truncated text; a formatted date for a relative time. It appears after 500 ms on hover and at once on keyboard focus. It never holds essential information.')
body += sec('Try it', '<div class="pv-row" style="padding-top:var(--space-10)">' + tip(ib('copy', 'outlined', 'Copy'), 'Copy', False) + tip(ib('download', 'outlined', 'Download'), 'Download', False) + '</div>')
write('Tooltip', 'Overlays', body, '''
# Tooltip

A short label that appears beside a control. You provide the text.

- Uses: the name of an icon-only control, the full value of truncated text, and a formatted date for a relative time ("Today").
- One size. Ink fill, white `text-small`, `radius-small`, `z-popover`.
- Appears after `tooltip-delay` (500 ms) on hover and at once on keyboard focus; hides on Escape.
- Never the only place for information the person needs, and never a raw machine timestamp.
''', height=420)

# ---------------------------------------------------------------- Disclosure
def disc(summary, content, open_=False, f='', cls=''):
    return f'<details class="e-disclosure {cls}"{" open" if open_ else ""}><summary{force(f)}>{ic("chevron-right", "e-disclosure__chevron")}{summary}</summary><div class="e-disclosure__content">{content}</div></details>'
ans = ('<details class="e-disclosure e-answer"><summary>' + ic('chevron-right', 'e-disclosure__chevron') + '<span class="e-answer__question">Which personality feels right?</span><span class="e-badge">' + ic('check') + 'Adventurous and welcoming</span><span class="e-grow"></span>'
       + '</summary><div class="e-disclosure__content"><p class="e-muted">Outdoorsy, friendly and safe.</p><div>' + btn('Edit answer', extra='e-button--sm') + '</div></div></details>')
D = '<p class="e-muted e-measure">A ZIP with your profile, projects, Strategy, Voice and Identity work, and the files you generated or uploaded.</p>'
body = sec('States', grid(cell('Closed', disc('What’s in the download', D), True), cell('Hover', disc('What’s in the download', D, f='hover'), True), cell('Focus-visible', disc('What’s in the download', D, f='focus'), True), cell('Expanded', disc('What’s in the download', D, True), True), cls='pv-grid--wide'))
body += sec('Folded answer in the conversation', ans, note='A finished question folds to one line. Its controls leave the keyboard order until it is reopened.')
write('Disclosure', 'Navigation', body, '''
# Disclosure

Content that folds away under a one-line summary. You provide the summary and the content.

- Uses: a folded answer in the conversation, and "more details" inside a card.
- A native `<details>` element. The summary row is 44 px with a chevron that turns when open.
- States: default, hover, focus-visible, expanded. Opening does not animate.
- **Folded answer**: the question in muted text, the chosen answer as a badge, and inside it the description and an "Edit answer" button. Folded content is out of the keyboard order until reopened.
''', height=520)

# ---------------------------------------------------------------- Media frame
def mf(ratio, inner='', state='', cls=''):
    return f'<div class="e-media {ratio} {cls}"{f" data-state=\'{state}\'" if state else ""}>{inner}</div>'
failed = '<div class="e-stack e-stack--sm">' + mf('', ic('image-off', 'e-icon--lg') + '<span>This image couldn’t be loaded.</span>', 'failed') + '<div>' + btn(ic('rotate-ccw') + 'Try again', extra='e-button--sm') + '</div></div>'
body = sec('States', grid(cell('Loading: a skeleton at the final size', mf('', state='loading'), True), cell('Loaded: fades in over 200 ms', mf('', '<img src="{{img:kestrel-direction-1}}" alt="Direction board for Kestrel Analytics">'), True),
                          cell('Failed: message inside, retry beside it', failed, True), cell('Private or expired', mf('', ic('lock', 'e-icon--lg') + '<span>This preview is private. Sign in to see it.</span>', 'private'), True)),
           note='The frame reserves its space before the image arrives, so the page never moves.')
body += sec('Ratios', grid(cell('1:1: logos', mf('', '<img src="{{img:kestrel-logo-6}}" alt="Kestrel Analytics emblem logo">', cls='e-media--contain'), True), cell('4:5: direction boards in a grid', mf('e-media--4x5', '<img src="{{img:kestrel-direction-2}}" alt="Direction board: night operations">'), True),
                           cell('16:9: banners and large views', mf('e-media--16x9', '<img src="{{img:kestrel-direction-3}}" alt="Direction board: confident enterprise">'), True), cell('8:11: the brand board', mf('e-media--8x11', state='loading'), True)))
write('MediaFrame', 'Data', body, '''
# Media frame

A box with a fixed aspect ratio that holds a generated or uploaded image. You provide the ratio, the image and its alt text.

- Ratios: 1:1 (logos), 4:5 (direction boards in a grid), 16:9 (banners, large views), 8:11 (the brand board).
- States: **loading** (a skeleton at the final size), **loaded** (the image fades in over `duration-base`), **failed** (an icon and one sentence inside; the retry Button sits beside the frame, never inside another button), **private or expired** (one wording: "This preview is private.").
- Logos use contain on paper so their own background is kept; boards and photos use cover.
- Every generated image sits in a Media frame. A generated brand's colours appear only inside frames like this, never as interface chrome.
- Controls drawn on the image sit on a paper chip (Icon button, on-artwork).
''', height=1050)

# ---------------------------------------------------------------- Icon
import build
names = build.ICONS
tiles = ''.join(f'<div class="pv-cell" style="justify-items:center;text-align:center">{ic(n)}<span class="pv-label">{n}</span></div>' for n in names)
body = sec('Sizes', grid(cell('16 px: in buttons, badges, meta lines', ic('download', 'e-icon--sm')), cell('20 px: the default', ic('download')), cell('24 px: empty states and banners', ic('download', 'e-icon--lg')), cell('Muted, beside secondary text', ic('clock', 'e-icon--muted')),
                         cell('The Embel mark', '<span class="e-mark"></span>'), cls='pv-grid--wide'))
body += sec('The set', f'<div class="pv-grid pv-grid--narrow" style="--pv-min:96px">{tiles}</div>', note='Lucide, drawn on a 24 px grid at a 1.5 line. Icons take the colour of the text they sit in.')
write('Icon', 'Foundations', body, '''
# Icon

One icon family through one component. You provide the icon's name; if the icon stands alone as a control, also an accessible name on the control.

- Family: **Lucide** (ISC licence), on a 24 px grid at one stroke weight, 1.5.
- Sizes: 16 px (`icon-sm`, inside buttons, badges and meta lines), 20 px (`icon-md`, the default), 24 px (`icon-lg`, empty states and banners).
- An icon takes the text colour (`color-icon`); beside secondary text it is `color-icon-muted`. Icons that carry meaning or act as controls hold at least 3:1.
- Decorative icons are hidden from assistive technology. An icon is never the only label of a status.
- Arrows only on controls that navigate. No emoji, no image-file icons, no second stroke weight.
- The Embel mark is a single-ink shape; set it in `color-text`, and at 24 px or larger.
''', height=900)
