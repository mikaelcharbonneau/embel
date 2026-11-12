from pv import *
from comp_b import nav, pbar, pcard
from comp_c import turn, user, answer, prog, msg, btn, ib, SP

SC_CSS = '''
body.scr{margin:0}
.sc-bar{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);padding:var(--space-3) var(--space-gutter);border-bottom:1px solid var(--color-border);background:var(--color-bg-paper)}
.sc-bar__label{font:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-text-muted)}
.sc-bar label{cursor:pointer}
.sc{position:relative;padding-top:var(--nav-offset);min-height:720px}
[data-when]{display:none}
#st-1:checked~.sc [data-when~="1"],#st-2:checked~.sc [data-when~="2"],#st-3:checked~.sc [data-when~="3"],#st-4:checked~.sc [data-when~="4"]{display:block}
#st-1:checked~.sc [data-when~="1"][data-contents],#st-2:checked~.sc [data-when~="2"][data-contents],#st-3:checked~.sc [data-when~="3"][data-contents],#st-4:checked~.sc [data-when~="4"][data-contents]{display:contents}
#st-1:checked~.sc-bar label[for="st-1"],#st-2:checked~.sc-bar label[for="st-2"],#st-3:checked~.sc-bar label[for="st-3"],#st-4:checked~.sc-bar label[for="st-4"]{background:var(--color-accent);color:var(--color-on-accent)}
#st-1:focus-visible~.sc-bar label[for="st-1"],#st-2:focus-visible~.sc-bar label[for="st-2"],#st-3:focus-visible~.sc-bar label[for="st-3"],#st-4:focus-visible~.sc-bar label[for="st-4"]{outline:var(--focus-ring-width) solid var(--focus-ring-color);outline-offset:var(--focus-ring-offset)}
.sc-overlay{position:absolute;inset:0;z-index:var(--z-toast);background:var(--color-bg-scrim);justify-items:center;align-items:start;padding-top:calc(var(--space-24) * 2)}
#st-1:checked~.sc .sc-overlay[data-when~="1"],#st-2:checked~.sc .sc-overlay[data-when~="2"],#st-3:checked~.sc .sc-overlay[data-when~="3"],#st-4:checked~.sc .sc-overlay[data-when~="4"]{display:grid}
.sc-overlay .e-dialog{max-height:none;margin:0}
.sc-toast{position:sticky;bottom:var(--space-6);z-index:var(--z-toast);justify-content:center;margin-top:var(--space-6)}
#st-1:checked~.sc .sc-toast[data-when~="1"],#st-2:checked~.sc .sc-toast[data-when~="2"],#st-3:checked~.sc .sc-toast[data-when~="3"],#st-4:checked~.sc .sc-toast[data-when~="4"]{display:flex}
.sc-ph{position:absolute;inset:var(--space-3);display:grid;place-items:center;color:var(--color-text)}
.sc-ph svg{width:100%;height:100%}
@media (max-width:639px){.sc-overlay{bottom:auto;height:760px;align-items:end;padding-top:0}.sc-overlay .e-dialog{margin:0}}
'''
def switcher(states):
    radios = ''.join(f'<input class="e-sr" type="radio" name="st" id="st-{i+1}"{" checked" if i == 0 else ""}>' for i in range(len(states)))
    labels = ''.join(f'<label class="e-segmented__item" for="st-{i+1}">{s}</label>' for i, s in enumerate(states))
    return radios + f'<div class="sc-bar"><span class="sc-bar__label">State shown</span><div class="e-segmented">{labels}</div></div>'
def when(n, html, contents=False, tag='div', cls=''):
    return f'<{tag} data-when="{n}"{" data-contents" if contents else ""}{f" class={chr(34)}{cls}{chr(34)}" if cls else ""}>{html}</{tag}>'
def ph(shape, name, n):
    shapes = {'tri': '<path d="M120 40 170 128H70Z"/>', 'arc': '<path d="M78 126c0-64 84-64 84 0" fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"/>',
              'sq': '<rect x="78" y="44" width="84" height="84" rx="16"/>', 'dots': '<circle cx="98" cy="88" r="24"/><circle cx="142" cy="88" r="24"/>', 'ring': '<circle cx="120" cy="84" r="34" fill="none" stroke="currentColor" stroke-width="10"/>'}
    return (f'<span class="sc-ph"><svg viewBox="0 0 240 240" role="img" aria-label="{name}, test placeholder {n}" fill="currentColor">{shapes[shape]}'
            f'<text x="120" y="164" text-anchor="middle" font-family="Geist, Arial, sans-serif" font-size="15" font-weight="600">{name}</text>'
            f'<text x="120" y="184" text-anchor="middle" font-family="Geist, Arial, sans-serif" font-size="8" letter-spacing="1.5">TEST DATA · PLACEHOLDER #{n}</text></svg></span>')
def both(name, title, body, readme, dots=False, h1440=900, h390=1200):
    for w, suffix, h in ((1440, 'Wide', h1440), (390, 'Compact', h390)):
        write(f'{name}{suffix}', 'Validation screens', body, readme if w == 1440 else f'# {title}, at 390\n\nThe same markup as the 1440 screen, at compact width. Nothing here is styled outside the system.', height=h, width=w, page=True, css=SC_CSS, bodycls='scr', subtitle=f'{title} · {w}')
date = lambda t='Today', full='Nov 12, 2026': f'<span class="e-tooltip-host"><span class="e-card__meta" tabindex="0">{t}</span><span class="e-tooltip" role="tooltip">{full}</span></span>'

# ================================================================ 1. Projects, eight brands
def card(name, action, img='', desc='', menu=False, phimg=''):
    media = (f'<img src="{{{{img:{img}}}}}" alt="{name} logo">' if img else phimg if phimg else f'<p class="e-card__media-text">{desc}</p><span class="e-badge">No logo yet</span>')
    m = when(2, '<div class="e-menu" role="menu" aria-label="Options for ' + name + '" style="animation:none"><button type="button" class="e-menu__item e-menu__item--danger" role="menuitem">' + ic('trash-2') + 'Delete</button></div>', tag='span') if menu else ''
    long = len(name) > 40
    title = f'<a class="e-card__link" href="#">{name}</a>'
    tip = f'<span class="e-tooltip" role="tooltip" style="white-space:normal;width:max-content;max-width:280px">{name}</span>' if long else ''
    return (f'<li class="e-card e-card--interactive"><div class="e-card__media">{media}</div>'
            f'<span class="e-card__corner e-anchor"><button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm" aria-label="Options for {name}" aria-haspopup="menu"{" aria-expanded=" + chr(34) + "true" + chr(34) if menu else ""}>{ic("ellipsis")}</button>{m}</span>'
            f'<div class="e-card__body"><div class="e-cluster e-cluster--between e-cluster--nowrap"><h2 class="e-card__title e-tooltip-host" translate="no" style="display:block">{title}{tip}</h2>{date()}</div>'
            f'<span class="e-card__next">{action}{ic("arrow-right")}</span></div></li>')
CARDS = [card('Orchard Lane Cider', 'View brand kit', 'orchardlane-logo', menu=True),
         card('Mosswood Candles', 'Compare 3 directions', phimg=ph('ring', 'Mosswood Candles', 9)),
         card('Tidewater Kayak Tours', 'Choose a logo', desc='Guided sea kayak tours and sunset paddles around the islands of Tofino, British Columbia, for beginners and families, with gear rental and small groups of eight.'),
         card('Quill', 'Choose a logo', desc='Simple contract templates and e-signatures for freelance designers and developers, so they can send a contract in minutes.'),
         card('Fromagerie Bérénice Côté', 'Continue logo design', desc='Une fromagerie de quartier dans le Vieux-Québec qui vend des fromages fermiers du Québec et propose des dégustations.'),
         card('Northern Lights Community Physiotherapy and Sports Rehabilitation Collective', 'Continue to Inspiration', desc='A non-profit physiotherapy collective in Whitehorse, Yukon, run by six physiotherapists who share one clinic.'),
         card('Untitled brand', 'Review personality', desc='A pediatric dental clinic in Halifax for children from birth to sixteen, with sensory-friendly rooms, weekend hours and dentists trained for anxious kids.'),
         card('Untitled brand', 'Review competitors', desc='A mobile bicycle repair service that comes to your home or office in Montreal with a fully equipped cargo-bike workshop.')]
skel = ('<li class="e-card" aria-hidden="true"><div class="e-card__media"><span class="e-skeleton" style="position:absolute;inset:0;border-radius:0"></span></div>'
        '<div class="e-card__body"><span class="e-skeleton e-skeleton--title e-skeleton--w60"></span><span class="e-skeleton e-skeleton--line e-skeleton--w40"></span></div></li>')
delete = ('<div class="e-dialog e-dialog--sm" data-static role="alertdialog" aria-modal="true" aria-labelledby="del-t"><div class="e-dialog__header"><h2 class="e-dialog__title" id="del-t">Delete “Orchard Lane Cider”?</h2>' + ib('x', 'quiet', 'Close') + '</div>'
          '<div class="e-dialog__body"><p>This moves the project to Deleted projects and requests cancellation of active work. Work already started may still finish or incur usage. Its assets and history are kept. Restoring won’t restart cancelled AI work.</p></div>'
          '<div class="e-dialog__footer">' + btn('Cancel', attrs=' data-force="focus"') + btn('Stop active work and delete project', 'danger-filled') + '</div></div>')
body = switcher(['Eight brands', 'Card menu open', 'Delete dialog', 'Loading'])
body += ('<div class="sc"><div class="e-nav-wrap">' + nav('Projects') + '</div><main class="e-container e-page"><div class="e-stack e-stack--xl">'
         '<header class="e-page-header"><div class="e-stack e-stack--xs"><h1 class="text-title-lg">Projects</h1><p class="e-muted">Every idea, in its own world.</p></div>'
         '<div class="e-cluster e-cluster--lg"><a class="e-link e-link--standalone" href="#">Deleted projects</a><a class="e-button e-button--primary" href="#">' + ic('plus') + 'New project</a></div></header>'
         '<div class="e-cluster e-cluster--nowrap"><label class="e-input e-grow"><span class="e-sr">Search projects</span>' + ic('search') + '<input type="search" placeholder="Search projects"></label>'
         '<button type="button" class="e-button e-button--secondary" aria-haspopup="menu">' + ic('arrow-up-down') + 'Sort</button></div>'
         + when('1 2 3', '<ul class="e-grid-cards" aria-label="Projects">' + ''.join(CARDS) + '</ul>')
         + when(4, '<ul class="e-grid-cards" role="status" aria-label="Loading projects">' + skel * 8 + '</ul>')
         + '</div></main>' + when(3, delete, cls='sc-overlay') + '</div>')
both('ScreenProjects', 'Projects, eight brands', body, '''
# Validation screen 1: Projects, eight brands

Rebuilt from `projects__eight-brands-free`, `projects__options-menu-open-free`, `projects__delete-dialog-free` and `projects__loading-skeleton-free`, using only the system. Same data, actions and states; use the control at the top to switch state.

Proves: Card (interactive) with a 76-character name, an accented name and cards with no logo; Badge; Text field (search); Menu select (Sort); Icon button on a card; Menu; Dialog (confirmation) and the destructive pattern; Skeleton cards; the grid at 1 and 3 across; the navigation pill; the plain canvas.
''', h1440=1180, h390=3000)

# ================================================================ 2. Settings, Account tab
def field(fid, label, value, attrs='', hint=''):
    h = f'<span class="e-field__hint">{hint}</span>' if hint else ''
    return f'<div class="e-field"><label class="e-field__label" for="{fid}">{label}</label><div class="e-input"><input id="{fid}" type="text" value="{value}"{attrs}></div>{h}</div>'
def select(fid, label, hint, value):
    return (f'<div class="e-setting-row"><div class="e-setting-row__text"><label class="e-setting-row__title" for="{fid}">{label}</label><span class="e-section__hint">{hint}</span></div>'
            f'<div class="e-setting-row__control"><div class="e-input e-select"><select id="{fid}"><option>{value}</option></select>{ic("chevron-down")}</div></div></div>')
def settings(name, email, plan, credits, state):
    actions = {
        'clean': '<div class="e-form-actions"><span class="e-section__hint">No changes to save.</span>' + btn('Cancel', attrs=' disabled') + btn('Save changes', 'primary', attrs=' disabled') + '</div>',
        'error': '<div class="e-stack">' + msg('danger', 'circle-alert', 'Saving could not be confirmed. Your edits are still here. Check the saved settings before trying another save.', actions=btn('Check saved settings', extra='e-button--sm'))
                 + '<div class="e-form-actions"><span class="e-section__hint">You have unsaved changes.</span>' + btn('Cancel') + btn('Save changes', 'primary') + '</div></div>',
        'saving': '<div class="e-form-actions"><span class="e-section__hint">You have unsaved changes.</span>' + btn('Cancel') + f'<button type="button" class="e-button e-button--primary" aria-busy="true" aria-disabled="true">{SP}Save changes</button></div>',
    }[state]
    u = state
    return ('<div class="e-stack e-stack--section">'
            '<section class="e-section" aria-labelledby="s-profile-' + u + '"><div class="e-section__head"><h2 class="e-section__title" id="s-profile-' + u + '">Profile</h2><p class="e-section__hint">Your name appears in the account menu.</p></div>'
            '<div class="e-grid-fields">' + field('fn-' + u, 'Full name', name) + field('em-' + u, 'Email address', email, ' disabled', 'You sign in with this email.') + '</div></section>'
            '<section class="e-section" aria-labelledby="s-pref-' + u + '"><div class="e-section__head"><h2 class="e-section__title" id="s-pref-' + u + '">Preferences</h2><p class="e-section__hint">Choose how dates appear in Embel.</p></div>'
            '<div>' + select('tz-' + u, 'Time zone', 'Used for the dates and times Embel shows you.', 'Toronto — Eastern Time') + select('df-' + u, 'Date format', 'Preview: Oct 12, 2026', 'Month, day, year') + '</div>' + actions + '</section>'
            '<section class="e-section" aria-labelledby="s-plan-' + u + '"><h2 class="e-section__title" id="s-plan-' + u + '">Plan and credits</h2>'
            '<div class="e-card e-card--pad"><div class="e-cluster e-cluster--between e-cluster--top"><div class="e-cluster e-cluster--lg e-cluster--top"><div class="e-stat"><span class="e-stat__label">Plan</span><span class="e-stat__value">' + plan + '</span></div>'
            '<div class="e-stat"><span class="e-stat__label">Credits left this month</span><span class="e-stat__value">' + credits + '</span></div></div><a class="e-button e-button--secondary" href="#">See plans' + ic('arrow-right') + '</a></div></div></section>'
            '<section class="e-section" aria-labelledby="s-out-' + u + '"><h2 class="e-section__title" id="s-out-' + u + '">Sign out</h2>'
            '<div class="e-setting-row"><div class="e-setting-row__text"><p>Sign out of Embel on this device. Your work stays saved in your account.</p></div><div class="e-cluster">' + '<span class="e-tooltip-host">' + ib('refresh-cw', 'outlined', 'Check account', '') + '<span class="e-tooltip" role="tooltip">Check account</span></span>' + btn('Sign out') + '</div></div></section>'
            '<section class="e-section" aria-labelledby="s-data-' + u + '"><div class="e-section__head"><h2 class="e-section__title" id="s-data-' + u + '">Your data</h2><p class="e-section__hint">Take a copy of your work, or remove your account.</p></div>'
            '<div><div class="e-setting-row"><div class="e-setting-row__text"><span class="e-setting-row__title">Download my data</span><span class="e-section__hint">A ZIP with your profile, projects, Strategy, Voice and Identity work, and the files you generated or uploaded.</span></div>' + btn(ic('download') + 'Download') + '</div>'
            '<div class="e-setting-row"><div class="e-setting-row__text"><span class="e-setting-row__title">Delete account</span><span class="e-section__hint">Permanently delete your account, projects and files. This can’t be undone.</span></div>' + btn('Delete account', 'danger') + '</div></div></section></div>')
toast = '<div class="e-toast e-on-inverse" role="status" style="animation:none"><span class="e-toast__text">Changes saved</span><button type="button" class="e-toast__close" aria-label="Dismiss">' + ic('x', 'e-icon--sm') + '</button></div>'
tabs = ('<div class="e-tabs" role="tablist" aria-label="Settings"><button type="button" class="e-tab" role="tab" aria-selected="true">Account</button><button type="button" class="e-tab" role="tab" aria-selected="false">Usage</button></div>')
body = switcher(['Account (Pro)', 'Save failed, offline (Free)', 'Saving', 'Just saved'])
body += ('<div class="sc"><div class="e-nav-wrap">' + nav('') + '</div><main class="e-container e-page"><div class="e-stack e-stack--xl">'
         '<header class="e-stack e-stack--xs"><h1 class="text-title-lg">Settings</h1><p class="e-muted">Manage your account and see your usage.</p></header>' + tabs
         + when('1 4', settings('', 'audit-pro@example.test', 'Pro', '112', 'clean')) + when(2, settings('Audit Free Person', 'audit-free@example.test', 'Free', '0', 'error')) + when(3, settings('Audit Free Person', 'audit-free@example.test', 'Free', '0', 'saving'))
         + '</div>' + when(4, toast, cls='e-cluster sc-toast') + '</main></div>')
both('ScreenSettings', 'Settings, Account tab', body, '''
# Validation screen 2: Settings, Account tab

Rebuilt from `settings__account-pro` and `settings__save-error-offline-free`, using only the system. Use the control at the top to switch state.

Proves: Tabs; Text field in default and disabled states; Select; Button in primary, secondary, danger, disabled and loading states, each disabled button with its reason beside it; Inline message (danger, block) with a recovery button; the Toast after a confirmed save; the form-validation and success-feedback patterns; sections sitting on the canvas with only the plan as a card (decision 5); the type roles for labels, hints and section headings.
''', h1440=1700, h390=2400)

# ================================================================ 3. Library, empty
body = ('<div class="sc"><div class="e-nav-wrap">' + nav('Library') + '</div><main class="e-container e-page"><div class="e-stack e-stack--xl">'
        '<header class="e-stack e-stack--xs"><h1 class="text-title-lg">Your visual library</h1><p class="e-muted">All the pieces of your projects, in one place.</p></header>'
        '<div class="e-cluster e-cluster--between"><div class="e-tabs e-grow" role="tablist" aria-label="Library"><button type="button" class="e-tab" role="tab" aria-selected="true">Kept assets</button><button type="button" class="e-tab" role="tab" aria-selected="false">All generations</button></div>'
        + btn(ic('refresh-cw') + 'Refresh', 'quiet') + '</div>'
        '<div class="e-cluster"><label class="e-input e-grow" style="flex-basis:240px"><span class="e-sr">Search assets</span>' + ic('search') + '<input type="search" placeholder="Search assets"></label>'
        '<div class="e-input e-select e-grow" style="flex:0 1 180px"><select aria-label="Project"><option>All projects</option></select>' + ic('chevron-down') + '</div>'
        '<div class="e-input e-select e-grow" style="flex:0 1 180px"><select aria-label="Format"><option>All formats</option></select>' + ic('chevron-down') + '</div></div>'
        '<div class="e-empty" role="tabpanel"><span class="e-empty__visual">' + ic('images') + '</span><h2 class="e-empty__title">No kept assets yet</h2><p class="e-empty__text">Like or save an asset to bring it here. Assets used in a brand appear here too.</p>'
        '<div class="e-empty__action"><a class="e-button e-button--primary" href="#">Browse all generations' + ic('arrow-right') + '</a></div></div></div></main></div>')
both('ScreenLibrary', 'Library, empty', body, '''
# Validation screen 3: Library, empty

Rebuilt from `library__empty-fresh`, using only the system.

Proves: Empty state (page) with its visual slot; Tabs with nothing behind them; Text field (search) and Select; the plain canvas with almost no content (decision 6: dots only where work is made); spacing roles at page level.
''', h1440=900, h390=900)

# ================================================================ 4. Tidewater: logo concepts partly failed
def concept(n, label, state='ok', shape='', num=0):
    if state == 'failed':
        media = '<div class="e-media" data-state="failed">' + ic('image-off', 'e-icon--lg') + '<span>This concept couldn’t be drawn.</span></div>'; foot = '<span class="e-badge e-badge--danger">' + ic('circle-alert') + 'Failed</span>'; en = ''
    elif state == 'loading':
        media = '<div class="e-media" data-state="loading"></div>'; foot = '<span class="e-badge">Drawing</span>'; en = ''
    else:
        media = '<div class="e-media e-media--contain">' + ph(shape, 'Tidewater Kayak Tours', num) + '</div>'; foot = '<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="false">Choose</button>'
        en = f'<button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm e-choice__enlarge" aria-label="Enlarge {label}">{ic("maximize-2")}</button>'
    return f'<li class="e-choice e-choice--image" aria-label="{label}">{media}<span class="e-choice__mark" aria-hidden="true"></span>{en}<div class="e-choice__foot"><span class="e-choice__title">{label}</span>{foot}</div></li>'
SIX = [concept(0, 'Concept 1', 'failed'), concept(1, 'Concept 2', shape='tri', num=15), concept(2, 'Concept 3', shape='arc', num=16), concept(3, 'Concept 4', 'failed'), concept(4, 'Concept 5', shape='sq', num=14), concept(5, 'Concept 6', shape='dots', num=17)]
strategy = ('<section class="e-card e-card--pad e-stack" aria-label="Strategy"><div class="e-step-header"><span class="e-step__mark e-step__mark--complete">' + ic('check', 'e-icon--sm') + '</span>'
            '<h2 class="e-step-header__title">Strategy</h2><span class="e-badge e-badge--positive">Complete</span><span class="e-grow"></span>' + btn('Edit strategy', extra='e-button--sm') + '</div>'
            '<dl class="e-grid-cards"><div class="e-stack e-stack--sm"><dt class="e-section__hint">Competitors</dt><dd class="e-cluster"><span class="e-badge">Pacific Paddle Co</span><span class="e-badge">Clayoquot Kayaks</span></dd></div>'
            '<div class="e-stack e-stack--sm"><dt class="e-section__hint">Audience</dt><dd>Families on vacation</dd></div>'
            '<div class="e-stack e-stack--sm"><dt class="e-section__hint">Positioning</dt><dd><strong class="e-card__title" style="white-space:normal">Your first paddle, done right</strong><br><span class="e-muted">For our audience, we are your first paddle, done right.</span></dd></div></dl></section>')
insp = ('<details class="e-disclosure e-answer"><summary>' + ic('chevron-right', 'e-disclosure__chevron') + '<span class="e-answer__question">What do you like?</span><span class="e-badge">' + ic('heart') + '2 liked</span></summary>'
        '<div class="e-disclosure__content"><p class="e-muted">Archi-Tex, and one image of your own. 8 of 56 brands shown.</p><div class="e-cluster">' + btn('Edit inspiration', extra='e-button--sm') + btn('Add your own references', extra='e-button--sm') + '</div></div></details>')
types = ('<div class="e-card e-card--pad e-stack e-stack--md"><p><span class="e-muted">Logo types</span>&ensp;Wordmark, Lettermark or monogram, Pictorial mark, Abstract mark, Combination mark, Emblem</p><div>' + btn('Change logo types', extra='e-button--sm') + '</div></div>')
refine = ('<section class="e-card e-card--pad e-stack" aria-labelledby="rf-t"><h3 class="e-card__title" id="rf-t">Choose a concept above to change it</h3>'
          '<div class="e-input e-input--textarea e-input--disabled"><textarea rows="2" aria-label="Describe a change" placeholder="Choose a concept, then describe a change…" disabled></textarea></div>'
          '<div class="e-cluster e-cluster--between"><span class="e-section__hint">Select a logo above to get started.</span>' + btn('Refine', attrs=' disabled') + '</div></section>')
OOC = msg('neutral', 'info', 'Your work is saved, and your four concepts are kept. Credits renew on December 1, or a paid plan adds more every month.', 'You’re out of credits for this month', actions=btn('Not now', 'quiet', 'e-button--sm') + '<a class="e-button e-button--primary e-button--sm" href="#">See plans' + ic('arrow-right') + '</a>')
failed = msg('danger', 'circle-alert', 'Two of the six concepts couldn’t be drawn. The other four are ready.', actions=btn(ic('rotate-ccw') + 'Retry 2 failed concepts', extra='e-button--sm'))
composer = ('<div class="e-composer-dock"><div class="e-composer e-composer--floating"><textarea rows="1" aria-label="Reply" placeholder="Reply in your own words, or ask a question…"></textarea><div class="e-composer__actions"><span class="e-grow"></span>'
            '<button type="button" class="e-icon-button e-icon-button--primary e-icon-button--sm" aria-label="Send" disabled>' + ic('arrow-up') + '</button></div></div></div>')
logo_head = lambda status, extra='': ('<div class="e-cluster e-cluster--between"><p><span class="e-strong">Pick the concept you like most</span> <span class="e-muted">· ' + status + '</span></p><div class="e-cluster">' + extra + '</div></div>')
body = switcher(['Two concepts failed', 'Still drawing', 'Out of credits'])
body += ('<div class="sc e-canvas--dots"><div class="e-nav-wrap">' + pbar('Tidewater Kayak Tours', ['complete', 'complete', 'current', 'todo'], 'Identity') + '</div>'
         '<main class="e-container e-container--reading e-page e-page--composer"><div class="e-stack e-stack--xl">'
         + user('Guided sea kayak tours and sunset paddles around the islands of Tofino, British Columbia, for beginners and families, with gear rental and small groups of eight.')
         + strategy
         + '<div class="e-stack e-stack--sm">' + answer('Which personality feels right?', 'Adventurous and welcoming', 'Outdoorsy, friendly and safe.') + answer('Which name feels right?', 'Tidewater Kayak Tours', edit='Change name') + answer('Which slogan do you like?', 'Paddle further, together') + insp + '</div>'
         + turn('Embel · Logo · 2 of 3', '<p class="e-turn__text">Here are six concepts for <span translate="no">Tidewater Kayak Tours</span>. Pick the one you like most. To change it, tell me what to adjust below.</p>', types,
                when(1, logo_head('4 of 6 concepts ready', btn('More concepts', extra='e-button--sm')) , cls=''), when(1, failed),
                when(3, logo_head('4 of 6 concepts ready', btn('More concepts', extra='e-button--sm', attrs=' aria-describedby="ooc"')), cls=''), when(3, '<div id="ooc">' + OOC + '</div>'),
                when(2, '<div class="e-card e-card--pad">' + prog('running', 'Drawing six logo concepts for Tidewater Kayak Tours. This usually takes about a minute.', btn(ic('square') + 'Stop', extra='e-button--sm')) + '</div>'))
         + when('1 3', '<ul class="e-grid-choices e-breakout" aria-label="Logo concepts">' + ''.join(SIX) + '</ul>')
         + when(2, '<ul class="e-grid-choices e-breakout" aria-label="Logo concepts, drawing">' + ''.join(concept(i, f'Concept {i+1}', 'loading') for i in range(6)) + '</ul>')
         + '<div class="e-turn__continue">' + refine + '<div class="e-form-actions"><span class="e-section__hint">Choose a concept to continue.</span>' + btn('Continue', 'primary', attrs=' disabled') + '</div></div>'
         + '</div>' + composer + '</main></div>')
both('ScreenTidewater', 'Tidewater Kayak Tours: logo concepts partly failed', body, '''
# Validation screen 4: project conversation, Tidewater Kayak Tours

Rebuilt from `brand-conversation__tidewater-logos-partly-failed-free`, `brand-conversation__out-of-credits-prompt-free` and `brand-conversation__logos-drawing-aurelie-pro`, using only the system. Use the control at the top to switch state.

Proves: the project bar with complete, current and not-reached steps; conversation messages and Disclosure (folded answers, including the finished Inspiration step); Media frame in loaded, loading and failed states; Inline message with a retry Button; the progress bar with Stop; the out-of-credits message at the control that was pressed; Composer, docked; the reading container at 792 px; the dot-grid canvas where work is made.

The four concept images are the audit's own test placeholders, redrawn as simple shapes.
''', dots=True, h1440=2200, h390=3400)

# ================================================================ 5. Kestrel Analytics: Logo and Creative direction
def kconcept(n, img, sel=False, f='', bf='', enf=''):
    label = f'Concept {n}'
    version = ('<button type="button" class="e-button e-button--secondary e-button--sm" aria-haspopup="menu">Version 2 · Latest' + ic('chevron-down') + '</button>') if sel else ''
    b = ('<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="true">' + ic('check') + 'Chosen</button>') if sel else f'<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="false"{force(bf)}>Choose</button>'
    return (f'<li class="e-choice e-choice--image"{" data-selected" if sel else ""}{force(f)} aria-label="{label}"><div class="e-media e-media--contain"><img src="{{{{img:{img}}}}}" alt="Kestrel Analytics logo, concept {n}" loading="lazy"></div><span class="e-choice__mark" aria-hidden="true"></span>'
            f'<button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm e-choice__enlarge" aria-label="Enlarge {label}"{force(enf)}>{ic("maximize-2")}</button>'
            f'<div class="e-choice__foot"><span class="e-choice__title">{label}</span><span class="e-cluster">{version}{b}</span></div></li>')
def direction(n, name, img, c1, c2, font, sel=False, enf='', alt=''):
    b = ('<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="true">' + ic('check') + 'Chosen</button>') if sel else '<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="false">Choose</button>'
    sw = ''.join(f'<span class="e-swatch__color" style="--swatch:{c};width:var(--space-6);height:var(--space-6)" role="img" aria-label="{c}"></span>' for c in (c1, c2))
    return (f'<li class="e-choice e-choice--image"{" data-selected" if sel else ""} aria-label="Direction {n}: {name}"><div class="e-media"><img src="{{{{img:{img}}}}}" alt="{alt}" loading="lazy"></div><span class="e-choice__mark" aria-hidden="true"></span>'
            f'<button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm e-choice__enlarge" aria-label="Enlarge direction {n}"{force(enf)}>{ic("maximize-2")}</button>'
            f'<div class="e-choice__body"><div class="e-stack e-stack--xs"><span class="e-section__hint">Direction {n}</span><h3 class="e-card__title" style="white-space:normal">{name}</h3></div>'
            f'<dl class="e-cluster e-cluster--lg"><div class="e-stack e-stack--xs"><dt class="e-section__hint">Palette</dt><dd class="e-cluster">{sw}</dd></div><div class="e-stack e-stack--xs"><dt class="e-section__hint">Typography</dt><dd translate="no">{font} · 600</dd></div></dl>{b}</div></li>')
KL = ['kestrel-logo-1', 'kestrel-logo-2', 'kestrel-logo-3', 'kestrel-logo-4', 'kestrel-logo-5', 'kestrel-logo-6']
def logos(focus=False):
    return '<ul class="e-grid-choices e-breakout" aria-label="Logo concepts">' + ''.join(kconcept(i + 1, k, sel=(i == 0), f=('hover' if focus and i == 2 else ''), bf=('focus' if focus and i == 3 else '')) for i, k in enumerate(KL)) + '</ul>'
def dirs(focus=False):
    return ('<ul class="e-grid-choices e-grid-choices--large e-breakout" aria-label="Creative directions">' + direction(1, 'Editorial Soft Shapes', 'kestrel-direction-1', '#0F2A3D', '#F2A541', 'Manrope', True, alt='Board: deep navy and signal amber, flight-path lines, shown on a dashboard, a business card and a booth banner')
            + direction(2, 'Centered Linework', 'kestrel-direction-2', '#1B1B1F', '#3DDC97', 'Geist', enf=('focus' if focus else ''), alt='Board: near-black with electric green, monospaced labels, shown on a phone, a hoodie and a LinkedIn banner')
            + direction(3, 'Split Blocks', 'kestrel-direction-3', '#2B2D6E', '#FF6B5B', 'Fraunces', alt='Board: indigo with warm coral, serif headlines, shown on a slide, a whitepaper cover and an email header') + '</ul>')
krefine = ('<section class="e-card e-card--pad e-stack" aria-label="Change the chosen logo"><div class="e-cluster e-cluster--between"><div class="e-cluster"><span class="e-media e-media--thumb e-media--contain"><img src="{{img:kestrel-logo-1}}" alt=""></span><h3 class="e-card__title">Concept 1 · Version 2</h3></div>' + btn(ic('download') + 'Download PNG', extra='e-button--sm') + '</div>'
           '<div class="e-input e-input--textarea"><textarea rows="2" aria-label="Describe a change to this logo" placeholder="Describe a change to this logo…"></textarea></div>'
           '<div class="e-form-actions"><span class="e-section__hint">Describe a change to refine this logo.</span>' + btn('Refine', attrs=' disabled') + '</div></section>')
big = ('<div class="e-dialog e-dialog--lg" data-static role="dialog" aria-modal="true" aria-labelledby="big-t"><div class="e-dialog__header"><h2 class="e-dialog__title" id="big-t">Direction 2: Centered Linework</h2>' + ib('x', 'quiet', 'Close') + '</div>'
       '<div class="e-dialog__body e-dialog__body--media"><div class="e-media"><img src="{{img:kestrel-direction-2}}" alt="Board: near-black with electric green, monospaced labels, shown on a phone, a hoodie and a LinkedIn banner"></div></div>'
       '<div class="e-dialog__footer">' + btn(ic('arrow-left') + 'Previous') + btn('Next' + ic('arrow-right')) + btn('Choose this direction', 'primary') + '</div></div>')
def kbody(focus):
    return (turn('Embel · Logo · 2 of 3', '<p class="e-turn__text">Here are six concepts for <span translate="no">Kestrel Analytics</span>. Pick the one you like most. To change it, tell me what to adjust below.</p>', types,
                 '<div class="e-cluster e-cluster--between"><p><span class="e-strong">Logo chosen</span> <span class="e-muted">· 6 of 6 concepts ready</span></p>' + btn('More concepts', extra='e-button--sm') + '</div>') + logos(focus) + '<div class="e-turn__continue">' + krefine + '</div>'
            + turn('Embel · Creative direction · 3 of 3', '<p class="e-turn__text">Here are three ways to bring <span translate="no">Kestrel Analytics</span> to life, each built on your chosen logo. Pick the one that feels right.</p>',
                   '<div class="e-cluster"><span class="e-media e-media--thumb e-media--contain"><img src="{{img:kestrel-logo-1}}" alt="Your chosen logo"></span><span class="e-muted">Your logo</span></div>',
                   '<div class="e-cluster e-cluster--between"><p><span class="e-strong">Editorial Soft Shapes chosen</span> <span class="e-muted">· 3 of 3 ready</span></p>' + btn('More directions', extra='e-button--sm') + '</div>') + dirs(focus)
            + '<div class="e-cluster e-cluster--end"><a class="e-button e-button--primary" href="#">Continue' + ic('arrow-right') + '</a></div>')
body = switcher(['Chosen logo and direction', 'Hover and keyboard focus', 'Direction enlarged'])
body += ('<div class="sc e-canvas--dots"><div class="e-nav-wrap">' + pbar('Kestrel Analytics', ['complete', 'complete', 'current', 'todo'], 'Identity').replace('aria-disabled="true"', '') + '</div>'
         '<main class="e-container e-container--reading e-page e-page--composer"><div class="e-stack e-stack--xl">' + when('1 3', kbody(False), contents=True) + when(2, kbody(True), contents=True) + '</div>' + composer + '</main>'
         + when(3, big, cls='sc-overlay') + '</div>')
both('ScreenKestrel', 'Kestrel Analytics: Logo and Creative direction', body, '''
# Validation screen 5: project conversation, Kestrel Analytics

The Logo and Creative direction steps, rebuilt from `brand-conversation__kestrel-complete-showcase-pro` with the real generated images, using only the system. Use the control at the top to switch state.

Proves: Choice card (image, single) with selected, hover and focus states and a visible Choose control (decision 7); logo and board images at a size that can be judged; Dialog (large, media) with Previous, Next and "Choose this direction"; the Menu select for the logo version; the two-part focus ring on dark artwork; and the test that matters most for the Direction: the interface is quiet enough that Kestrel's colours are the loudest thing on screen (decision 1).
''', dots=True, h1440=2600, h390=4800)
