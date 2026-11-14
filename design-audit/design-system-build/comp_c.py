from pv import *
SP = '<span class="e-spinner" aria-hidden="true"></span>'
def btn(label, kind='secondary', extra='', attrs=''):
    return f'<button type="button" class="e-button e-button--{kind} {extra}"{attrs}>{label}</button>'
def ib(icon, kind='quiet', label='Close', extra='e-icon-button--sm', attrs=''):
    return f'<button type="button" class="e-icon-button e-icon-button--{kind} {extra}" aria-label="{label}"{attrs}>{ic(icon)}</button>'
def turn(meta, *html, settled=True):
    return (f'<article class="e-turn{" e-turn--settled" if settled else ""}"><span class="e-turn__avatar" aria-hidden="true"><span class="e-mark"></span></span>'
            f'<div class="e-turn__main"><p class="e-turn__meta">{meta}</p>' + ''.join(html) + '</div></article>')
def user(text):
    return f'<article class="e-turn e-turn--user e-turn--settled"><span class="e-sr">You said</span><div class="e-turn__bubble"><p>{text}</p>{ib("pencil", "quiet", "Edit your brief")}</div></article>'
def answer(q, a, desc='', edit='Edit answer'):
    return ('<details class="e-disclosure e-answer"><summary>' + ic('chevron-right', 'e-disclosure__chevron') + f'<span class="e-answer__question">{q}</span><span class="e-badge">{ic("check")}{a}</span></summary>'
            f'<div class="e-disclosure__content">{f"<p class=\'e-muted\'>{desc}</p>" if desc else ""}<div>{btn(edit, extra="e-button--sm")}</div></div></details>')
def prog(state, text, action=''):
    return f'<div class="e-progress" data-state="{state}" role="status"><div class="e-progress__row"><p class="e-progress__status">{text}</p>{action}</div><div class="e-progress__track"></div></div>'
def msg(tone, icon, text, title='', form='block', actions=''):
    t = f'<p class="e-message__title">{title}</p>' if title else ''
    a = f'<div class="e-message__actions">{actions}</div>' if actions else ''
    return f'<div class="e-message e-message--{form} e-message--{tone}" role="{"alert" if tone in ("danger", "warning") else "status"}">{ic(icon)}<div class="e-message__body">{t}<p>{text}</p>{a}</div></div>'
OOC = msg('neutral', 'info', 'Your work is saved. Credits renew on December 1, or a paid plan adds more every month.', 'You’re out of credits for this month', actions=btn('Not now', 'quiet', 'e-button--sm') + '<a class="e-button e-button--primary e-button--sm" href="#">See plans' + ic('arrow-right') + '</a>')

# ---------------------------------------------------------------- Conversation
strategy = ('<section class="e-card e-card--pad e-stack"><div class="e-step-header"><span class="e-step__mark e-step__mark--complete">' + ic('check', 'e-icon--sm') + '</span>'
            '<h3 class="e-step-header__title">Strategy</h3><span class="e-badge e-badge--positive">Complete</span><span class="e-grow"></span>' + btn('Edit strategy', extra='e-button--sm') + '</div>'
            '<dl class="e-grid-cards"><div class="e-stack e-stack--sm"><dt class="e-section__hint">Competitors</dt><dd class="e-cluster"><span class="e-badge">Pacific Paddle Co</span><span class="e-badge">Clayoquot Kayaks</span></dd></div>'
            '<div class="e-stack e-stack--sm"><dt class="e-section__hint">Audience</dt><dd>Families on vacation</dd></div>'
            '<div class="e-stack e-stack--sm"><dt class="e-section__hint">Positioning</dt><dd><strong class="e-card__title" style="white-space:normal">Your first paddle, done right</strong><br><span class="e-muted">Patient guides for beginners.</span></dd></div></dl></section>')
body = sec('Messages', '<div class="e-stack e-stack--lg">'
           + user('Guided sea kayak tours and sunset paddles around the islands of Tofino, British Columbia, for beginners and families, with gear rental and small groups of eight.')
           + turn('Embel · Personality · 1 of 3', '<p class="e-turn__text">Three personality directions.</p>', answer('Which personality feels right?', 'Adventurous and welcoming', 'Outdoorsy, friendly and safe.'))
           + turn('Embel · Logo · 2 of 3', '<span class="e-thinking" role="status"><span class="e-mark"></span>Thinking…</span>', settled=False) + '</div>',
           note='The person’s answer is a paper card on the right. Embel’s text sits directly on the canvas beside its mark. A finished question folds to one line. New content enters with a 4 px rise; saved content does not replay it.')
body += sec('Journey step header and summary', strategy)
write('Conversation', 'Embel', body, '''
# Conversation message and step header

The pieces of the project conversation, assembled from Card, Badge, Disclosure, Icon button and the thinking indicator.

- **Assistant turn**: the Embel mark in an ink circle, a meta line ("Embel · Logo · 2 of 3") and text on the canvas, capped at `measure`.
- **The person's answer**: a paper card aligned right, with an edit Icon button.
- **Folded answer**: a Disclosure showing the question and the chosen answer as a badge. Finished steps fold, so their controls leave the keyboard order.
- **Step header**: the step name (`text-title-md`), a "Complete" badge and one edit action, above a summary of what was decided.
- Only content added after the page has loaded enters with `enter-shift`; saved sections do not replay it.
- This is the reading container: 792 px (`container-reading`).
''', height=900)

# ---------------------------------------------------------------- Generation panel
body = sec('States', grid(
    cell('Running', '<div class="e-card e-card--pad">' + prog('running', 'Drawing six logo concepts for Tidewater Kayak Tours. This usually takes about a minute.', btn(ic('square') + 'Stop', extra='e-button--sm')) + '</div>', True),
    cell('Stopping', '<div class="e-card e-card--pad">' + prog('stopping', 'Stopping. Concepts already drawn are kept.', f'<button type="button" class="e-button e-button--secondary e-button--sm" aria-busy="true" aria-disabled="true">{SP}Stop</button>') + '</div>', True),
    cell('Failed', '<div class="e-card e-card--pad e-stack">' + prog('failed', 'Drawing stopped before it finished.') + msg('danger', 'circle-alert', 'Two of the six concepts couldn’t be drawn. The other four are ready, and nothing was charged for the two that failed.', actions=btn(ic('rotate-ccw') + 'Retry 2 failed concepts', extra='e-button--sm')) + '</div>', True), cls='pv-grid--wide'),
           note='The panel sits where the result will appear and is the same size as the result, so nothing moves when it arrives.')
write('GenerationPanel', 'Embel', body, '''
# Generation panel

What the person sees while AI work runs. Assembled from Card, the progress bar, Button and Inline message.

- One plain sentence that names the work, and a Stop control. No percentages, no cost estimates.
- It occupies the place and size of the result, so the page does not shift when the result arrives.
- A failure is a danger Inline message in the same place, with the recovery action as a button ("Retry 2 failed concepts").
- Finished results fade in over `duration-slow`, 40 ms apart (`stagger`).
''', height=560)

# ---------------------------------------------------------------- Out of credits
ctx = ('<div class="e-stack"><div class="e-cluster">' + btn('Explore six concepts', 'primary') + '</div>' + OOC + '</div>')
body = sec('At the control that was pressed', ctx, note='One message, in place, with two actions. It replaces a floating card, a line of text and a “Try again” button that all said the same thing. Escape dismisses it.')
write('OutOfCredits', 'Embel', body, '''
# Out-of-credits message

What appears when an action needs more credits than the person has. A neutral block Inline message with two actions.

- It appears at the control that was pressed, not as a floating card, and it is the only message about credits on the screen.
- It says the work is saved, when credits renew, and offers "See plans" (primary, goes to Plans) and "Not now" (quiet, dismisses).
- Embel shows credits, never money, outside the Plans page.
''', height=320)

# ---------------------------------------------------------------- Plan card and credit balance
def plan(name, price, credits, current=False):
    b = '<span class="e-badge">Current plan</span>' if current else ''
    a = btn('Current plan', attrs=' disabled', extra='e-button--block') if current else btn(f'Choose {name}', 'primary' if name == 'Studio' else 'secondary', 'e-button--block')
    return (f'<article class="e-card e-card--pad e-plan"{" data-selected" if current else ""}><div class="e-cluster e-cluster--between"><h3 class="e-card__title">{name}</h3>{b}</div>'
            f'<p class="e-plan__price">{price} <small>USD a month</small></p><ul class="e-list-check"><li>{ic("check")}<span><strong class="e-strong e-tabular">{credits}</strong> credits every month</span></li></ul>{a}</article>')
balance = ('<div class="e-card e-card--pad"><div class="e-cluster e-cluster--between e-cluster--top"><div class="e-cluster e-cluster--lg e-cluster--top"><div class="e-stat"><span class="e-stat__label">Plan</span><span class="e-stat__value">Pro</span></div>'
           '<div class="e-stat"><span class="e-stat__label">Credits left this month</span><span class="e-stat__value">112</span></div></div><a class="e-button e-button--secondary" href="#">See plans' + ic('arrow-right') + '</a></div></div>')
menu_bal = '<div class="e-menu" role="menu" aria-label="Account" style="animation:none"><span class="e-menu__label">Pro plan · <span class="e-tabular">112</span> credits left</span><button class="e-menu__item" role="menuitem">' + ic('settings') + 'Settings</button><button class="e-menu__item" role="menuitem">' + ic('credit-card') + 'Plans</button></div>'
body = sec('Plan cards', '<div class="e-grid-cards">' + plan('Free', '$0', 30) + plan('Pro', '$7.99', 150, True) + plan('Studio', '$27.99', 500) + '</div>', note='A plan is an object, so it is a card. The current plan carries the selected ring and a badge.')
body += sec('Credit balance', grid(cell('Summary card, on Settings', balance, True), cell('In the account menu', menu_bal), cls='pv-grid--wide'))
write('PlanAndCredits', 'Embel', body, '''
# Plan card and credit balance

How plans and credits are shown. Assembled from Card (summary), Badge, Button and Menu.

- **Plan card**: the plan name, its monthly price (the only money shown in the app), its monthly credits, and one action. The current plan has the selected ring and a "Current plan" badge.
- **Credit balance**: a summary Card with the plan and the credits left this month, in tabular figures; and one line at the top of the account menu, so the balance is visible before it blocks.
- Prices and credits come from the product: Free $0 / 30, Pro $7.99 / 150, Studio $27.99 / 500.
''', height=640)

# ---------------------------------------------------------------- Colour swatch
def sw(name, hexv):
    return (f'<div class="e-swatch"><span class="e-swatch__color" style="--swatch:{hexv}"></span><span class="e-swatch__text"><span class="e-swatch__name">{name}</span><span class="e-swatch__value">{hexv}</span></span>'
            f'<span class="e-tooltip-host">{ib("copy", "quiet", f"Copy {hexv}", attrs=" data-copy=\'" + hexv + "\'")}<span class="e-tooltip" role="tooltip">Copy</span></span></div>')
PAL = [('Primary', '#0F2A3D'), ('Accent', '#F2A541'), ('Background', '#FBF9F4'), ('Text', '#141414')]
body = sec('Kestrel Analytics, direction 1', '<div class="e-grid-cards">' + ''.join(sw(n, h) for n, h in PAL) + '</div>', note='A generated brand’s colour appears only inside a bounded swatch with a hairline, never as interface chrome. Copy confirms with a toast.')
write('ColorSwatch', 'Embel', body, '''
# Colour swatch with copy

One colour of a generated brand, with its name, its value and a copy action. Assembled from Icon button, Tooltip and Toast.

- The swatch is a bounded block with a hairline, so a pale colour is still visible on paper.
- The value is set in `text-code`. Copying confirms with a Toast ("Copied #0F2A3D").
- Brand colours stay inside swatches and Media frames. Any text the app sets on a brand colour picks black or white by calculated contrast.
''', height=300, script="document.addEventListener('click',function(e){var b=e.target.closest('[data-copy]');if(!b)return;var v=b.getAttribute('data-copy');try{navigator.clipboard.writeText(v).catch(function(){})}catch(x){}Embel.toast('Copied '+v)});")

# ---------------------------------------------------------------- Code block
CODE = '''/* Kestrel Analytics design tokens, from the chosen direction. */
:root {
  --color-primary: #0F2A3D;
  --color-accent: #F2A541;
  --color-background: #FBF9F4;
  --color-text: #141414;
  --font-heading: "Manrope", system-ui, sans-serif;
  --font-body: "Geist", system-ui, sans-serif;
}'''
body = sec('Exported tokens', '<div class="e-code"><pre tabindex="0" aria-label="design-tokens.css"><code>' + CODE.replace('<', '&lt;') + '</code></pre>' + ib('copy', 'quiet', 'Copy code', 'e-icon-button--sm', ' id="cc"') + '</div>')
write('CodeBlock', 'Embel', body, '''
# Code block

Exported token values the person can copy. Assembled from Icon button and Toast.

- `text-code` on `color-bg-sunken`, `radius-small`, with one copy button in the top corner.
- Long lines scroll inside the block; the page never scrolls sideways. The block is focusable so it can be scrolled by keyboard.
''', height=340, script="document.getElementById('cc').addEventListener('click',function(){Embel.toast('Copied')});")

# ================================================================ Patterns
rule = lambda t: f'<p class="pv-note">{t}</p>'
# Empty
page = ('<div class="e-empty"><span class="e-empty__visual">' + ic('folder') + '</span><h3 class="e-empty__title">No projects yet</h3><p class="e-empty__text">Each idea you describe becomes a project here, with its name, logo and brand kit.</p>'
        '<div class="e-empty__action"><a class="e-button e-button--primary" href="#">' + ic('plus') + 'New project</a></div></div>')
nores = ('<div class="e-empty e-empty--results"><span class="e-empty__visual">' + ic('search') + '</span><h3 class="e-empty__title">No projects match “kestrl”</h3><p class="e-empty__text">Check the spelling, or clear the search to see all eight projects.</p><div class="e-empty__action">' + btn('Clear search') + '</div></div>')
body = sec('An empty page', page, note='A visual slot, a title that says what will appear here, one sentence, and the one action that fills it.')
body += sec('A search with no match', nores, note='Name the search and offer to clear it.')
body += sec('Inside a card', '<div class="e-card e-card--pad"><p class="e-empty e-empty--section">Nothing in Deleted projects. <a class="e-link" href="#">Back to projects</a></p></div>', note='One sentence with a link. Never a dashed box, and never twice the same action.')
write('PatternEmpty', 'Patterns', body, '''
# Pattern: empty

- One Empty state per empty page: the visual slot, a title that says what will appear here, one sentence, and the one action that fills it.
- Inside a card: a single sentence with a link.
- A search with no match names the search and offers to clear it.
- Never a dashed box. Never show empty-state instructions while saved work is still loading; show a Skeleton.
''', height=900)

# Loading
skcard = ('<div class="e-card" aria-hidden="true"><div class="e-card__media"><span class="e-skeleton" style="position:absolute;inset:0;border-radius:0"></span></div><div class="e-card__body"><span class="e-skeleton e-skeleton--title e-skeleton--w60"></span><span class="e-skeleton e-skeleton--line e-skeleton--w40"></span></div></div>')
body = sec('1. Content loading: a skeleton in the final shape', '<div class="e-grid-cards" role="status" aria-label="Loading projects">' + skcard * 3 + '</div>')
body += sec('2. An action the person just took: a spinner in the pressed button', '<div class="pv-row">' + f'<button type="button" class="e-button e-button--primary" aria-busy="true" aria-disabled="true">{SP}Save changes</button>' + btn('Cancel') + '</div>', note='Within 100 ms, label kept, focus kept.')
body += sec('3. AI work: the progress bar, one sentence and a stop control', '<div class="e-card e-card--pad">' + prog('running', 'Drawing six logo concepts for Tidewater Kayak Tours. This usually takes about a minute.', btn(ic('square') + 'Stop', extra='e-button--sm')) + '</div>', note='In the place the result will appear.')
write('PatternLoading', 'Patterns', body, '''
# Pattern: loading

Three patterns and no others.

1. **Content loading**: a Skeleton in the final shape and size, so nothing moves when content arrives.
2. **An action the person just took**: a spinner inside the pressed button, label kept, within 100 ms.
3. **AI work that takes seconds or minutes**: the progress bar with one plain sentence and a stop control, in the place the result will appear.

A screen never shows instructions for an empty state while it is loading saved work. Images always sit in a Media frame that reserves their space.
''', height=760)

# Error
f_err = ('<div class="e-field pv-fit"><label class="e-field__label" for="pe1">Email address</label><div class="e-input"><input id="pe1" type="email" value="audit-free@example" aria-invalid="true" aria-describedby="pe1e"></div>'
         '<span class="e-message e-message--field e-message--danger" id="pe1e">' + ic('circle-alert') + '<span>Enter a full email address, like name@example.com.</span></span></div>')
s_err = msg('danger', 'circle-alert', 'Your projects couldn’t be loaded. Check your connection, then try again.', 'Projects didn’t load', actions=btn(ic('rotate-ccw') + 'Try again', extra='e-button--sm'))
p_err = ('<div class="e-empty"><span class="e-empty__visual e-empty__visual--danger">' + ic('circle-alert') + '</span><h3 class="e-empty__title">This page doesn’t exist</h3><p class="e-empty__text">The link may be old, or the project may have been deleted.</p><div class="e-empty__action"><a class="e-button e-button--primary" href="#">Go to Projects' + ic('arrow-right') + '</a></div></div>')
body = sec('Field error: under the field', f_err)
body += sec('Section error: replaces the content that failed, at the same size', s_err)
body += sec('Page error: the page empty-state layout with a danger icon', p_err)
write('PatternError', 'Patterns', body, '''
# Pattern: error

- Always an Inline message with an icon, what happened in the person's terms, and what to do next. The recovery action is a real button.
- Field errors sit under the field. Section errors replace the content that failed, at the same size. Page errors (404, crashes, an unavailable project) use the page Empty state layout with a danger icon.
- Errors are never toasts and never bare coloured text.
- Focus moves to the message or to the first field that needs attention.
''', height=900)

# Success feedback
body = sec('The change itself confirms', '<div class="e-grid-choices pv-fit" style="--pv-fit:520px"><article class="e-choice e-choice--image" data-selected><div class="e-media e-media--contain"><img src="{{img:kestrel-logo-1}}" alt="Kestrel Analytics logo, concept 1"></div><span class="e-choice__mark" aria-hidden="true"></span><div class="e-choice__foot"><span class="e-choice__title">Concept 1</span><button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="true">' + ic('check') + 'Chosen</button></div></article></div>', note='The tick appears; nothing else is needed.')
body += sec('The result is out of sight: a toast, with Undo when it can be reversed', '<div class="pv-row"><div class="e-toast e-on-inverse" style="animation:none"><span class="e-toast__text">Moved to Deleted projects</span><button type="button" class="e-toast__action">Undo</button><button type="button" class="e-toast__close" aria-label="Dismiss">' + ic('x', 'e-icon--sm') + '</button></div></div>')
body += sec('An outcome that matters after the moment: a positive message', msg('positive', 'circle-check', 'You’re on the Pro plan. 150 credits were added.', 'Payment confirmed'))
body += sec('Saved', '<div class="pv-row"><span class="e-nav__status" role="status">' + ic('check') + '<span>Saved</span></span></div>', note='Shown only after the server confirms.')
write('PatternSuccess', 'Patterns', body, '''
# Pattern: success feedback

- The change itself is the first confirmation: the tick appears, the item moves.
- Where the result is not visible where the person is looking (copied, downloaded, saved in the background, moved to Deleted), a Toast confirms it, with Undo when the action can be reversed.
- A positive Inline message is only for outcomes that matter after the moment, such as "Payment confirmed".
- "Saved" is shown only after the server confirms.
''', height=900)

# Form validation
form = ('<form class="e-stack e-stack--field pv-fit" novalidate onsubmit="return false">'
        '<div class="e-field"><label class="e-field__label" for="v1">Email address</label><div class="e-input"><input id="v1" type="email" value="audit-fresh@example.test" autocomplete="email"></div></div>'
        '<div class="e-field"><label class="e-field__label" for="v2">Password</label><div class="e-input"><input id="v2" type="password" value="correct-horse">' + ib('eye', 'quiet', 'Show password', attrs=' aria-pressed="false"') + '</div><span class="e-field__hint">At least 8 characters.</span></div>'
        '<div class="e-field"><label class="e-field__label" for="v3">Confirm password</label><div class="e-input"><input id="v3" type="password" value="correct-hors" aria-invalid="true" aria-describedby="v3e" data-force="focus-none">' + ib('eye', 'quiet', 'Show password', attrs=' aria-pressed="false"') + '</div>'
        '<span class="e-message e-message--field e-message--danger" id="v3e">' + ic('circle-alert') + '<span>The two passwords don’t match. Type the same password again.</span></span></div>'
        '<button type="submit" class="e-button e-button--primary e-button--block">Create account</button></form>')
body = sec('Create account, after pressing the button', form, note='Labels are always visible. The message sits under its field with an icon, the field takes the danger outline, and focus moves to the first invalid field. The button is not disabled to signal an incomplete form.')
write('PatternValidation', 'Patterns', body, '''
# Pattern: form validation

- Labels are always visible; placeholders give an example, never the label.
- Validate a field when the person leaves it, and all fields on submit.
- The message sits under its field in `color-text-danger` with an icon; the field takes `color-border-danger` and is linked to its message (`aria-describedby`, `aria-invalid`).
- On submit, focus moves to the first invalid field. The app's own messages replace the browser's validation bubble (`novalidate`).
- Buttons are not disabled to signal an incomplete form; they explain on press.
- Passwords are not cleared after a failed sign-in unless security requires it. Fields are not disabled while a request runs; the button shows loading and focus stays.
''', height=640)

# Destructive confirmation
def dlg(title, bodyhtml, footer, size='sm'):
    return (f'<div class="e-dialog e-dialog--{size}" data-static role="alertdialog" aria-modal="true" aria-label="{title}"><div class="e-dialog__header"><h2 class="e-dialog__title">{title}</h2>{ib("x", "quiet", "Close")}</div>'
            f'<div class="e-dialog__body">{bodyhtml}</div><div class="e-dialog__footer">{footer}</div></div>')
d1 = dlg('Delete Orchard Lane Cider?', '<p>This moves the project to Deleted projects and stops any work in progress. Its assets and history are kept, and you can restore it later.</p>', btn('Cancel', attrs=' data-force="focus"') + btn('Delete project', 'danger-filled'))
d2 = dlg('Delete your account?', '<p>This permanently deletes your account, projects and files. It can’t be undone.</p><div class="e-field"><label class="e-field__label" for="dc1">Type DELETE to confirm</label><div class="e-input"><input id="dc1" type="text" autocomplete="off"></div></div>', btn('Cancel', attrs=' data-force="focus"') + btn('Delete account', 'danger-filled'))
d3 = dlg('Delete Orchard Lane Cider?', '<p>This moves the project to Deleted projects and stops any work in progress.</p>', btn('Cancel') + f'<button type="button" class="e-button e-button--danger-filled" aria-busy="true" aria-disabled="true">{SP}Delete project</button>')
st = lambda h: f'<div class="pv-stage">{h}</div>'
body = sec('Reversible: a small dialog, then a toast with Undo', st(d1), note='The title names the action and the object. The body says what is lost and whether it can be undone. Focus starts on Cancel. The confirming button is the only danger-filled button in the product and repeats the verb.')
body += sec('Irreversible: the person types a word', st(d2))
body += sec('While it runs: the button loads and the dialog stays open', st(d3), note='A failure appears inside the dialog as a danger message.')
write('PatternDestructive', 'Patterns', body, '''
# Pattern: destructive confirmation

- A small Dialog. The title names the action and the object ("Delete Orchard Lane Cider?").
- The body says what is lost and whether it can be undone.
- Focus starts on Cancel. The confirming button is the only danger-filled button in the product and repeats the verb ("Delete project").
- Reversible actions (deleting a project) can skip heavy confirmation in favour of a Toast with Undo; irreversible ones (deleting an account) ask the person to type a word.
- While the action runs, the button shows the loading state and the dialog stays open; a failure appears inside the dialog.
''', height=1100)

# Long lists
body = sec('A first page, then “Show more” with a count', '<div class="e-stack e-stack--lg"><div class="e-grid-cards">' + skcard.replace(' aria-hidden="true"', '') * 3 + '</div><div class="e-cluster" style="justify-content:center">' + btn('Show 48 more brands') + '</div><p class="e-section__hint" style="text-align:center">8 of 56 brands</p></div>',
           note='No infinite scroll. Images below the first screen load lazily and sit in Media frames. A list longer than two screens gets a search or a filter. A gallery is one keyboard stop with arrow keys inside it.')
body += sec('Finished steps fold', '<div class="e-stack e-stack--sm">' + answer('Which personality feels right?', 'Adventurous and welcoming', 'Outdoorsy, friendly and safe.') + answer('Which name feels right?', 'Tidewater Kayak Tours', edit='Change name') + answer('Which slogan do you like?', 'Paddle further, together') + '</div>', note='Their controls leave the keyboard order until reopened.')
write('PatternLongLists', 'Patterns', body, '''
# Pattern: long lists

- Grids and lists show a first page and a "Show more" button that says how many remain. No infinite scroll.
- Images in lists are lazy below the first screen and sit in Media frames.
- A list longer than two screens gets a search or a filter.
- Finished steps of the conversation fold, so their controls leave the keyboard order until reopened.
- A gallery is one keyboard stop, with arrow keys inside it.
''', height=820)

# ================================================================ Foundations
motion_css = '''
.mo-track{position:relative;height:var(--button-height);border-radius:var(--radius-control);background:var(--color-bg-sunken);overflow:hidden}
.mo-dot{position:absolute;top:50%;left:var(--space-2);width:var(--control-box);height:var(--control-box);margin-top:calc(var(--control-box) / -2);border-radius:var(--radius-pill);background:var(--color-accent)}
.mo-go .mo-dot{animation:mo-move var(--d) var(--e) both}
@keyframes mo-move{to{left:calc(100% - var(--control-box) - var(--space-2))}}
.mo-box{display:grid;place-items:center;height:calc(var(--space-24));border:1px solid var(--color-border);border-radius:var(--radius-card);background:var(--color-bg-paper)}
@media (prefers-reduced-motion: reduce){.mo-go .mo-dot{animation:e-fade var(--duration-fast) ease both;left:calc(100% - var(--control-box) - var(--space-2))}}
'''
def track(label, d, e): return cell(label, f'<div class="mo-track" style="--d:var(--{d});--e:var(--{e})"><span class="mo-dot"></span></div>', True)
body = sec('Durations and easings', '<div class="pv-row">' + btn('Play', 'primary', attrs=' id="play"') + '</div>',
           grid(track('duration-fast 120 ms · ease-out', 'duration-fast', 'ease-out'), track('duration-press 160 ms · ease-out', 'duration-press', 'ease-out'), track('duration-base 200 ms · ease-out', 'duration-base', 'ease-out'),
                track('duration-slow 300 ms · ease-drawer', 'duration-slow', 'ease-drawer'), track('duration-slow 300 ms · ease-in-out', 'duration-slow', 'ease-in-out'), cls='pv-grid--wide'),
           note='300 ms is the ceiling for anything a person triggers. Only opacity and transform move; colour, border and background may fade. Entrances animate; exits are instant.')
body += sec('Movement', grid(cell('Press: scale 0.97 over 160 ms', btn('Press me', 'primary')), cell('Enter: from 97% and 4 px', '<div class="mo-box" id="enterbox" style="width:100%"><span class="e-badge">A result</span></div>', True),
                             cell('Waiting: pulse 1.6 s', '<span class="e-skeleton e-skeleton--block" style="width:100%"></span>', True), cell('Waiting: spin 0.8 s', '<span class="e-spinner e-spinner--md"></span>'),
                             cell('Waiting: sweep 2.4 s', '<div class="e-progress" style="width:100%"><div class="e-progress__track"></div></div>', True), cls='pv-grid--wide'))
body += sec('Reduced motion: remove movement, keep feedback', '<ul class="e-list-check e-measure"><li>' + ic('check') + '<span>Press scale and enter scale become 1; enter shift and stagger become 0; smooth scrolling is off.</span></li><li>' + ic('check') + '<span>Opacity fades stay, at 120 ms.</span></li><li>' + ic('check') + '<span>The skeleton keeps its pulse; the spinner pulses instead of turning; the progress bar is a static filled track with its sentence.</span></li><li>' + ic('check') + '<span>The logo drawing texture is replaced by its caption.</span></li></ul>',
            note='Turn on “reduce motion” in your system settings and this page follows it.')
write('Motion', 'Foundations', body, '''
# Motion

Tokens: `duration-fast` 120 ms, `duration-press` 160 ms, `duration-base` 200 ms, `duration-slow` 300 ms; loops `duration-loop-pulse` 1.6 s, `duration-loop-spin` 0.8 s, `duration-loop-sweep` 2.4 s; `ease-out`, `ease-in-out`, `ease-drawer`; `press-scale` 0.97, `enter-scale` 0.97, `enter-shift` 4 px, `stagger` 40 ms.

- Frequency decides: route changes, tabs, typing and Escape do not animate.
- Only opacity and transform move. Colour, border and background may fade over `duration-fast` with the keyword `ease`.
- Entrances animate; exits are instant. Nothing already on screen moves because something else loaded.
- Every action shows a change within 100 ms on the control that was pressed.
- Hover effects exist only where a pointer can hover (`hover: hover` and `pointer: fine`). Nothing is reachable by hover alone.
- Never `ease-in`. Nothing a person triggers takes longer than `duration-slow`.
- **Reduced motion** removes movement and keeps feedback: scales become 1, shifts and stagger 0, fades stay at 120 ms, the skeleton keeps its pulse, the spinner pulses, and the progress bar is a static filled track.
''', height=900, css=motion_css, script="document.getElementById('play').addEventListener('click',function(){document.querySelectorAll('.mo-track').forEach(function(t){t.classList.remove('mo-go');void t.offsetWidth;t.classList.add('mo-go')});var b=document.getElementById('enterbox');b.style.animation='none';void b.offsetWidth;b.style.animation='e-enter var(--duration-base) var(--ease-out)'});")

grid_css = '''
.gr{display:grid;gap:var(--grid-gap);grid-template-columns:repeat(4,minmax(0,1fr))}
.gr span{height:var(--space-12);border-radius:var(--radius-inset);background:var(--color-bg-skeleton)}
.gr span:nth-child(n+5){display:none}
@media (min-width:640px){.gr{grid-template-columns:repeat(8,minmax(0,1fr))}.gr span:nth-child(n+5){display:block}.gr span:nth-child(n+9){display:none}}
@media (min-width:1024px){.gr{grid-template-columns:repeat(12,minmax(0,1fr))}.gr span:nth-child(n+9){display:block}}
.gr-bar{height:var(--space-8);border-radius:var(--radius-inset);background:var(--color-bg-skeleton);display:grid;place-items:center;font:var(--text-caption);margin-inline:auto;width:100%}
'''
tbl = ('<table class="e-table"><caption>Breakpoints and behaviour</caption><thead><tr><th scope="col">&nbsp;</th><th scope="col">Compact, below 640 px</th><th scope="col">Medium, 640 to 1023 px</th><th scope="col">Wide, 1024 px and up</th></tr></thead><tbody>'
       '<tr><th scope="row">Columns, gap</th><td>4, 16 px</td><td>8, 20 px</td><td>12, 24 px</td></tr><tr><th scope="row">Gutter</th><td>16 px</td><td>24 px</td><td>32 px, content centred</td></tr>'
       '<tr><th scope="row">Card grids</th><td>1 across</td><td>2 across</td><td>3 across</td></tr><tr><th scope="row">Logo concepts, boards</th><td>2 across, never under 160 px</td><td>3 across</td><td>3 across</td></tr>'
       '<tr><th scope="row">Forms</th><td>Label above, full width; buttons full width</td><td>Two related fields side by side</td><td>Same; fields up to 480 px</td></tr>'
       '<tr><th scope="row">Navigation</th><td>Icons with names for assistive technology</td><td>Full labels</td><td>Full labels</td></tr><tr><th scope="row">Project bar</th><td>Steps in one menu button</td><td>Steps in one menu button</td><td>All four steps</td></tr>'
       '<tr><th scope="row">Dialogs</th><td>Bottom sheet, up to 90% of the height</td><td>Centred, fixed width</td><td>Centred, fixed width</td></tr><tr><th scope="row">Tables</th><td>Each row a stacked card</td><td>Table</td><td>Table</td></tr></tbody></table>')
body = sec('The column grid at this width', '<div class="gr">' + '<span></span>' * 12 + '</div>', note='4 columns with a 16 px gap below 640 px, 8 with 20 px from 640 px, 12 with 24 px from 1024 px.')
body += sec('Containers', '<div class="e-stack e-stack--sm"><div class="gr-bar" style="max-width:var(--container-page)">container-page · 1056 px</div><div class="gr-bar" style="max-width:var(--container-reading)">container-reading · 792 px</div><div class="gr-bar" style="max-width:var(--measure)">measure · 68 characters</div></div>')
body += sec('Behaviour', '<div style="overflow-x:auto">' + tbl + '</div>', note='No page scrolls sideways or clips at 320 px or at 200% zoom. Fixed chrome takes at most a quarter of a 450 px tall window. Components may use container queries where their own width matters more than the window’s.')
write('Grid', 'Foundations', body, '''
# Grid and breakpoints

Three named ranges replace 21 widths. They are constants, because CSS variables cannot be used in media queries.

| Name | Range | Columns, gap | Gutter |
| --- | --- | --- | --- |
| compact | below 640 px | 4, 16 px | 16 px |
| medium | 640 to 1023 px | 8, 20 px | 24 px |
| wide | 1024 px and up | 12, 24 px | 32 px |

- Two containers: `container-reading` 792 px (the project conversation) and `container-page` 1056 px (every other page). Content is centred.
- Running text is capped at `measure` (68 characters).
- Card grids are 1, 2 and 3 across. Logo concepts and boards are 2 across at compact (never under 160 px) and 3 across from medium.
- Forms: label above the field; two fields side by side only when related; fields up to 480 px wide.
- No page scrolls sideways or clips at 320 px or at 200% zoom.
''', height=1000, css=grid_css)

# Focus ring
body = sec('The two-part ring', grid(cell('On canvas', btn('Choose', attrs=' data-force="focus"')), cell('On paper', '<div class="pv-paper">' + btn('Choose', attrs=' data-force="focus"') + '</div>', True),
                                    cell('Inside a clipped box: the ring is drawn inside', '<div class="e-media" style="max-width:200px"><button type="button" class="e-focus-inset" data-force="focus" style="position:absolute;inset:0;border:0;padding:0;background:none;border-radius:inherit" aria-label="Open Kestrel Analytics board"><img src="{{img:kestrel-direction-2}}" alt=""></button></div>', True), cls='pv-grid--wide'),
           note='A 2 px ink ring with a 2 px paper halo. Outside free-standing controls, inside controls that fill a clipped box. No component removes it without this replacement.')
body += sec('On dark artwork: the halo is what holds 3:1', '<div class="pv-art" style="background-image:url({{img:kestrel-direction-2}});min-height:160px;align-items:center">' + ib('heart', 'on-artwork', 'Like', '', ' data-force="focus"') + ib('maximize-2', 'on-artwork', 'Enlarge', '', ' data-force="focus"') + '</div>')
body += sec('On an ink surface the ring flips', '<div class="pv-row"><div class="e-toast e-on-inverse" style="animation:none"><span class="e-toast__text">Moved to Deleted projects</span><button type="button" class="e-toast__action" data-force="focus">Undo</button></div></div>')
write('FocusRing', 'Foundations', body, '''
# Focus ring

The outline that shows which control the keyboard is on. One ring, everywhere.

- Two parts: a 2 px ring in `focus-ring-color` (ink) with a 2 px halo in `focus-ring-halo` (paper) outside it. On light surfaces the ink carries it; on dark artwork the halo does.
- Two offsets only: `focus-ring-offset` (2 px, outside a free-standing control) and `focus-ring-inset` (-2 px, inside a control that fills a clipped box, such as a gallery tile).
- A text-entry frame shows the ring whenever the field inside it has focus.
- On an ink surface (toast, tooltip) the ring flips: a paper ring with an ink halo.
- No component removes the ring without this replacement. It appears instantly and does not animate.
''', height=760)
