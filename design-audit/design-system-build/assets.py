# Prepares the image assets the previews use: real generated artwork from the audit's two showcase test
# brands, resized to WebP, and the Embel mark with its embedded metadata removed. Needs Pillow.
# The files it writes (out/assets/) are what was uploaded to the artifact; assets.json maps each to its upload id.
import os, re
from PIL import Image
HERE=os.path.dirname(os.path.abspath(__file__))+'/'
REPO=os.path.abspath(HERE+'../..')+'/'
OUT=HERE+'out/assets/'
SHOW=REPO+'design-audit/seed/showcase/'
os.makedirs(OUT+'Showcase',exist_ok=True); os.makedirs(OUT+'Logos',exist_ok=True)
LOGOS={'kestrel-logo-1':'kestrel/refine-1','kestrel-logo-2':'kestrel/logo-29765c495e','kestrel-logo-3':'kestrel/logo-3f172ca6c0','kestrel-logo-4':'kestrel/logo-5ac49439dc',
       'kestrel-logo-5':'kestrel/logo-cefcd00541','kestrel-logo-6':'kestrel/logo-79aff6360a','orchardlane-logo':'orchardlane/logo-771e726ead'}
for name,src in LOGOS.items():
    Image.open(SHOW+src+'.png').convert('RGBA').resize((640,640),Image.LANCZOS).save(OUT+'Showcase/'+name+'.webp','WEBP',quality=80,method=6)
for i in (1,2,3):
    Image.open(SHOW+f'kestrel/board-{i}.png').convert('RGB').save(OUT+f'Showcase/kestrel-direction-{i}.webp','WEBP',quality=82,method=6)
svg=open(REPO+'public/embel-mark.svg').read()
paths=''.join(re.findall(r'<path d="[^"]+"/>',svg))
open(OUT+'Logos/embel-mark.svg','w').write('<svg xmlns="http://www.w3.org/2000/svg" width="1276" height="1276" viewBox="0 0 1276 1276">'+paths+'</svg>\n')
print('assets written to', OUT)
