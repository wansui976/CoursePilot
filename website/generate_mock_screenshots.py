from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
REAL = ROOT / "real-screenshots"
PARCHMENT = "#f5f5f7"
TILE = "#272729"
INK = "#1d1d1f"
PRIMARY = "#0066cc"
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def face(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT, size)


def cover(image: Image.Image, size: tuple[int, int]) -> Image.Image:
    image = image.convert("RGB")
    scale = max(size[0] / image.width, size[1] / image.height)
    resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    left = (resized.width - size[0]) // 2
    top = (resized.height - size[1]) // 2
    return resized.crop((left, top, left + size[0], top + size[1]))


def contain(image: Image.Image, max_size: tuple[int, int]) -> Image.Image:
    image = image.convert("RGB")
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
    rounded.paste(image.convert("RGBA"), (0, 0), rounded_mask)

    canvas.alpha_composite(shadow, (x - 40, y - 40))
    canvas.alpha_composite(rounded, (x, y))


def promo_from_real(source_name: str, output_name: str, background: str) -> None:
    source = Image.open(REAL / source_name)
    canvas = Image.new("RGBA", (1240, 780), background)
    shot = contain(source, (1100, 650))
    paste_with_shadow(canvas, shot, ((canvas.width - shot.width) // 2, (canvas.height - shot.height) // 2), radius=20)
    canvas.convert("RGB").save(ROOT / output_name)


def render_og() -> None:
    canvas = Image.new("RGBA", (1200, 630), PARCHMENT)
    draw = ImageDraw.Draw(canvas)
    draw.text((66, 92), "CoursePilot", font=face(28), fill=PRIMARY)
    draw.text((66, 156), "把课程视频变成", font=face(46), fill=INK)
    draw.text((66, 216), "可复习资料。", font=face(46), fill=INK)
    draw.text((66, 348), "真实工作台截图：AI 概览、图文笔记、", font=face(20), fill="#333333")
    draw.text((66, 382), "脑图、出题和课程问答。", font=face(20), fill="#333333")

    overview = contain(Image.open(REAL / "ai-overview.png"), (510, 292))
    notes = contain(Image.open(REAL / "notes.png"), (388, 222))
    paste_with_shadow(canvas, overview, (632, 96), radius=18)
    paste_with_shadow(canvas, notes, (740, 344), radius=18)
    canvas.convert("RGB").save(ROOT / "og-image.png")


def main() -> None:
    required = [
        "ai-overview.png",
        "notes.png",
        "quiz.png",
        "mindmap.png",
        "transcript.png",
        "qa.png",
    ]
    missing = [name for name in required if not (REAL / name).exists()]
    if missing:
        raise SystemExit(f"missing real screenshots: {missing}")

    promo_from_real("ai-overview.png", "promo-hero.png", PARCHMENT)
    promo_from_real("notes.png", "promo-workbench.png", TILE)
    render_og()
    print("generated realistic screenshots from real CoursePilot UI")


if __name__ == "__main__":
    main()
