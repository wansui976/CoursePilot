from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
SHOTS = ROOT / "screenshots"
PARCHMENT = "#f5f5f7"
TILE = "#272729"
INK = "#1d1d1f"
PRIMARY = "#0066cc"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def face(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def contain(image: Image.Image, max_size: tuple[int, int]) -> Image.Image:
    image = image.convert("RGBA")
    scale = min(max_size[0] / image.width, max_size[1] / image.height)
    return image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)


def paste_with_shadow(canvas: Image.Image, image: Image.Image, xy: tuple[int, int], radius: int = 28) -> None:
    x, y = xy
    shadow = Image.new("RGBA", (image.width + 80, image.height + 80), (0, 0, 0, 0))
    mask = Image.new("L", shadow.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((40, 40, 40 + image.width, 40 + image.height), radius=radius, fill=255)
    blurred = mask.filter(ImageFilter.GaussianBlur(22))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.bitmap((4, 8), blurred, fill=(0, 0, 0, 55))

    rounded = Image.new("RGBA", image.size, (0, 0, 0, 0))
    rounded_mask = Image.new("L", image.size, 0)
    rounded_draw = ImageDraw.Draw(rounded_mask)
    rounded_draw.rounded_rectangle((0, 0, image.width, image.height), radius=radius, fill=255)
    rounded.paste(image, (0, 0), rounded_mask)

    canvas.alpha_composite(shadow, (x - 40, y - 40))
    canvas.alpha_composite(rounded, (x, y))


def promo(source_name: str, output_name: str, background: str) -> None:
    canvas = Image.new("RGBA", (1240, 780), background)
    shot = contain(Image.open(SHOTS / source_name), (1100, 690))
    paste_with_shadow(canvas, shot, ((canvas.width - shot.width) // 2, (canvas.height - shot.height) // 2), radius=20)
    canvas.convert("RGB").save(ROOT / output_name)


def render_og() -> None:
    canvas = Image.new("RGBA", (1200, 630), PARCHMENT)
    draw = ImageDraw.Draw(canvas)
    draw.text((66, 92), "CoursePilot", font=face(28), fill=PRIMARY)
    draw.text((66, 156), "把课程视频变成", font=face(46), fill=INK)
    draw.text((66, 216), "真正记得住的东西。", font=face(46), fill=INK)
    draw.text((66, 348), "字幕、笔记、脑图、课件 OCR、练习题，", font=face(20), fill="#333333")
    draw.text((66, 382), "再加上带出处的课程问答和间隔复习。", font=face(20), fill="#333333")
    draw.text((66, 520), "开源 · 本地优先 · macOS / Windows / iOS / Android", font=face(18), fill="#6e6e73")

    overview = contain(Image.open(SHOTS / "workbench-overview.webp"), (540, 340))
    mindmap = contain(Image.open(SHOTS / "mindmap.webp"), (400, 252))
    paste_with_shadow(canvas, overview, (610, 80), radius=14)
    paste_with_shadow(canvas, mindmap, (740, 330), radius=14)
    canvas.convert("RGB").save(ROOT / "og-image.png")


def main() -> None:
    required = ["workbench-overview.webp", "slides.webp", "mindmap.webp"]
    missing = [name for name in required if not (SHOTS / name).exists()]
    if missing:
        raise SystemExit(f"missing screenshots: {missing}")

    promo("workbench-overview.webp", "promo-hero.png", PARCHMENT)
    promo("slides.webp", "promo-workbench.png", TILE)
    render_og()
    print("generated promo images from real CoursePilot screenshots")


if __name__ == "__main__":
    main()
