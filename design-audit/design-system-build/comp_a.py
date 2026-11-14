from pv import *

SP = '<span class="e-spinner" aria-hidden="true"></span>'

# ---------------------------------------------------------------- Button
def btn(label, kind='primary', f='', extra='', attrs='', before='', after=''):
    return f'<button type="button" class="e-button e-button--{kind} {extra}"{force(f)}{attrs}>{before}{label}{after}</button>'
VARIANTS = [('Primary', 'primary', 'New project'), ('Secondary', 'secondary', 'Cancel'), ('Quiet', 'quiet', 'Not now'),
            ('Danger', 'danger', 'Delete account'), ('Danger-filled', 'danger-filled', 'Delete project')]
rows = ''
for title, kind, label in VARIANTS:
    cells = [cell(s, btn(label, kind, f)) for s, f in STATES6]
    cells.append(cell('Disabled', btn(label, kind, attrs=' disabled')))
    cells.append(cell('Loading', btn(label, kind, attrs=' aria-busy="true" aria-disabled="true"', before=SP)))
    rows += f'<div class="pv-sec"><span class="pv-label">{title}</span>{grid(*cells)}</div>'
body = sec('Variants and states', rows, note='Hover exists only where a pointer can hover. Pressed scales to 0.97 over 160 ms. Loading keeps the label, adds a spinner and stays focusable.')
body += sec('Sizes, icons and width', grid(
    cell('Medium, 44 px', btn('Save changes')),
    cell('Small, 36 px (44 px target)', btn('Choose', 'secondary', extra='e-button--sm')),
    cell('Leading icon', btn('Download', 'secondary', before=ic('download'))),
    cell('Trailing arrow: goes to another page', '<a class="e-button e-button--primary" href="#">See plans' + ic('arrow-right') + '</a>'),
    cell('Pressed toggle', btn('Chosen', 'secondary', extra='e-button--sm', attrs=' aria-pressed="true"', before=ic('check'))),
    cell('Full width', '<div class="pv-fit">' + btn('Sign in', extra='e-button--block') + '</div>', stretch=True),
    cls='pv-grid--wide'))
write('Button', 'Actions', body, '''
# Button

The one way to trigger an action. You provide the label (a verb, sentence case), the variant, and optionally a leading icon.

- **Primary** (ink fill): the one main action of a view. At most one per view or dialog.
- **Secondary** (paper, hairline): every other action.
- **Quiet** (no border): low-emphasis actions beside a primary, such as "Not now".
- **Danger** (outlined): starts a destructive flow. **Danger-filled** appears only as the final button of a destructive confirmation.
- Sizes: 44 px (`button-height`) and 36 px (`button-height-sm`, pointer devices, with a 44 px touch target).
- A trailing arrow only on buttons that go to another page. A plus or other icon leads the label.
- Width: buttons hug their label. Use full width only for the single action of a narrow form, and for dialog actions at compact width.
- Loading: set `aria-busy="true"` and `aria-disabled="true"`, keep the label, add the spinner. Never `disabled`, so focus stays on the button.
- Do not disable a button to signal an incomplete form; let it explain on press. Any disabled button has its reason in text beside it.
- Radius is `radius-control`, the same as fields. Buttons are never pills.
''')

# ---------------------------------------------------------------- IconButton
def ib(icon, kind='outlined', f='', extra='', attrs='', label='Options'):
    return f'<button type="button" class="e-icon-button e-icon-button--{kind} {extra}" aria-label="{label}"{force(f)}{attrs}>{ic(icon)}</button>'
rows = ''
for title, kind, icon in [('Outlined', 'outlined', 'pencil'), ('Quiet', 'quiet', 'x')]:
    cells = [cell(s, ib(icon, kind, f)) for s, f in STATES6]
    cells += [cell('Disabled', ib(icon, kind, attrs=' disabled')),
              cell('Loading', f'<button type="button" class="e-icon-button e-icon-button--{kind}" aria-label="Refreshing" aria-busy="true" aria-disabled="true">{SP}</button>'),
              cell('Selected (pressed)', ib('heart', kind, attrs=' aria-pressed="true"', label='Liked'))]
    rows += f'<div class="pv-sec"><span class="pv-label">{title}</span>{grid(*cells, cls="pv-grid--narrow")}</div>'
art = ''.join(cell(f'<span class="e-badge">{s}</span>', ib('heart', 'on-artwork', f, attrs=a, label='Like')) for s, f, a in
              [('Default', '', ''), ('Hover', 'hover', ''), ('Focus-visible', 'focus', ''), ('Active', 'active', ''), ('Selected', '', ' aria-pressed="true"'), ('Disabled', '', ' disabled')])
rows += f'<div class="pv-sec"><span class="pv-label">On artwork: always on a paper chip, never a bare stroke on an image</span><div class="pv-art" style="background-image:url({{{{img:kestrel-direction-2}}}})">{art}</div></div>'
body = sec('Variants and states', rows)
body += sec('Sizes and name', grid(
    cell('44 px', ib('ellipsis')), cell('36 px on pointer devices', ib('ellipsis', extra='e-icon-button--sm')),
    cell('Primary: the send button', ib('arrow-up', 'primary', label='Send')),
    cell('Always named, with a tooltip', '<span class="e-tooltip-host">' + ib('maximize-2', label='Enlarge') + '<span class="e-tooltip" role="tooltip" data-force="open">Enlarge</span></span>')))
write('IconButton', 'Actions', body, '''
# Icon button

A round control that shows only an icon. You provide the icon, an accessible name (`aria-label`) and a tooltip with the same words.

- **Outlined** on paper or canvas, **quiet** inside toolbars and dialog headers, **on-artwork** (a paper chip at 92%) for anything drawn on an image.
- Toggle form (heart, show password): set `aria-pressed`. Pressed is an ink fill with a white icon, so it never relies on colour alone.
- **Primary** is reserved for the send button in a composer.
- 44 px; 36 px on pointer devices, with the 44 px target kept by its hit area.
- The focus ring is the two-part ring; on dark artwork the paper halo is what keeps it visible.
''', height=560)

# ---------------------------------------------------------------- Link
def lk(label, cls='', f='', attrs=''):
    return f'<a class="e-link {cls}" href="#"{force(f)}{attrs}>{label}</a>'
body = sec('Inline', '<p class="e-measure">Your work is saved. A paid plan adds more credits every month. ' + lk('See plans') + ' or ' + lk('read how credits work') + '.</p>',
           grid(*[cell(s, lk('See plans', f=f)) for s, f in STATES6], cell('Disabled', lk('See plans', attrs=' aria-disabled="true"'))))
body += sec('Standalone', grid(*[cell(s, lk('Deleted projects', 'e-link--standalone', f)) for s, f in STATES6],
                               cell('With arrow: goes to another page', lk('View brand kit' + ic('arrow-right'), 'e-link--standalone')),
                               cell('Disabled', lk('Deleted projects', 'e-link--standalone', attrs=' aria-disabled="true"'))),
            note='At least a 24 px tall box with 8 px clear around it. Visited is not styled.')
body += sec('Danger', grid(*[cell(s, lk('Remove this image', 'e-link--standalone e-link--danger', f)) for s, f in STATES6]))
write('Link', 'Actions', body, '''
# Link

Navigation written as text. You provide the label and the destination.

- **Inline**: inside a sentence, always underlined, in `color-text`. Hover darkens to `color-accent-hover` and thickens the underline, so an ink link still answers the pointer.
- **Standalone**: a label on its own line (`text-label`), underlined on hover, with an arrow only when it leads to another page. Minimum box 24 px tall (`link-target-min`).
- **Danger**: a destructive text action of low weight, such as removing one image.
- A recovery action ("Retry", "Check saved settings") is never a link. Use a secondary Button.
- Do not style visited links.
''', height=420)

# ---------------------------------------------------------------- TextField
def tf(label, inner, cls='', f='', hint='', err='', opt=False, fid='f'):
    lab = f'<label class="e-field__label" for="{fid}">{label}{" <span class=\'e-field__optional\'>Optional</span>" if opt else ""}</label>'
    h = f'<span class="e-field__hint" id="{fid}-h">{hint}</span>' if hint else ''
    e = f'<span class="e-message e-message--field e-message--danger" id="{fid}-e">{ic("circle-alert")}<span>{err}</span></span>' if err else ''
    return f'<div class="e-field">{lab}<div class="e-input {cls}"{force(f)}>{inner}</div>{h}{e}</div>'
def inp(fid, value='', ph='', typ='text', attrs=''):
    return f'<input id="{fid}" type="{typ}" value="{value}" placeholder="{ph}"{attrs}>'
n = [0]
def nid():
    n[0] += 1; return f'tf{n[0]}'
def state_fields():
    out = []
    for s, f in [('Default', ''), ('Hover', 'hover'), ('Focus-visible', 'focus')]:
        i = nid(); out.append(cell(s, tf('Full name', inp(i, 'Audit Free Person'), f=f, fid=i), stretch=True))
    i = nid(); out.append(cell('Disabled', tf('Email address', inp(i, 'audit-free@example.test', attrs=' disabled'), hint='You sign in with this email.', fid=i), stretch=True))
    i = nid(); out.append(cell('Read-only', tf('Project', inp(i, 'Tidewater Kayak Tours', attrs=' readonly'), fid=i), stretch=True))
    i = nid(); out.append(cell('Error', tf('Email address', inp(i, 'audit-free@example', typ='email', attrs=f' aria-invalid="true" aria-describedby="{i}-e"'), err='Enter a full email address, like name@example.com.', fid=i), stretch=True))
    return out
body = sec('States', grid(*state_fields(), cls='pv-grid--wide'), note='The outline is color-border-control (3:1 or better on paper, canvas and sunken). Hover and focus turn it ink. Placeholders give an example and are never the label.')
i1, i2, i3, i4, i5, i6 = [nid() for _ in range(6)]
body += sec('Types and parts', grid(
    cell('Text, with hint', tf('Full name', inp(i1, '', 'Alex Morgan'), hint='Your name appears in the account menu.', fid=i1), stretch=True),
    cell('Email', tf('Email address', inp(i2, '', 'name@example.com', 'email'), fid=i2), stretch=True),
    cell('Password, with show toggle', tf('Password', inp(i3, 'correct-horse', typ='password') + '<button type="button" class="e-icon-button e-icon-button--quiet e-icon-button--sm" aria-label="Show password" aria-pressed="false">' + ic('eye') + '</button>', fid=i3), stretch=True),
    cell('Search, with clear', tf('Search projects', ic('search') + inp(i4, 'kestrel', 'Search projects', 'search') + '<button type="button" class="e-icon-button e-icon-button--quiet e-icon-button--sm" aria-label="Clear search">' + ic('x') + '</button>', fid=i4), stretch=True),
    cell('Number', tf('Seats', inp(i5, '3', typ='number', attrs=' inputmode="numeric"'), opt=True, fid=i5), stretch=True),
    cell('Loading: a status line under the field', tf('Name', inp(i6, 'Tidewater Kayak Tours'), fid=i6).replace('</div></div>', '</div><span class="e-message e-message--field" role="status"><span class="e-spinner" aria-hidden="true"></span><span>Checking that this name is free…</span></span></div>', 1), stretch=True),
    cls='pv-grid--wide'))
write('TextField', 'Forms', body, '''
# Text field

A single-line input with its label, optional hint and error text. You provide the label, the input type and, where useful, a hint and a placeholder example.

- Types: text, email, password (built-in show toggle), search (leading icon and a clear button), number.
- The label is always visible, above the field. The placeholder is an example in `color-text-placeholder`, never the label.
- Outline: `color-border-control`. It becomes `color-border-selected` on hover and focus, and `color-border-danger` when invalid.
- Error: the message sits under the field with an icon, in `color-text-danger`, and is linked with `aria-describedby`. Set `aria-invalid="true"` on the input.
- Loading is a status line under the field, never a value written into it.
- Disabled uses `color-bg-disabled` and `color-text-disabled`; read-only keeps ink text on `color-bg-sunken`.
- Height 44 px. Text is 16 px at every width, so phones do not zoom on focus. Maximum width 480 px (`field-max`) at medium and wide widths.
''', height=760)

# ---------------------------------------------------------------- Textarea and composer
def composer(ph, cls='', f='', value='', send='arrow-up', sendlabel='Send', sendattrs='', left=True, ta_attrs='', rows=1):
    l = '<button type="button" class="e-icon-button e-icon-button--quiet e-icon-button--sm" aria-label="Add files">' + ic('plus') + '</button>' if left else ''
    return (f'<div class="e-composer {cls}"{force(f)}><textarea rows="{rows}" aria-label="{ph}" placeholder="{ph}"{ta_attrs}>{value}</textarea>'
            f'<div class="e-composer__actions">{l}<span class="e-grow"></span><button type="button" class="e-icon-button e-icon-button--quiet e-icon-button--sm" aria-label="Speak">{ic("mic")}</button>'
            f'<button type="button" class="e-icon-button e-icon-button--primary e-icon-button--sm" aria-label="{sendlabel}"{sendattrs}>{ic(send)}</button></div></div>')
ta = lambda f='', attrs='', v='', cls='': f'<div class="e-field"><label class="e-field__label">Describe a change</label><div class="e-input e-input--textarea {cls}"{force(f)}><textarea rows="3" placeholder="Describe a change to this logo…"{attrs}>{v}</textarea></div></div>'
body = sec('Textarea', grid(cell('Default', ta(), True), cell('Hover', ta('hover'), True), cell('Focus-visible', ta('focus', v='Make the kestrel wing shape simpler and bolder so it reads at small sizes.'), True),
                            cell('Disabled', ta(attrs=' disabled'), True), cell('Error', ta(cls='e-input--error', attrs=' aria-invalid="true"').replace('</div></div>', '</div><span class="e-message e-message--field e-message--danger">' + ic('circle-alert') + '<span>Describe the change in a few words first.</span></span></div>'), True), cls='pv-grid--wide'),
           note='Grows with its content between a minimum and a maximum. No browser resize handle.')
body += sec('Composer', grid(
    cell('Home prompt (lead size, floating)', composer('An idea you can’t stop thinking about…', 'e-composer--lead e-composer--floating', rows=2), True),
    cell('Reply box, default', composer('Reply in your own words, or ask a question…', 'e-composer--floating'), True),
    cell('Hover', composer('Reply in your own words, or ask a question…', 'e-composer--floating', 'hover'), True),
    cell('Focus-within: the ring is on the frame', composer('Reply in your own words, or ask a question…', 'e-composer--floating', 'focus', value='Can the logo work in one colour?'), True),
    cell('Loading: send becomes stop', composer('Reply in your own words, or ask a question…', 'e-composer--floating', send='square', sendlabel='Stop'), True),
    cell('Disabled', composer('Reply in your own words, or ask a question…', 'e-composer--disabled', sendattrs=' disabled', ta_attrs=' disabled'), True),
    cell('Error', composer('Reply in your own words, or ask a question…', 'e-composer--error e-composer--floating', value='A B2B analytics platform') + '<span class="e-message e-message--field e-message--danger">' + ic('circle-alert') + '<span>That didn’t send. Check your connection and try again.</span></span>', True),
    cls='pv-grid--wide'))
write('TextareaComposer', 'Forms', body, '''
# Textarea and composer

Multi-line text entry. You provide the label or placeholder, and for a composer the actions it offers.

- **Textarea**: the Text field's frame, auto-growing between three and ten lines. Same states and error rules as Text field.
- **Composer**: a text area plus an actions row (add files, voice, send). Used for the Home prompt (`text-body-lg`), the reply box and "describe a change". Radius `radius-panel`; `shadow-raised` only when it floats over the page.
- Focus: the standard two-part ring is drawn on the frame whenever the text area inside has focus. The inner control never shows a second ring.
- While a request runs, the send button becomes a stop button. The composer is not disabled, so focus stays.
- The send button is the only primary Icon button. It is disabled only when there is nothing to send.
''', height=980)

# ---------------------------------------------------------------- Select
def sel(label, opts, f='', attrs='', cls='', fid='s', hint='', err=''):
    o = ''.join(f'<option>{x}</option>' for x in opts)
    e = f'<span class="e-message e-message--field e-message--danger">{ic("circle-alert")}<span>{err}</span></span>' if err else ''
    h = f'<span class="e-field__hint">{hint}</span>' if hint else ''
    return f'<div class="e-field"><label class="e-field__label" for="{fid}">{label}</label><div class="e-input e-select {cls}"{force(f)}><select id="{fid}"{attrs}>{o}</select>{ic("chevron-down")}</div>{h}{e}</div>'
TZ = ['Toronto — Eastern Time', 'Vancouver — Pacific Time', 'Halifax — Atlantic Time']
body = sec('Form select', grid(cell('Default', sel('Time zone', TZ, fid='s1', hint='Used for the dates and times Embel shows you.'), True), cell('Hover', sel('Time zone', TZ, 'hover', fid='s2'), True),
                               cell('Focus-visible', sel('Time zone', TZ, 'focus', fid='s3'), True), cell('Disabled', sel('Time zone', TZ, attrs=' disabled', fid='s4'), True),
                               cell('Error', sel('Date format', ['Choose a format'], attrs=' aria-invalid="true"', fid='s5', err='Choose how dates should appear.'), True), cls='pv-grid--wide'),
           note='A native select with the system’s frame and chevron, so the platform’s own picker opens on phones.')
menu = ('<div class="e-menu" role="menu" aria-label="Sort projects" id="sortmenu"><span class="e-menu__label">Sort by</span>'
        '<button class="e-menu__item" role="menuitemradio" aria-checked="true">Last updated' + ic('check', 'e-menu__check') + '</button>'
        '<button class="e-menu__item" role="menuitemradio" aria-checked="false">Name' + ic('check', 'e-menu__check') + '</button>'
        '<button class="e-menu__item" role="menuitemradio" aria-checked="false">Date created' + ic('check', 'e-menu__check') + '</button></div>')
body += sec('Menu select', grid(cell('Closed', '<button type="button" class="e-button e-button--secondary" aria-haspopup="menu" aria-expanded="false">' + ic('arrow-up-down') + 'Sort</button>'),
                                cell('Open: uses Menu, with a tick on the current choice', '<div class="pv-sec"><button type="button" class="e-button e-button--secondary" aria-haspopup="menu" aria-expanded="true">' + ic('arrow-up-down') + 'Sort</button>' + menu + '</div>'),
                                cell('Version of a logo', '<button type="button" class="e-button e-button--secondary e-button--sm" aria-haspopup="menu">Version 2 · Latest' + ic('chevron-down') + '</button>'), cls='pv-grid--wide'))
write('Select', 'Forms', body, '''
# Select

Choosing one value from a list. You provide the label and the options.

- **Form select**: a native `<select>` inside the Text field frame, with the system chevron. Use it in forms (time zone, date format). Same states as Text field.
- **Menu select**: a secondary Button that opens a Menu, for sort, filters and the logo version. The current choice carries a tick; the button's label names the current value where space allows.
- Never show the bare browser control.
''', height=640)

# ---------------------------------------------------------------- Checkbox, radio, switch
def chk(label, typ='checkbox', f='', attrs='', desc='', cls='e-box'):
    d = f'<span class="e-field__hint">{desc}</span>' if desc else ''
    return f'<label class="e-check"><input class="{cls}" type="{typ}"{force(f)}{attrs}><span class="e-check__text"><span>{label}</span>{d}</span></label>'
def row(typ, label, extra=None):
    cells = [cell(s, chk(label, typ, f)) for s, f in STATES6]
    cells += [cell('Selected', chk(label, typ, attrs=' checked')), cell('Selected, focus-visible', chk(label, typ, 'focus', ' checked')),
              cell('Disabled', chk(label, typ, attrs=' disabled')), cell('Disabled, selected', chk(label, typ, attrs=' checked disabled')),
              cell('Error', chk(label, typ, attrs=' aria-invalid="true"'))]
    if extra: cells += extra
    return grid(*cells)
body = sec('Checkbox', row('checkbox', 'Wordmark', [cell('Indeterminate', chk('All logo types', 'checkbox', attrs=' data-indeterminate'))]), note='A 20 px box inside a 44 px target. The whole label row is the target.')
body += sec('Radio', row('radio', 'Month, day, year'))
sw = lambda f='', attrs='': chk('Email me when a brand kit is ready', 'checkbox', f, attrs + ' role="switch"', cls='e-switch')
body += sec('Switch', grid(cell('Off', sw()), cell('Hover', sw('hover')), cell('Focus-visible', sw('focus')), cell('On', sw(attrs=' checked')), cell('Disabled', sw(attrs=' disabled')), cell('Disabled, on', sw(attrs=' checked disabled')), cls='pv-grid--wide'),
            note='For on/off settings that apply at once. The app has none today; the label above is an example only.')
write('CheckboxRadioSwitch', 'Forms', body, '''
# Checkbox, radio, switch

Small selection controls, always with a visible label. You provide the label and, optionally, one line of description.

- **Checkbox**: independent yes/no choices; supports indeterminate for "some of these".
- **Radio**: one of a few options, inside a named group.
- **Switch**: an on/off setting that takes effect at once.
- Box 20 px (`control-box`) in a 44 px target; unchecked outline `color-border-control`; checked is `color-accent` with a white tick or dot.
- When each option needs a title and a description, or shows an image, use Choice card.
''', height=760)

# ---------------------------------------------------------------- Choice card
def tchoice(title, desc, typ='radio', f='', attrs='', cls='', wrap=''):
    multi = ' e-choice--multiple' if typ == 'checkbox' else ''
    return f'<label class="e-choice{multi} {cls}"{force(f)}{wrap}><input type="{typ}"{attrs}><span class="e-choice__title">{title}</span><span class="e-choice__desc">{desc}</span><span class="e-choice__mark" aria-hidden="true"></span></label>'
P1 = ('Adventurous and welcoming', 'Outdoorsy, friendly and safe.')
L1 = ('Wordmark', 'The name, set in distinctive type.')
def trow(typ, t):
    c = [cell(s, tchoice(*t, typ, f), True) for s, f in STATES6]
    c += [cell('Selected', tchoice(*t, typ, attrs=' checked'), True),
          cell('Selected, focus-visible', tchoice(*t, typ, 'focus', ' checked'), True),
          cell('Loading: saving the choice', tchoice(*t, typ, wrap=' aria-busy="true"').replace('aria-hidden="true"></span></label>', 'aria-hidden="true"><span class="e-spinner"></span></span></label>'), True),
          cell('Disabled', tchoice(*t, typ, attrs=' disabled'), True),
          cell('Error', tchoice(*t, typ, cls='e-choice--error') + '<span class="e-message e-message--field e-message--danger">' + ic('circle-alert') + '<span>That choice wasn’t saved. Choose it again.</span></span>', True)]
    return grid(*c, cls='pv-grid--wide')
def ichoice(img, label, sel=False, f='', ratio='', busy=False, state='', alt='Kestrel Analytics logo concept', bf=''):
    media = (f'<div class="e-media e-media--contain {ratio}"><img src="{{{{img:{img}}}}}" alt="{alt}"></div>' if not state else
             f'<div class="e-media {ratio}" data-state="{state}">' + ('' if state == 'loading' else ic('image-off', 'e-icon--lg') + '<span>This concept couldn’t be drawn.</span>') + '</div>')
    if ratio and not state: media = media.replace('e-media--contain ', '')
    mark = '<span class="e-choice__mark" aria-hidden="true">' + ('<span class="e-spinner"></span>' if busy else '') + '</span>'
    en = '' if state else f'<button type="button" class="e-icon-button e-icon-button--on-artwork e-icon-button--sm e-choice__enlarge" aria-label="Enlarge {label}">{ic("maximize-2")}</button>'
    if state == 'failed': b = '<button type="button" class="e-button e-button--secondary e-button--sm">' + ic('rotate-ccw') + 'Retry</button>'
    elif state == 'loading': b = '<span class="e-badge">Drawing</span>'
    elif sel: b = '<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="true">' + ic('check') + 'Chosen</button>'
    else: b = f'<button type="button" class="e-button e-button--secondary e-button--sm" aria-pressed="false"{force(bf)}>Choose</button>'
    return f'<article class="e-choice e-choice--image"{force(f)}{" data-selected" if sel else ""}{" aria-busy=\'true\'" if busy else ""} aria-label="{label}">{media}{mark}{en}<div class="e-choice__foot"><span class="e-choice__title">{label}</span>{b}</div></article>'
body = sec('Single choice (radio)', trow('radio', P1), note='The mark sits in one fixed corner on every card. Selected is a 2 px ink ring plus a filled tick, so it never relies on colour.')
body += sec('Multiple choice (checkbox)', trow('checkbox', L1))
body += sec('Image choice, 1:1', grid(
    cell('Default', ichoice('kestrel-logo-2', 'Concept 2'), True), cell('Hover', ichoice('kestrel-logo-3', 'Concept 3', f='hover'), True),
    cell('Focus-visible on Choose', ichoice('kestrel-logo-4', 'Concept 4', bf='focus'), True), cell('Selected', ichoice('kestrel-logo-1', 'Concept 1', sel=True), True),
    cell('Loading: saving the choice', ichoice('kestrel-logo-5', 'Concept 5', busy=True), True), cell('Still drawing', ichoice('', 'Concept 6', state='loading'), True),
    cell('Error: failed to draw', ichoice('', 'Concept 6', state='failed'), True), cls='pv-grid--wide'),
    note='The choice is a visible, labelled button. Clicking the picture never commits a choice; Enlarge opens the large view.')
body += sec('Image choice, 4:5', grid(cell('Default', ichoice('kestrel-direction-2', 'Direction 2', ratio='e-media--4x5', alt='Direction board: night operations'), True),
                                    cell('Selected', ichoice('kestrel-direction-1', 'Direction 1', sel=True, ratio='e-media--4x5', alt='Direction board: precision at altitude'), True), cls='pv-grid--wide'))
write('ChoiceCard', 'Forms', body, '''
# Choice card

A selectable card: the one look for "this is my choice" across the whole journey. You provide the options, whether one or several may be chosen, and for image choices the artwork and a label such as "Concept 2".

- **Single** (radio) and **multiple** (checkbox): a real input inside a named group; the whole card is the label. The mark sits in the top-right corner on every card (round for single, square for multiple).
- **Image choice** (logo concept, direction board, inspiration tile): the artwork in a Media frame at 1:1 or 4:5, a visible label, and a real **Choose** button (`aria-pressed`). Enlarge is a secondary Icon button on a paper chip; compare, where offered, sits beside it.
- Selected: a 2 px ring in `color-border-selected` and a filled tick badge in the fixed corner. The button reads "Chosen". No soft fill, so artwork keeps its own background.
- Loading (saving the choice): a spinner replaces the tick and the card is `aria-busy`. Error: `color-border-danger` and a field-level message.
- Never commit a choice from a click on the picture. Never show a card without its label.
''', height=2200)

# ---------------------------------------------------------------- Range slider
def rng(f='', attrs='', val=40):
    return f'<div class="e-range"><label class="e-field__label">Name length</label><input type="range" min="0" max="100" value="{val}" style="--range-fill:{val}%"{force(f)}{attrs}><div class="e-range__scale"><span>Short</span><span>Medium</span><span>Long</span></div></div>'
body = sec('States', grid(cell('Default', rng(), True), cell('Hover', rng('hover'), True), cell('Focus-visible', rng('focus'), True), cell('Active', rng('active', val=70), True), cell('Disabled', rng(attrs=' disabled'), True), cls='pv-grid--wide'),
           note='A 4 px track in a 44 px target, with a labelled scale underneath.')
write('RangeSlider', 'Forms', body, '''
# Range slider

One value on a labelled scale. You provide the label, the range and the words at the ends of the scale.

- Track 4 px (`progress-height`), thumb 20 px, target 44 px. The filled part is `color-accent`; the rest is `color-border-control`.
- Always show a scale in words under the track ("Short", "Medium", "Long").
- Use it only where a rough position is enough. For an exact number use a number field.
''', height=320)
