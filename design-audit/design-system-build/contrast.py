# Contrast of every pair the system paints, calculated from the values in tokens.json (WCAG 2.x relative luminance). Ratios are floored, never rounded up.
import json, re, math
import os
S=os.path.dirname(os.path.abspath(__file__))+'/out/'
T={x['name']:x['value'] for x in json.load(open(S+'project/tokens.json'))['color']['tokens']}
def resolve(n):
    v=T[n]; m=re.fullmatch(r'\{(.+)\}',v)
    return resolve(m.group(1)) if m else v
def rgb(v):
    if v.startswith('#'): return tuple(int(v[i:i+2],16) for i in (1,3,5))+(1.0,)
    m=re.fullmatch(r'rgb\((\d+) (\d+) (\d+) / ([\d.]+)\)',v); return (int(m[1]),int(m[2]),int(m[3]),float(m[4]))
def over(fg,bg):
    r,g,b,a=fg; return tuple(round(a*c+(1-a)*d) for c,d in zip((r,g,b),bg[:3]))+(1.0,)
def lum(c):
    def ch(v):
        v/=255; return v/12.92 if v<=0.04045 else ((v+0.055)/1.055)**2.4
    return 0.2126*ch(c[0])+0.7152*ch(c[1])+0.0722*ch(c[2])
def ratio(a,b):
    x,y=lum(a),lum(b); return math.floor((max(x,y)+0.05)/(min(x,y)+0.05)*100)/100
def col(x): return rgb(resolve(x)) if x in T else rgb(x)
def hexs(c): return '#%02x%02x%02x'%c[:3]
ROWS=[]; FAIL=[]
def pair(group, what, fg, bg, minimum, note=''):
    f,b=col(fg),col(bg)
    if b[3]<1: b=over(b,(255,255,255,1))
    if f[3]<1: f=over(f,b)
    r=ratio(f,b)
    if minimum is None: res='decorative'
    else:
        res='pass' if r>=minimum else 'FAIL'
        if r<minimum: FAIL.append((what,fg,bg,r,minimum))
    ROWS.append((group,what,f'`{fg}` {hexs(f)}' if fg in T else hexs(f),f'`{bg}` {hexs(b)}' if bg in T else hexs(b),r,minimum,res,note))
P,C,SU='color-bg-paper','color-bg-canvas','color-bg-sunken'
G='Text'
for t,m in [('color-text',4.5),('color-text-muted',4.5),('color-text-placeholder',4.5),('color-text-positive',4.5),('color-text-danger',4.5),('color-text-warning',4.5)]:
    for bg in (P,C,SU): pair(G,'Text on a surface',t,bg,m)
for t in ('color-text','color-text-muted'):
    for bg in ('color-bg-positive-soft','color-bg-danger-soft','color-bg-warning-soft'): pair(G,'Message body and hint on a soft fill',t,bg,4.5)
pair(G,'Positive badge and field message','color-text-positive','color-bg-positive-soft',4.5)
pair(G,'Danger badge, field message, danger button hover','color-text-danger','color-bg-danger-soft',4.5)
pair(G,'Warning badge and field message','color-text-warning','color-bg-warning-soft',4.5)
for bg in ('color-bg-hover','color-bg-selected'):
    pair(G,'Label on a hovered or selected row, chip or button','color-text',bg,4.5)
pair(G,'Unselected segment label','color-text-muted',SU,4.5)
pair(G,'Menu row while pressed; avatar button on hover','color-text','color-border',4.5,'pressed fill is neutral-200')
for bg in (P,C,SU): pair(G,'Link on hover','color-accent-hover',bg,4.5)
G='Text and icons on filled controls'
pair(G,'Primary button, current nav item, selected segment, send button','color-on-accent','color-accent',4.5)
pair(G,'The same on hover; toast action on hover','color-on-accent','color-accent-hover',4.5)
pair(G,'Danger-filled button','color-on-accent','color-bg-danger',4.5)
pair(G,'Danger-filled button on hover','color-on-accent','color-bg-danger-hover',4.5)
pair(G,'Toast and tooltip text','color-text-inverse','color-bg-inverse',4.5)
pair(G,'Tick on the selected badge and in a checked box','color-on-accent','color-accent',3)
G='Disabled (WCAG sets no minimum; house minimum 3:1)'
for bg in ('color-bg-disabled',P,C): pair(G,'Disabled label',('color-text-disabled'),bg,3)
pair(G,'Tick in a disabled checked box','color-on-accent','color-text-disabled',3)
G='Icons'
for t in ('color-icon','color-icon-muted'):
    for bg in (P,C,SU): pair(G,'Icon on a surface',t,bg,3)
pair(G,'Positive icon','color-text-positive','color-bg-positive-soft',3)
pair(G,'Danger icon','color-text-danger','color-bg-danger-soft',3)
pair(G,'Warning icon','color-text-warning','color-bg-warning-soft',3)
pair(G,'Muted icon in a neutral message or a failed image frame','color-icon-muted',SU,3)
chip_dark=over(col('chip-on-artwork-bg'),(18,18,18,1)); chip_light=over(col('chip-on-artwork-bg'),(255,255,255,1))
pair(G,'Icon on the paper chip over dark artwork (#121212)','color-icon',hexs(chip_dark),3)
pair(G,'Icon on the paper chip over white artwork','color-icon',hexs(chip_light),3)
pair(G,'The paper chip itself against dark artwork',hexs(chip_dark),'#121212',3)
pair(G,'Pressed toggle on artwork: white icon on ink','color-on-accent','color-accent',3)
G='Outlines, rings and marks'
for bg in (P,C,SU): pair(G,'Field, checkbox, radio and switch outline; slider track',('color-border-control'),bg,3)
for bg in (P,C,SU): pair(G,'Control outline on hover and focus; selected ring; checked fill','color-border-selected',bg,3)
for bg in (P,C,'color-bg-danger-soft'): pair(G,'Invalid field and outlined danger button','color-border-danger',bg,3)
for bg in (P,C,SU): pair(G,'Focus ring (ink)','focus-ring-color',bg,3)
for art in ('#121212','#030436','#7a7a7a'): pair(G,'Focus halo (paper) on artwork','focus-ring-halo',art,3,'the ink ring alone fails on dark artwork; the halo carries it')
pair(G,'Ink ring against its own halo','focus-ring-color','focus-ring-halo',3)
pair(G,'Flipped ring on an ink surface (toast)','focus-ring-halo','color-bg-inverse',3)
pair(G,'Progress bar fill against its track','color-accent','color-border',3)
pair(G,'Selected tab underline','color-border-selected',C,3)
pair(G,'Switch thumb, off','color-border-control',P,3)
G='Decorative (no minimum)'
for bg in (P,C): pair(G,'Card edge, divider, secondary button edge','color-border',bg,None)
for bg in (P,C): pair(G,'Card and chip edge on hover','color-border-strong',bg,None)
pair(G,'Edge of a danger message','color-border-danger-soft','color-bg-danger-soft',None)
pair(G,'Edge of a warning message','color-border-warning-soft','color-bg-warning-soft',None)
pair(G,'Edge of a positive message','color-border-positive-soft','color-bg-positive-soft',None)
pair(G,'Dot grid','pattern-dot-color',C,None)
for bg in (P,C): pair(G,'Skeleton fill','color-bg-skeleton',bg,None)
out=['# Contrast','','Every text/background and icon/background pair the system paints, with the outlines and rings that identify a control. Each ratio is calculated from the colour values in `tokens.json` with the WCAG 2 relative-luminance formula and floored to two decimals, so a failing value is never rounded up. Minimums are WCAG AA: 4.5:1 for text, 3:1 for icons, control outlines and focus rings.','',
     f'**Result: {sum(1 for r in ROWS if r[6]=="pass")} pairs checked against a minimum, {len(FAIL)} fail.** {sum(1 for r in ROWS if r[6]=="decorative")} decorative pairs are listed for the record.','']
cur=None
for g,what,f,b,r,m,res,note in ROWS:
    if g!=cur:
        out+=['',f'## {g}','','| Pair | Foreground | Background | Ratio | Minimum | Result |','| --- | --- | --- | --- | --- | --- |']; cur=g
    out.append(f'| {what}{" ("+note+")" if note else ""} | {f} | {b} | {r:.2f}:1 | {str(m)+":1" if m else "none"} | {res} |')
out+=['','## Rules that keep these true','','- Text the app sets on a generated brand colour picks black or white by calculated contrast.','- Status is never colour alone: every tone carries an icon or a word.','- `color-border` and `color-border-strong` never outline something a person types into or ticks; that is `color-border-control`.','- Disabled text is `color-text-disabled` on `color-bg-disabled`; a disabled control also has its reason in text beside it.','']
open(S+'project/contrast.md','w').write('\n'.join(out))
print(len(ROWS),'pairs;',len(FAIL),'fail'); print(FAIL)
for r in ROWS:
    if r[6]!='decorative' and r[5] and r[4]<r[5]+0.6: print('narrow:',r[1],r[2],r[3],r[4],r[5])
