import json
import os
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
S=HERE+'out/'
os.makedirs(S+'project',exist_ok=True)
def c(name,value,usage): return {"name":name,"value":value,"usage":usage}
A=lambda n:'{'+n+'}'
color=[
 # primitives
 c("neutral-0","#ffffff","Primitive. White. Used only through semantic tokens."),
 c("neutral-50","#f7f7f5","Primitive. The warm page grey."),
 c("neutral-100","#f1f0ee","Primitive. Sunken fills."),
 c("neutral-200","#e4e3df","Primitive. Decorative hairlines."),
 c("neutral-300","#c9c8c2","Primitive. Stronger decorative hairlines and the dot grid."),
 c("neutral-400","#8a8985","Primitive. Control outlines."),
 c("neutral-500","#85847f","Primitive. Disabled text and icons."),
 c("neutral-600","#696965","Primitive. Secondary text."),
 c("neutral-800","#3a3a37","Primitive. Hover of ink fills."),
 c("neutral-900","#191919","Primitive. Ink."),
 c("green-50","#eef3ef","Primitive. Positive soft fill."),
 c("green-200","#c8d8cc","Primitive. Decorative edge of a positive message."),
 c("green-700","#3d6448","Primitive. Positive text and icons."),
 c("red-50","#faeeee","Primitive. Danger soft fill."),
 c("red-200","#e5c4c4","Primitive. Decorative edge of a danger message."),
 c("red-500","#b54b4b","Primitive. Danger outlines."),
 c("red-700","#a42a2a","Primitive. Danger text and the filled destructive button."),
 c("red-800","#8a2222","Primitive. Hover of the filled destructive button."),
 c("amber-50","#fff8e9","Primitive. Warning soft fill."),
 c("amber-200","#e3ce9c","Primitive. Decorative edge of a warning message."),
 c("amber-800","#6b4617","Primitive. Warning text and icons."),
 # semantic: background
 c("color-bg-canvas",A("neutral-50"),"Page background on every page. Page sections sit directly on it."),
 c("color-bg-paper",A("neutral-0"),"Cards, fields, menus, dialogs, the navigation pill and the composer."),
 c("color-bg-sunken",A("neutral-100"),"Recessed areas: a card's media area, neutral messages, code blocks, skeletons."),
 c("color-bg-hover",A("neutral-100"),"Hover fill of secondary and quiet buttons, menu rows, chips, table rows."),
 c("color-bg-selected",A("neutral-100"),"Fill of a selected chip, menu row or segmented item. Always paired with a non-colour cue."),
 c("color-bg-disabled",A("neutral-100"),"Fill of a disabled button or field."),
 c("color-bg-inverse",A("neutral-900"),"Ink fill: toasts and tooltips."),
 c("color-bg-scrim","rgb(25 25 25 / 0.4)","Behind every dialog, drawer and sheet. No blur."),
 c("color-bg-positive-soft",A("green-50"),"Fill of a positive message or badge."),
 c("color-bg-danger-soft",A("red-50"),"Fill of a danger message or badge."),
 c("color-bg-warning-soft",A("amber-50"),"Fill of a warning message or badge."),
 c("color-bg-danger",A("red-700"),"Fill of the danger-filled button, the final step of a destructive confirmation. Nothing else."),
 c("color-bg-danger-hover",A("red-800"),"Hover of the danger-filled button."),
 c("color-bg-skeleton",A("neutral-200"),"Fill of a skeleton and of a media frame while it loads. Visible on color-bg-paper, color-bg-canvas and color-bg-sunken; decorative."),
 # text
 c("color-text",A("neutral-900"),"Primary text on color-bg-canvas, color-bg-paper, color-bg-sunken and every soft fill. Also errors, recovery actions and current status."),
 c("color-text-muted",A("neutral-600"),"Secondary text, hints and meta lines on color-bg-canvas, color-bg-paper, color-bg-sunken and the soft fills. Never the only carrier of an instruction."),
 c("color-text-placeholder",A("neutral-600"),"Placeholder text inside fields on color-bg-paper, color-bg-canvas and color-bg-sunken. An example, never the label."),
 c("color-text-disabled",A("neutral-500"),"Label of a disabled control on color-bg-disabled, color-bg-paper and color-bg-canvas. Meets the 3:1 house minimum; WCAG sets none for disabled controls."),
 c("color-text-inverse",A("neutral-0"),"Text on color-bg-inverse."),
 c("color-text-positive",A("green-700"),"Positive text and icons on color-bg-paper, color-bg-canvas, color-bg-sunken and color-bg-positive-soft. Always with an icon or a word."),
 c("color-text-danger",A("red-700"),"Error text and icons on color-bg-paper, color-bg-canvas, color-bg-sunken and color-bg-danger-soft. Always with an icon or a word."),
 c("color-text-warning",A("amber-800"),"Warning text and icons on color-bg-paper, color-bg-canvas, color-bg-sunken and color-bg-warning-soft. Always with an icon or a word."),
 # border
 c("color-border",A("neutral-200"),"Decorative hairline: card edges, dividers, secondary buttons. Never the only edge of something a person types into or ticks."),
 c("color-border-strong",A("neutral-300"),"Decorative hairline on hover of cards, chips and secondary buttons."),
 c("color-border-control",A("neutral-400"),"Outline of fields, textareas, selects, checkboxes, radios and switches on color-bg-paper, color-bg-canvas and color-bg-sunken. At least 3:1 on each."),
 c("color-border-selected",A("neutral-900"),"The 2px ring of a selected choice card, the edge of a selected chip, and control outlines on hover."),
 c("color-border-danger",A("red-500"),"Outline of an invalid field and of the outlined danger button, on color-bg-paper, color-bg-canvas and color-bg-danger-soft."),
 c("color-border-danger-soft",A("red-200"),"Decorative edge of a danger message. Never outlines a button."),
 c("color-border-warning-soft",A("amber-200"),"Decorative edge of a warning message."),
 c("color-border-positive-soft",A("green-200"),"Decorative edge of a positive message."),
 # accent
 c("color-accent",A("neutral-900"),"Fill of the primary button, the current navigation item, a checked box, the tick badge and the send button. Ink: Embel has no accent hue."),
 c("color-accent-hover",A("neutral-800"),"Hover of anything filled with color-accent."),
 c("color-on-accent",A("neutral-0"),"Label and icon on color-accent, color-accent-hover, color-bg-danger and color-bg-danger-hover."),
 # icon
 c("color-icon",A("neutral-900"),"Icons that act as controls or carry meaning, on every light surface."),
 c("color-icon-muted",A("neutral-600"),"Secondary icons beside muted text."),
 # focus
 c("focus-ring-color",A("neutral-900"),"The 2px keyboard focus ring. At least 3:1 on every light surface."),
 c("focus-ring-halo",A("neutral-0"),"The 2px halo outside the ring, so the ring holds 3:1 on dark artwork."),
 # other
 c("color-selection",A("neutral-200"),"Text selection highlight."),
 c("pattern-dot-color",A("neutral-300"),"Dots of the dot-grid canvas, used on Home and the project conversation only. Decorative."),
 c("chip-on-artwork-bg","rgb(255 255 255 / 0.92)","Component token. The paper chip under any control drawn on an image."),
]
def st(name,size,lh,w,ls,sample,usage,**k):
    d={"name":name,"fontSize":size,"lineHeight":lh,"fontWeight":w,"letterSpacing":ls,"sample":sample,"usage":usage}; d.update(k); return d
typ={
 "fonts":[{"family":"Geist","file":"fonts/Geist-Variable.woff2","weight":"100 900","style":"normal"},
          {"family":"Instrument Sans","file":"fonts/InstrumentSans-Variable.woff2","weight":"400 700","style":"normal"}],
 "families":{"sans":"\"Geist\", \"Helvetica Neue\", Arial, sans-serif",
             "display":"\"Instrument Sans\", \"Geist\", \"Helvetica Neue\", Arial, sans-serif",
             "mono":"ui-monospace, \"SF Mono\", Menlo, Consolas, monospace"},
 "groups":[
  {"name":"Display","family":"display","note":"Instrument Sans, for the three places Embel speaks as itself. Never below 24px.","styles":[
    st("text-display","44px",1.1,500,"-0.03em","Your next brand starts here.","The Home headline only. Fluid: clamp(32px, 4vw, 44px)."),
    st("text-title-xl","32px","40px",500,"-0.02em","Kestrel Analytics","A brand's name on Assets and in the exported guide; the name preview."),
    st("text-title-lg","24px","32px",500,"-0.02em","Projects","Page titles, prices, error-page titles. No trailing full stop."),
  ]},
  {"name":"Interface","family":"sans","note":"Geist Sans. Three weights only: 400 reading, 500 labels and headings, 600 the Embel wordmark and emphasised numbers.","styles":[
    st("text-title-md","20px","28px",500,"-0.015em","Preferences","Section headings, dialog titles, step headings in the conversation."),
    st("text-title-sm","16px","24px",500,"-0.01em","Tidewater Kayak Tours","Card titles, plan names, sub-section headings."),
    st("text-body-lg","18px","28px",400,"0","An idea you can’t stop thinking about…","The Home prompt as typed; lead sentences in the conversation."),
    st("text-body","16px","24px",400,"0","Here are six concepts for Kestrel Analytics. Pick the one you like most.","Conversation text, descriptions, values typed into fields. Capped at 68 characters a line."),
    st("text-label","14px","20px",500,"0","Save changes","Buttons, navigation, field labels, tabs, menu rows, table headers."),
    st("text-small","13px","20px",400,"0","You sign in with this email.","Hints, meta lines, secondary text, table cells, badges. The smallest size for a status or an error."),
    st("text-caption","12px","16px",400,"0.01em","Today · 4 of 6 concepts ready","Timestamps, counters, legal lines. Never an instruction, an error or the only label of a control."),
  ]},
  {"name":"Code","family":"mono","note":"System monospace, for exported token values only.","styles":[
    st("text-code","13px","20px",400,"0","--brand-primary: #0F2A3D;","The code block for exported tokens and hex values beside a swatch."),
  ]},
 ]}
def t(name,value,usage): return {"name":name,"value":value,"usage":usage}
spacing=[t("space-0-5","2px","Optical nudges; gap between a label and its counter."),t("space-1","4px","Icon to its own badge; stacked meta lines."),t("space-1-5","6px","Padding inside chips and menus."),t("space-2","8px","Icon to label; between related buttons; label to field."),t("space-3","12px","Padding inside fields and small cards; between list rows."),t("space-4","16px","Default gap between items in a group; card padding at compact width."),t("space-5","20px","Between form fields."),t("space-6","24px","Card padding; gap between cards."),t("space-8","32px","Between a heading block and its content."),t("space-10","40px","Between groups inside a page."),t("space-12","48px","Between page sections."),t("space-16","64px","Page-level empty states; between page sections at wide width."),t("space-24","96px","Clearance under the floating composer; the Home hero."),
 t("space-card","24px","Role. Padding of a card (space-6)."),t("space-stack","20px","Role. Between form fields (space-5)."),t("space-section","48px","Role. Between page sections (space-12); 64px (space-16) at wide width."),t("space-gutter","16px","Role. Page side padding: 16px compact, 24px medium, 32px wide.")]
radius=[t("radius-inset","4px","Checkboxes, tags inside a control, thumbnails up to 40px."),t("radius-small","8px","Menu rows, inline messages, small tiles, tooltips, code blocks."),t("radius-control","12px","Buttons, fields, selects, textareas, toasts."),t("radius-card","16px","Cards, menus, popovers, image frames."),t("radius-panel","20px","Dialogs, sheets, the composer."),t("radius-pill","999px","The floating navigation, chips, badges, avatars, round icon buttons. Never buttons.")]
shadow=[t("shadow-none","none","Cards, panels and fields. A card is a hairline on paper; its hover is a stronger hairline, not a lift."),t("shadow-raised","0 12px 32px -16px rgb(25 25 25 / 0.28)","Things that float over the page permanently: the navigation pill, the docked composer, the toast."),t("shadow-overlay","0 16px 40px -16px rgb(25 25 25 / 0.30)","Menus, popovers and tooltips."),t("shadow-modal","0 24px 80px rgb(25 25 25 / 0.15)","Dialogs, drawers and sheets.")]
zindex=[t("z-base","0","Page content."),t("z-raised","1","Overlap inside one component (a badge on a card)."),t("z-sticky","10","Sticky headers, the docked composer."),t("z-nav","30","The floating navigation."),t("z-popover","40","Menus, popovers, tooltips."),t("z-toast","60","Toasts."),t("z-skip-link","70","The skip link. Dialogs use the browser's top layer and need no z-index.")]
layout=[t("container-reading","792px","The project conversation."),t("container-page","1056px","Projects, Library, Assets, Plans, Settings, Home's lower section."),t("measure","68ch","Maximum line length of running text."),t("nav-height","56px","The floating pill and the project bar."),t("nav-offset","16px","Gap from the top of the window to the pill; content starts 40px below the pill."),t("target-min","44px","Minimum height and width of any control on touch widths."),t("link-target-min","24px","Minimum height of a standalone text link, with 8px clear around it."),t("field-max","480px","Maximum width of a form field at medium and wide widths."),t("grid-gap","16px","Gap of the column grid: 16px compact (4 columns), 20px medium (8), 24px wide (12).")]
duration=[t("duration-fast","120ms","Hover and selection colour, border, small fades."),t("duration-press","160ms","Press scale; a tick or ring appearing."),t("duration-base","200ms","Dialogs, content entering, images fading in."),t("duration-slow","300ms","A drawer or sheet sliding; a finished result appearing. The ceiling for anything a person triggers."),t("duration-loop-pulse","1.6s","The skeleton and thinking pulse."),t("duration-loop-spin","0.8s","The spinner."),t("duration-loop-sweep","2.4s","The progress bar sweep."),t("menu-duration","150ms","Component token. Menus and popovers opening."),t("toast-duration","5s","Component token. How long a toast stays."),t("tooltip-delay","500ms","Component token. Hover delay before a tooltip appears; none on keyboard focus.")]
easing=[t("ease-out","cubic-bezier(0.23, 1, 0.32, 1)","Anything entering, and press. The default."),t("ease-in-out","cubic-bezier(0.77, 0, 0.175, 1)","Something moving from one place to another. Rare."),t("ease-drawer","cubic-bezier(0.32, 0.72, 0, 1)","A panel or sheet sliding from an edge.")]
movement=[t("press-scale","0.97","Pressed buttons and cards. 1 under reduced motion."),t("enter-scale","0.97","Dialogs and menus start here, never from 0. 1 under reduced motion."),t("enter-shift","4px","Content entering the conversation, and toasts. 0 under reduced motion."),t("stagger","40ms","Between the six concepts or three directions as results arrive. 0 under reduced motion.")]
size=[t("button-height","44px","Buttons, fields, selects, tabs."),t("button-height-sm","36px","Small buttons and icon buttons in dense rows on pointer devices; the touch target stays 44px."),t("button-padding-x","16px","Side padding of a button."),t("field-padding-x","12px","Side padding of a field."),t("control-box","20px","Checkbox and radio box; switch height."),t("chip-height","36px","Chips, inside a 44px target."),t("badge-height","24px","Badges and the tick badge."),t("icon-sm","16px","Icons inside small buttons, badges and meta lines."),t("icon-md","20px","The default icon size."),t("icon-lg","24px","Icons in empty states and message banners."),t("avatar-sm","32px","The account avatar in the navigation."),t("avatar-md","40px","Avatars in lists and menus."),t("menu-row-height","40px","Menu rows; 44px at compact width."),t("menu-min-width","200px","Minimum width of a menu."),t("table-row-height","48px","Table rows."),t("progress-height","4px","The progress bar and the range slider track."),t("dialog-width-sm","440px","Confirmation dialogs."),t("dialog-width-md","560px","Standard dialogs."),t("dialog-width-lg","860px","Media dialogs."),t("dialog-width-xl","1100px","The large brand view."),t("drawer-width-md","480px","A detail drawer."),t("drawer-width-lg","860px","A media drawer."),t("focus-ring-width","2px","Width of the focus ring and of its halo."),t("focus-ring-offset","2px","Ring offset outside a free-standing control."),t("focus-ring-inset","-2px","Ring offset inside a control that fills a clipped box."),t("pattern-dot-size","24px","Pitch of the dot grid."),t("empty-visual","56px","The round visual slot of a page empty state, holding one 24px icon.")]
fontsize=[t("font-size-1","12px","Primitive. text-caption."),t("font-size-2","13px","Primitive. text-small, text-code."),t("font-size-3","14px","Primitive. text-label."),t("font-size-4","16px","Primitive. text-body, text-title-sm."),t("font-size-5","18px","Primitive. text-body-lg."),t("font-size-6","20px","Primitive. text-title-md."),t("font-size-7","24px","Primitive. text-title-lg."),t("font-size-8","32px","Primitive. text-title-xl; the floor of text-display."),t("font-size-9","44px","Primitive. The ceiling of text-display.")]
fontweight=[t("font-weight-regular","400","Reading text."),t("font-weight-medium","500","Labels and headings."),t("font-weight-semibold","600","The Embel wordmark and emphasised numbers only.")]
tok={"name":"Embel","version":1,
 "color":{"themes":[{"id":"light","name":"Light"}],"note":"Light mode only. Primitives first, then the semantic roles that point at them; components use the roles and never a primitive.","tokens":color},
 "type":typ,
 "spacing":{"note":"4px base with two half steps. Gaps round down, padding rounds up.","tokens":spacing},
 "radius":{"note":"Six steps. Inner radius = outer radius minus the padding between them, never below radius-inset.","tokens":radius},
 "shadow":{"note":"Four levels. Selection rings and focus rings are not shadows.","tokens":shadow},
 "zIndex":{"note":"Dialogs use the browser's top layer.","tokens":zindex},
 "layout":{"note":"Breakpoints are constants, not tokens: compact below 640px, medium 640 to 1023px, wide 1024px and up.","tokens":layout},
 "size":{"note":"Component tokens: values that belong to one component.","tokens":size},
 "duration":{"note":"Only opacity and transform move; colour, border and background may fade.","tokens":duration},
 "easing":{"note":"Keywords ease and linear stay for hover fades and the spinner. Never ease-in.","tokens":easing},
 "movement":{"note":"All four become still under reduced motion; opacity feedback stays.","tokens":movement},
 "fontSize":{"note":"Primitive type steps. Use the text roles, not these.","tokens":fontsize},
 "fontWeight":{"note":"Primitive weights.","tokens":fontweight}}
names=[x['name'] for fam in tok.values() if isinstance(fam,dict) and 'tokens' in fam for x in fam['tokens']]
assert len(names)==len(set(names)), [n for n in names if names.count(n)>1]
json.dump(tok,open(S+'project/tokens.json','w'),indent=1,ensure_ascii=False)
print(len(names),'tokens')
