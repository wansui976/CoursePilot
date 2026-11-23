#!/usr/bin/env python3
"""生成 AppIcon.icns：紫蓝渐变圆角方块 + 白色星标 + 下载徽章。"""
import math
import os
import shutil
import subprocess

from PIL import Image, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_ICNS = os.path.join(HERE, "AppIcon.icns")
ICONSET = os.path.join(HERE, "build", "AppIcon.iconset")


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def gradient(size, top_left, bottom_right):
    img = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(img)
    for y in range(size):
        for_x = y / (size - 1)
        for x in range(size):
            t = (x / (size - 1) * 0.35) + (for_x * 0.65)
            d.point((x, y), lerp(top_left, bottom_right, t))
    return img


def star_points(cx, cy, outer, inner, n=5, rotation=-math.pi / 2):
    pts = []
    for i in range(n * 2):
        r = outer if i % 2 == 0 else inner
        a = rotation + i * math.pi / n
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def main():
    # 背景渐变
    bg = gradient(S, (124, 90, 255), (40, 120, 255)).convert("RGBA")

    # 圆角遮罩（Big Sur 比例）
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    inset = 92
    md.rounded_rectangle([inset, inset, S - inset, S - inset], radius=188, fill=255)
    icon = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)

    # 顶部高光
    gloss = Image.new("L", (S, S), 0)
    gd = ImageDraw.Draw(gloss)
    gd.ellipse([inset - 40, inset - 300, S - inset + 40, inset + 420], fill=64)
    gloss = gloss.filter(ImageFilter.GaussianBlur(60))
    white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
    icon = Image.composite(white, icon, Image.composite(gloss, Image.new("L", (S, S), 0), mask))

    d = ImageDraw.Draw(icon, "RGBA")

    # 阴影层：星标
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.polygon(star_points(470, 468, 250, 104), fill=(20, 10, 60, 110))
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    icon = Image.alpha_composite(icon, shadow)
    d = ImageDraw.Draw(icon, "RGBA")

    # 白色星标
    d.polygon(star_points(470, 452, 250, 104), fill=(255, 255, 255, 255))

    # 下载徽章
    bx, by, br = 690, 690, 210
    bshadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bshadow)
    bd.ellipse([bx - br, by - br + 12, bx + br, by + br + 12], fill=(15, 8, 50, 120))
    bshadow = bshadow.filter(ImageFilter.GaussianBlur(28))
    icon = Image.alpha_composite(icon, bshadow)
    d = ImageDraw.Draw(icon, "RGBA")
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(255, 255, 255, 255))

    # 徽章里的箭头
    arrow = (86, 74, 220, 255)
    d.rounded_rectangle([bx - 26, by - 118, bx + 26, by + 12], radius=26, fill=arrow)
    d.polygon(
        [(bx - 92, by - 4), (bx + 92, by - 4), (bx, by + 108)],
        fill=arrow,
    )

    # 输出 iconset
    if os.path.isdir(ICONSET):
        shutil.rmtree(ICONSET)
    os.makedirs(ICONSET)
    for base in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = base * scale
            name = f"icon_{base}x{base}{'@2x' if scale == 2 else ''}.png"
            icon.resize((px, px), Image.LANCZOS).save(os.path.join(ICONSET, name))

    subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", OUT_ICNS], check=True)
    icon.resize((512, 512), Image.LANCZOS).save(os.path.join(HERE, "build", "icon-512.png"))
    print("wrote", OUT_ICNS)


if __name__ == "__main__":
    main()
