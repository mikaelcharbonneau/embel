import re, json, os, shutil, urllib.parse
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
DS=HERE+'out/'; P=DS+'project/'
NM=HERE+'node_modules/'
LUC=NM+'lucide-static/icons/'
REPO=os.path.abspath(HERE+'../..')+'/'
ICONS=['house','folder','library','images','image','image-off','plus','minus','search','arrow-right','arrow-left','arrow-up','arrow-down','arrow-up-down','chevron-down','chevron-right','chevron-left','chevron-up','check','x','ellipsis','trash-2','pencil','refresh-cw','rotate-ccw','undo-2','mic','heart','eye','eye-off','download','copy','maximize-2','external-link','info','triangle-alert','circle-alert','circle-check','lock','wifi-off','square','settings','log-out','user','clock','sliders-horizontal','layers','palette','type','file-text','link','credit-card','upload','columns-2','zap']
def svg_uri(inner, sw='1.5'):
    s=f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='{sw}' stroke-linecap='round' stroke-linejoin='round'>{inner}</svg>"
    return 'url("data:image/svg+xml,'+urllib.parse.quote(s, safe="/:=' ")+'")'
def lucide(n):
    s=open(LUC+n+'.svg').read()
    inner=re.search(r'<svg[^>]*>(.*)</svg>',s,re.S).group(1)
    return re.sub(r'\s+',' ',inner).strip().replace('"',"'")
def icons_css():
    out=['/* ---------- Icons: Lucide (ISC licence), 24px grid, 1.5 stroke, drawn as masks so they take the text colour ---------- */']
    for n in ICONS:
        assert os.path.exists(LUC+n+'.svg'), n
        out.append(f'.e-icon[data-icon="{n}"] {{ --icon: {svg_uri(lucide(n))}; }}')
    mark=open(REPO+'public/embel-mark.svg').read()
    paths=''.join(re.findall(r'<path d="[^"]+"/>',mark)).replace('"',"'")
    m="<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1276 1276'>"+paths+"</svg>"
    out.append(':root { --icon-check-bold: '+svg_uri(lucide('check'),'2.5')+'; --icon-minus-bold: '+svg_uri(lucide('minus'),'2.5')+'; --embel-mark: url("data:image/svg+xml,'+urllib.parse.quote(m, safe="/:=' ")+'"); }')
    return '\n'.join(out)
def expand(css):
    out=[]; pos=0
    # top-level rules containing macros: selector { body } with no nested braces
    pat=re.compile(r'([^{}@;]+?)\{([^{}]*)\}')
    def repl(m):
        sel=m.group(1).strip(); body=m.group(2)
        kinds=[k for k in ('hover','active','focus','within') if ':'+k+'!' in sel]
        if not kinds: return m.group(0)
        assert len(kinds)==1, sel
        k=kinds[0]; forced=sel.replace(':'+k+'!','[data-force~="'+('focus' if k=='within' else k)+'"]')
        real=sel.replace(':'+k+'!',{'hover':':hover','active':':active','focus':':focus-visible','within':':has(:focus-visible)'}[k])
        if k=='hover':
            return f'@media (hover: hover) and (pointer: fine) {{ {real} {{{body}}} }}\n{forced} {{{body}}}'
        return f'{real}, {forced} {{{body}}}'
    return pat.sub(repl, css)
def build_css():
    src=open(HERE+'bundle.css.src').read()
    css=expand(src)+'\n\n'+icons_css()+'\n'
    assert '!' not in re.sub(r'/\*.*?\*/','',css,flags=re.S).replace('!important',''), [l for l in css.split('\n') if '!' in l and '/*' not in l][:5]
    assert '</style' not in css.lower()
    os.makedirs(P+'components',exist_ok=True); os.makedirs(P+'fonts',exist_ok=True)
    # the two font files, copied from the fontsource packages (SIL Open Font License)
    shutil.copyfile(NM+'@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', P+'fonts/Geist-Variable.woff2')
    shutil.copyfile(NM+'@fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2', P+'fonts/InstrumentSans-Variable.woff2')
    open(P+'components/bundle.css','w').write(css)
    js=open(HERE+'bundle.src.js').read(); assert '</script' not in js and '<!--' not in js
    open(P+'components/bundle.js','w').write(js)
    return len(css)
def tokens_css(fonturl=lambda f:'../'+f):
    t=json.load(open(P+'tokens.json'))
    first=t['color']['themes'][0]['id']
    def cv(v):
        v=v if isinstance(v,str) else v[first]
        m=re.fullmatch(r'\{(.+)\}',v)
        return f'var(--{m.group(1)})' if m else v
    L=['/* '+t['name']+' — generated from tokens.json */']
    L.append(f':root, [data-theme="{first}"] {{')
    for x in t['color']['tokens']: L.append(f"  --{x['name']}: {cv(x['value'])};")
    for x in t['shadow']['tokens']: L.append(f"  --{x['name']}: {x['value']};")
    L.append('}'); L.append(':root {')
    for fam,v in t.items():
        if fam in ('color','type','shadow') or not isinstance(v,dict) or 'tokens' not in v: continue
        for x in v['tokens']: L.append(f"  --{x['name']}: {x['value']};")
    for k,v in t['type']['families'].items(): L.append(f'  --font-{k}: {v};')
    L.append('}')
    for g in t['type']['groups']:
        for s in g['styles']:
            fam=s.get('family',g['family']); lh=s['lineHeight']
            L.append(f".{s['name']} {{ font-family: var(--font-{fam}); font-size: {s['fontSize']}; line-height: {lh}; font-weight: {s['fontWeight']}; letter-spacing: {s.get('letterSpacing','0')}; }}")
    for f in t['type']['fonts']:
        L.append(f"@font-face {{ font-family: \"{f['family']}\"; src: url(\"{fonturl(f['file'])}\"); font-weight: {f['weight']}; font-style: {f.get('style','normal')}; font-display: swap; }}")
    return '\n'.join(L)
if __name__=='__main__':
    n=build_css()
    os.makedirs(DS+'local',exist_ok=True)
    open(DS+'local/tokens.css','w').write(tokens_css(lambda f:'file://'+P+f))
    print('bundle.css',n,'bytes')
