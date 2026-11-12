import os, re, json
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
DS=HERE+'out/'; P=DS+'project/'
PV_CSS='''
.pv{padding:var(--space-6);display:grid;gap:var(--space-10);align-content:start}
.pv-sec{display:grid;gap:var(--space-4);min-width:0}
.pv-h{font:var(--text-title-sm);letter-spacing:var(--tracking-title-sm)}
.pv-note{font:var(--text-small);color:var(--color-text-muted);max-width:var(--measure)}
.pv-grid{display:grid;gap:var(--space-6);grid-template-columns:repeat(auto-fill,minmax(var(--pv-min,160px),1fr));align-items:start}
.pv-grid--wide{--pv-min:280px}
.pv-grid--narrow{--pv-min:120px}
.pv-grid--one{grid-template-columns:minmax(0,1fr)}
.pv-cell{display:grid;gap:var(--space-2);justify-items:start;align-content:start;min-width:0}
.pv-cell--stretch{justify-items:stretch}
.pv-label{font:var(--text-caption);letter-spacing:var(--tracking-caption);color:var(--color-text-muted)}
.pv-paper{background:var(--color-bg-paper);border:1px solid var(--color-border);border-radius:var(--radius-card);padding:var(--space-6)}
.pv-stage{display:grid;place-items:center;padding:var(--space-8) var(--space-4);border-radius:var(--radius-card);background:var(--color-bg-scrim)}
.pv-stage--end{justify-items:end;padding:0;overflow:hidden}
.pv-stage .e-dialog,.pv-stage .e-drawer{max-height:none}
.pv-art{position:relative;display:flex;flex-wrap:wrap;gap:var(--space-4);padding:var(--space-6);border-radius:var(--radius-card);background-size:cover;background-position:center}
.pv-row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3)}
.pv-fit{width:100%;max-width:var(--pv-fit,360px)}
'''
def ic(n, cls=''):
    return f'<span class="e-icon {cls}" data-icon="{n}" aria-hidden="true"></span>'.replace('class="e-icon "','class="e-icon"')
def cell(label, html, stretch=False):
    return f'<div class="pv-cell{" pv-cell--stretch" if stretch else ""}"><span class="pv-label">{label}</span>{html}</div>'
def grid(*cells, cls=''):
    return f'<div class="pv-grid {cls}">'+''.join(cells)+'</div>'
def sec(title, *html, note=''):
    return f'<section class="pv-sec"><h2 class="pv-h">{title}</h2>'+(f'<p class="pv-note">{note}</p>' if note else '')+''.join(html)+'</section>'
STATES6=[('Default',''),('Hover','hover'),('Focus-visible','focus'),('Active','active')]
def force(f): return f' data-force="{f}"' if f else ''
REG={}
def write(name, group, body, readme, height=200, width=None, page=False, css='', script='', subtitle='', bodycls='pv'):
    attrs=f'group="{group}" height={height}'
    if width: attrs+=f' width={width}'
    if page: attrs+=' page'
    if subtitle: attrs+=f' subtitle="{subtitle}"'
    html=f'''<!-- @dsCard {attrs} -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{name}</title>
<style>{PV_CSS if bodycls=='pv' else ''}{css}</style>
</head>
<body class="{bodycls}">
{body}
{('<script>'+script+'</script>') if script else ''}
</body>
</html>
'''
    assert '<iframe' not in html and '<object' not in html
    REG[name]={'group':group,'html':html,'readme':readme,'width':width,'page':page}
def flush(assetmap=None, heights=None):
    """Write all registered previews. assetmap: name -> url for {{img:name}}."""
    for name,r in REG.items():
        d=P+f'components/{name}/'; os.makedirs(d,exist_ok=True)
        html=r['html']
        if heights and name in heights:
            html=re.sub(r'height=\d+', f'height={heights[name]}', html, count=1)
        if assetmap is not None:
            def rep(m):
                k=m.group(1); assert k in assetmap, k; return assetmap[k]
            html=re.sub(r'\{\{img:([a-z0-9-]+)\}\}', rep, html)
        assert len(html.encode())<256*1024, (name,len(html))
        open(d+'preview.html','w').write(html)
        if r['readme']: open(d+'README.md','w').write(r['readme'].strip()+'\n')
