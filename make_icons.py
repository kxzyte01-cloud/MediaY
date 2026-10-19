# Used by the build: "before" draws missing icon files, "after" puts them into the Android project.
import glob, os, re, sys
from PIL import Image, ImageDraw

RED = (240, 25, 37, 255)
WHITE = (255, 255, 255, 255)
PTS = [(105, 100), (205, 100), (256, 205), (307, 100), (407, 100),
       (286, 300), (286, 412), (226, 412), (226, 300)]


def make(name, size, pad, rounded):
    if os.path.exists(name):
        return
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.2, fill=RED)
    else:
        d.rectangle([0, 0, size, size], fill=RED)
    k = size * (1 - 2 * pad) / 512.0
    o = size * pad
    d.polygon([(o + x * k, o + y * k) for x, y in PTS], fill=WHITE)
    img.save(name)


def create():
    make('icon-192.png', 192, 0.0, True)
    make('icon-512.png', 512, 0.0, True)
    make('icon-maskable-512.png', 512, 0.12, False)


def apply():
    res = 'android/app/src/main/res'
    for p in glob.glob(res + '/mipmap-*/ic_launcher*.png'):
        fg = 'foreground' in os.path.basename(p)
        src = 'icon-maskable-512.png' if fg else 'icon-512.png'
        size = Image.open(p).size
        Image.open(src).convert('RGBA').resize(size, Image.LANCZOS).save(p)
    for p in glob.glob(res + '/drawable*/splash.png'):
        w, h = Image.open(p).size
        img = Image.new('RGBA', (w, h), RED)
        s = int(min(w, h) * 0.4)
        logo = Image.open('icon-512.png').convert('RGBA').resize((s, s), Image.LANCZOS)
        img.paste(logo, ((w - s) // 2, (h - s) // 2), logo)
        img.save(p)
    bg = res + '/values/ic_launcher_background.xml'
    if os.path.exists(bg):
        text = open(bg).read()
        open(bg, 'w').write(re.sub('#ffffff', '#F01925', text, flags=re.I))


if __name__ == '__main__':
    mode = sys.argv[1] if len(sys.argv) > 1 else 'before'
    create() if mode == 'before' else apply()
