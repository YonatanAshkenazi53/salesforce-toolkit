"""frames → GIF:  py -3 scripts/dev/logo/frames2gif.py <folder> <prefix> <out.gif> [x0 y0 x1 y1]"""
import sys, glob
from PIL import Image
folder, prefix, out = sys.argv[1], sys.argv[2], sys.argv[3]
box = tuple(int(v) for v in sys.argv[4:8]) if len(sys.argv) >= 8 else None
files = sorted(glob.glob(f'{folder}/{prefix}-*.png'))
frames = []
for f in files:
    im = Image.open(f).convert('RGB')
    if box: im = im.crop(box)
    frames.append(im.quantize(colors=128, method=Image.MEDIANCUT))
assert frames, 'no frames'
frames[0].save(out, save_all=True, append_images=frames[1:], duration=110, loop=0, optimize=True)
print(len(frames), 'frames ->', out)
