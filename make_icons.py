#!/usr/bin/env python3
"""Generate and install MediaY's neon cyan-violet-magenta aperture launcher icons."""
import glob
import os
import re
import sys
from PIL import Image, ImageDraw

BACKGROUND = (11, 15, 25, 255)


def render_cyber_icon(size: int, maskable: bool = False) -> Image.Image:
    scale_up = 4
    width = size * scale_up
    image = Image.new("RGBA", (width, width), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image, "RGBA")

    pad = 0 if maskable else int(width * 0.04)
    radius = 0 if maskable else int(width * 0.235)
    draw.rounded_rectangle(
        [pad, pad, width - 1 - pad, width - 1 - pad],
        radius=radius,
        fill=BACKGROUND,
    )

    if not maskable:
        rim_width = max(2, int(width * 0.024))
        draw.rounded_rectangle(
            [pad + rim_width // 2, pad + rim_width // 2,
             width - 1 - pad - rim_width // 2, width - 1 - pad - rim_width // 2],
            radius=radius - rim_width // 2,
            outline=(0, 240, 255, 210),
            width=rim_width,
        )

    mark_scale = 0.78 if maskable else 1.0

    def point(x: float, y: float):
        x = (x - 32.0) * mark_scale + 32.0
        y = (y - 32.0) * mark_scale + 32.0
        return (x / 64.0 * width, y / 64.0 * width)

    cx, cy = point(32, 33)
    for radius64, color, opacity, thickness in (
        (18.5, (139, 92, 246), 110, 0.015),
        (16.0, (148, 163, 184), 90, 0.018),
        (13.2, (0, 240, 255), 75, 0.012),
    ):
        radius_px = radius64 * mark_scale / 64.0 * width
        draw.ellipse(
            [cx - radius_px, cy - radius_px, cx + radius_px, cy + radius_px],
            outline=(*color, opacity),
            width=max(1, int(width * thickness)),
        )

    # Cyan left aperture wing.
    draw.polygon([point(12, 15), point(22, 15), point(26.5, 27), point(12, 21)], fill=(0, 215, 245, 255))
    draw.polygon([point(22, 15), point(32, 27.5), point(26.5, 27)], fill=(125, 211, 252, 255))
    draw.polygon([point(12, 21), point(26.5, 27), point(25.5, 35.5)], fill=(2, 132, 199, 255))

    # Magenta right aperture wing.
    draw.polygon([point(52, 15), point(42, 15), point(37.5, 27), point(52, 21)], fill=(255, 42, 133, 255))
    draw.polygon([point(42, 15), point(32, 27.5), point(37.5, 27)], fill=(244, 114, 182, 255))
    draw.polygon([point(52, 21), point(37.5, 27), point(38.5, 35.5)], fill=(147, 51, 234, 255))

    # Faceted stem and neon edge highlights.
    draw.polygon([point(25.5, 35.5), point(32, 39), point(32, 54), point(25.5, 47.5)], fill=(14, 165, 233, 255))
    draw.polygon([point(38.5, 35.5), point(32, 39), point(32, 54), point(38.5, 47.5)], fill=(168, 85, 247, 255))
    draw.line([point(32, 38.5), point(32, 53.5)], fill=(255, 120, 200, 255), width=max(2, int(width * 0.022)))
    line_width = max(2, int(width * 0.02))
    draw.line([point(22, 15), point(12, 15), point(12, 21), point(25.5, 35.5), point(25.5, 47.5), point(32, 54)], fill=(0, 245, 255, 255), width=line_width)
    draw.line([point(42, 15), point(52, 15), point(52, 21), point(38.5, 35.5), point(38.5, 47.5), point(32, 54)], fill=(255, 42, 133, 255), width=line_width)

    # Dark play chamber and bright play prism.
    draw.polygon([point(25.5, 23.5), point(40.5, 32), point(25.5, 40.5)], fill=(8, 12, 21, 255), outline=(139, 92, 246, 180))
    draw.polygon([point(27.8, 26.5), point(37.5, 32), point(27.8, 37.5)], fill=(255, 255, 255, 255))
    return image.resize((size, size), Image.Resampling.LANCZOS)


def create():
    # Always regenerate so an APK cannot silently package stale legacy red icons.
    render_cyber_icon(192, maskable=False).save("icon-192.png", "PNG", optimize=True)
    render_cyber_icon(512, maskable=False).save("icon-512.png", "PNG", optimize=True)
    render_cyber_icon(512, maskable=True).save("icon-maskable-512.png", "PNG", optimize=True)
    print("Generated updated MediaY neon icons.")


def apply():
    # Preserve the existing Android resource installation step used by built.yml.
    resources = "android/app/src/main/res"
    for path in glob.glob(resources + "/mipmap-*/ic_launcher*.png"):
        foreground = "foreground" in os.path.basename(path)
        source = "icon-maskable-512.png" if foreground else "icon-512.png"
        size = Image.open(path).size
        Image.open(source).convert("RGBA").resize(size, Image.Resampling.LANCZOS).save(path)

    for path in glob.glob(resources + "/drawable*/splash.png"):
        width, height = Image.open(path).size
        image = Image.new("RGBA", (width, height), BACKGROUND)
        side = int(min(width, height) * 0.4)
        logo = Image.open("icon-512.png").convert("RGBA").resize((side, side), Image.Resampling.LANCZOS)
        image.paste(logo, ((width - side) // 2, (height - side) // 2), logo)
        image.save(path)

    background_xml = resources + "/values/ic_launcher_background.xml"
    if os.path.exists(background_xml):
        with open(background_xml, encoding="utf-8") as file:
            source = file.read()
        with open(background_xml, "w", encoding="utf-8") as file:
            file.write(re.sub(r"#[0-9a-fA-F]{6}", "#0B0F19", source, count=1))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "before"
    create() if mode == "before" else apply()
