import sys, json, importlib, os
sys.path.insert(0, os.path.dirname(__file__))
import build, pv
build.build_css()
os.makedirs(pv.DS+'local',exist_ok=True)
open(pv.DS+'local/tokens.css','w').write(build.tokens_css(lambda f:'file://'+pv.P+f))
A=json.load(open(pv.HERE+'assets.json'))
amap={k:'/_blob/'+v[2] for k,v in A.items()}
for m in sys.argv[1].split(','):
    importlib.import_module(m)
heights={}
hp=pv.DS+'local/heights.json'
if os.path.exists(hp): heights=json.load(open(hp))
pv.flush(amap, heights)
json.dump({n:{'width':r['width'],'page':r['page']} for n,r in pv.REG.items()}, open(pv.DS+'local/reg.json','w'))
print(len(pv.REG),'previews')
