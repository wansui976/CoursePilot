from pathlib import Path


root = Path(__file__).resolve().parent
html = (root / "index.html").read_text(encoding="utf-8")

required_text = [
    "课程视频学习工作台",
    "Bilibili / URL 下载",
    "本地 whisper.cpp",
    "截图 OCR",
    "回答按句标注出处",
    "prompt caching",
    "data-animate",
    "data-parallax",
    "IntersectionObserver",
    "prefers-reduced-motion",
    "is-visible",
    "nav-scrolled",
    "promo-hero.png",
    "promo-workbench.png",
    "og-image.png",
]

missing = [text for text in required_text if text not in html]
if missing:
    raise SystemExit(f"Missing required page copy/assets: {missing}")

if html.count("var(--primary)") < 8:
    raise SystemExit("Expected page to use the single Action Blue design token throughout")

if html.count("data-animate") < 12:
    raise SystemExit("Expected restrained scroll reveal hooks across product page sections")

if html.count("data-parallax") < 2:
    raise SystemExit("Expected subtle parallax hooks on primary product shots")

if "matchMedia(\"(prefers-reduced-motion: reduce)\")" not in html:
    raise SystemExit("Expected JavaScript to respect reduced motion preferences")

for asset in ["promo-hero.png", "promo-workbench.png", "og-image.png"]:
    path = root / asset
    if not path.exists() or path.stat().st_size < 10_000:
        raise SystemExit(f"Missing or tiny generated asset: {asset}")
    if path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"Generated asset is not a PNG file: {asset}")

print("site checks passed")
