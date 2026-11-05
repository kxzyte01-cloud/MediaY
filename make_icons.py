#!/usr/bin/env python3
"""Generate MediaY launcher icons from the selected Neon Aperture Y mark."""
import glob
import os
import re
import sys
from PIL import Image, ImageDraw

BACKGROUND = (8, 13, 24, 255)
CYAN = (0, 231, 242, 255)
BLUE = (22, 139, 255, 255)
VIOLET = (139, 92, 246, 255)
WHITE = (243, 247, 255, 255)


def render_icon(size: int, maskable: bool = False) -> Image.Image:
    scale = 4
    side = size * scale
    image = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")
    pad = 0 if maskable else int(side * .035)
    radius = 0 if maskable else int(side * .22)
    draw.rounded_rectangle((pad, pad, side-pad-1, side-pad-1), radius=radius, fill=BACKGROUND)
    if not maskable:
        draw.rounded_rectangle((pad+2, pad+2, side-pad-3, side-pad-3),
                               radius=max(1, radius-2), outline=CYAN, width=max(2, side//180))
    # Leave safe space for Android's adaptive-icon mask.
    factor = .78 if maskable else .88
    def p(x, y):
        x = 64 + (x-64)*factor
        y = 64 + (y-64)*factor
        return (int(x/128*side), int(y/128*side))
    def poly(points, fill, outline=None):
        draw.polygon([p(x,y) for x,y in points], fill=fill, outline=outline)
    # Y arms: cyan left and porcelain-white right.
    poly([(13,12),(36,12),(58,49),(48,62),(27,38)], CYAN)
    poly([(115,12),(92,12),(70,49),(80,62),(101,38)], WHITE)
    # Segmented cuts on the left arm.
    poly([(20,25),(38,25),(42,32),(24,32)], BACKGROUND)
    poly([(28,39),(46,39),(50,46),(32,46)], BACKGROUND)
    # Circular camera aperture with violet ring and cyan inner edge.
    cx, cy = p(64,52)
    rad = int(26/128*side*factor)
    draw.ellipse((cx-rad,cy-rad,cx+rad,cy+rad), fill=(15,18,43,255), outline=VIOLET, width=max(3,side//42))
    inner = int(20/128*side*factor)
    draw.ellipse((cx-inner,cy-inner,cx+inner,cy+inner), outline=CYAN, width=max(2,side//100))
    # Six shutter blades, all meeting around a small dark iris.
    poly([(64,32),(79,40),(75,54),(62,56),(52,43)], CYAN)
    poly([(79,40),(85,53),(75,66),(65,55),(75,54)], VIOLET)
    poly([(85,53),(78,68),(63,72),(64,57),(75,66)], (105,65,210,255))
    poly([(78,68),(63,72),(50,63),(62,54),(63,72)], BLUE)
    poly([(50,63),(44,50),(52,37),(62,49),(62,54)], CYAN)
    poly([(44,50),(52,37),(64,32),(62,49),(52,54)], (47,124,245,255))
    iris = int(5/128*side*factor)
    draw.ellipse((cx-iris,cy-iris,cx+iris,cy+iris), fill=BACKGROUND)
    # Stem and restrained timeline tracks.
    poly([(49,73),(64,79),(79,73),(75,120),(53,120)], BLUE)
    draw.line([p(64,80),p(64,119)], fill=WHITE, width=max(2,side//150))
    poly([(8,92),(42,92),(42,99),(8,99)], CYAN)
    poly([(8,105),(42,105),(42,109),(8,109)], BLUE)
    poly([(86,92),(120,92),(120,99),(86,99)], VIOLET)
    poly([(86,105),(120,105),(120,109),(86,109)], (105,65,210,255))
    return image.resize((size,size), Image.Resampling.LANCZOS)


def create():
    render_icon(192).save("icon-192.png", "PNG", optimize=True)
    render_icon(512).save("icon-512.png", "PNG", optimize=True)
    render_icon(512, maskable=True).save("icon-maskable-512.png", "PNG", optimize=True)
    print("Generated selected MediaY Neon Aperture icons.")


def apply():
    resources = "android/app/src/main/res"
    for path in glob.glob(resources + "/mipmap-*/ic_launcher*.png"):
        foreground = "foreground" in os.path.basename(path)
        source = "icon-maskable-512.png" if foreground else "icon-512.png"
        with Image.open(source) as icon:
            size = Image.open(path).size
            icon.convert("RGBA").resize(size, Image.Resampling.LANCZOS).save(path)
    for path in glob.glob(resources + "/drawable*/splash.png"):
        with Image.open(path) as old:
            width, height = old.size
        image = Image.new("RGBA", (width, height), BACKGROUND)
        side = int(min(width, height) * .4)
        with Image.open("icon-512.png") as icon:
            logo = icon.convert("RGBA").resize((side, side), Image.Resampling.LANCZOS)
        image.paste(logo, ((width-side)//2,(height-side)//2), logo)
        image.save(path)
    background_xml = resources + "/values/ic_launcher_background.xml"
    if os.path.exists(background_xml):
        with open(background_xml, encoding="utf-8") as f:
            source = f.read()
        with open(background_xml, "w", encoding="utf-8") as f:
            f.write(re.sub(r"#[0-9a-fA-F]{6}", "#080D18", source, count=1))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "before"
    create() if mode == "before" else apply()
