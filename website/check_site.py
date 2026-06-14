from pathlib import Path


root = Path(__file__).resolve().parent
html = (root / "index.html").read_text(encoding="utf-8")
studio = (root / "screenshot-studio.html").read_text(encoding="utf-8")
generator = (root / "generate_mock_screenshots.py").read_text(encoding="utf-8")

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
    "gsap@3.13",
    "ScrollTrigger.min.js",
    "DOMContentLoaded",
    "class=\"aurora\"",
    "auroraDrift",
    "coursepilot-intro-played",
    "playHeroIntro",
    "hero-word",
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

studio_required_text = [
    "真实 UI 截图工作室",
    "深度学习入门：梯度下降与反向传播",
    "损失函数的梯度指出当前点上升最快方向",
    "课件 18 / 32",
    "本节可复习材料",
    "回答按句标注出处",
    "导出 Markdown",
]

studio_missing = [text for text in studio_required_text if text not in studio]
if studio_missing:
    raise SystemExit(f"Missing screenshot studio mock data: {studio_missing}")

generator_required_text = [
    "generated realistic screenshots from real CoursePilot UI",
    "real-screenshots",
    "ai-overview.png",
    "notes.png",
    "promo-hero.png",
    "promo-workbench.png",
    "og-image.png",
]

generator_missing = [text for text in generator_required_text if text not in generator]
if generator_missing:
    raise SystemExit(f"Missing screenshot generator content: {generator_missing}")

for source in ["ai-overview.png", "notes.png", "quiz.png", "mindmap.png", "transcript.png", "qa.png"]:
    path = root / "real-screenshots" / source
    if not path.exists() or path.stat().st_size < 10_000:
        raise SystemExit(f"Missing or tiny real screenshot source: {source}")
    if path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"Real screenshot source is not a PNG file: {source}")

for asset in ["promo-hero.png", "promo-workbench.png", "og-image.png"]:
    path = root / asset
    if not path.exists() or path.stat().st_size < 10_000:
        raise SystemExit(f"Missing or tiny generated asset: {asset}")
    if path.read_bytes()[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"Generated asset is not a PNG file: {asset}")

print("site checks passed")
