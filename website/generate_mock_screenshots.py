from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parent
FONT_REGULAR = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_DISPLAY = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_MONO = "/System/Library/Fonts/SFNSMono.ttf"

PRIMARY = "#0066cc"
PRIMARY_DARK = "#2997ff"
INK = "#1d1d1f"
MUTED = "#6e6e73"
CANVAS = "#ffffff"
PARCHMENT = "#f5f5f7"
LINE = "#e4e4e8"
SOFT = "#f1f2f5"
BLACK_PANEL = "#101114"


def font(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    path = FONT_DISPLAY if weight == "display" else FONT_REGULAR
    if weight == "mono":
        path = FONT_MONO
    return ImageFont.truetype(path, size)


def rounded(draw: ImageDraw.ImageDraw, box, radius: int, fill, outline=None, width: int = 1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(draw: ImageDraw.ImageDraw, xy, value: str, size: int, fill=INK, weight: str = "regular", anchor=None):
    draw.text(xy, value, font=font(size, weight), fill=fill, anchor=anchor)


def wrap_by_width(value: str, face: ImageFont.FreeTypeFont, max_width: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for char in value:
        candidate = current + char
        if current and draw_probe.textlength(candidate, font=face) > max_width:
            lines.append(current)
            current = char
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines


draw_probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))


def wrapped_text(draw: ImageDraw.ImageDraw, xy, value: str, size: int, max_width: int, fill=INK, spacing: int = 6):
    x, y = xy
    face = font(size)
    for line in wrap_by_width(value, face, max_width):
        draw.text((x, y), line, font=font(size), fill=fill)
        y += size + spacing
    return y


def shadowed_window(size=(1180, 720), radius=18):
    w, h = size
    pad = 34
    shadow = Image.new("RGBA", (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    mask = Image.new("L", (w + pad * 2, h + pad * 2), 0)
    mdraw = ImageDraw.Draw(mask)
    mdraw.rounded_rectangle((pad, pad, pad + w, pad + h), radius=radius, fill=255)
    blur = mask.filter(ImageFilter.GaussianBlur(18))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.bitmap((3, 5), blur, fill=(0, 0, 0, 56))
    window = Image.new("RGBA", (w, h), CANVAS)
    shadow.alpha_composite(window, (pad, pad))
    return shadow


def draw_window_chrome(draw: ImageDraw.ImageDraw, x: int, y: int, w: int):
    rounded(draw, (x, y, x + w, y + 38), 0, "#f5f5f7")
    draw.line((x, y + 38, x + w, y + 38), fill=LINE, width=1)
    for i, color in enumerate(["#ff5f57", "#febc2e", "#28c840"]):
        draw.ellipse((x + 16 + i * 20, y + 13, x + 28 + i * 20, y + 25), fill=color)


def draw_sidebar(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, mode: str):
    draw.rectangle((x, y, x + w, y + h), fill="#f6f7f9")
    draw.line((x + w, y, x + w, y + h), fill=LINE)
    text(draw, (x + 16, y + 26), "课程库" if mode == "hero" else "资料", 17, weight="display")
    cards = (
        [
            ("深度学习入门：梯度下降与反向传播", "12 个视频 · 已完成 9 个 · 8.6 小时"),
            ("B 站公开课：线性代数", "Bilibili / URL 下载 · 正在转写第 4 讲"),
            ("本地录屏：React 进阶", "本地 whisper.cpp · 离线处理"),
        ]
        if mode == "hero"
        else [
            ("课件截图", "课件 18 / 32 · 自动换页"),
            ("文稿", "1,246 句 · 本地搜索"),
            ("导出", "导出 Markdown · SRT / VTT / SVG"),
        ]
    )
    cy = y + 62
    for idx, (title, sub) in enumerate(cards):
        fill = CANVAS if idx == 0 else "#f6f7f9"
        outline = LINE if idx == 0 else "#f6f7f9"
        rounded(draw, (x + 14, cy, x + w - 14, cy + 74), 10, fill, outline)
        wrapped_text(draw, (x + 26, cy + 13), title, 13, w - 52, INK)
        text(draw, (x + 26, cy + 50), sub, 11, MUTED)
        cy += 88
    if mode == "hero":
        qy = y + h - 82
        draw.line((x + 14, qy, x + w - 14, qy), fill=LINE)
        text(draw, (x + 16, qy + 17), "处理队列 · 字幕纠错 72%", 12, MUTED)
        rounded(draw, (x + 16, qy + 42, x + w - 16, qy + 47), 99, "#e8e8ed")
        rounded(draw, (x + 16, qy + 42, x + 160, qy + 47), 99, PRIMARY)


def draw_slide(draw: ImageDraw.ImageDraw, box, title: str, body: str, pill: str):
    x1, y1, x2, y2 = box
    rounded(draw, box, 12, PARCHMENT)
    rounded(draw, (x1 + 34, y1 + 32, x1 + 148, y1 + 62), 99, "#e7f0fb")
    text(draw, (x1 + 47, y1 + 39), pill, 13, PRIMARY, weight="display")
    text(draw, (x1 + 34, y1 + 86), title, 34, weight="display")
    wrapped_text(draw, (x1 + 34, y1 + 142), body, 15, x2 - x1 - 68, "#333333")


def draw_player(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, mode: str):
    draw.rectangle((x, y, x + w, y + h), fill=BLACK_PANEL)
    head_h = 70
    draw.line((x, y + head_h, x + w, y + head_h), fill="#25262a")
    title = "06 梯度下降的直观理解" if mode == "hero" else "18 反向传播：链式法则"
    text(draw, (x + 22, y + 24), title, 18, "#ffffff", weight="display")
    badges = ["AI 概览", "字幕同步", "断点续播"] if mode == "hero" else ["截图 OCR", "课件抽取"]
    bx = x + w - 260
    for badge in badges:
        tw = int(draw.textlength(badge, font=font(12))) + 18
        rounded(draw, (bx, y + 22, bx + tw, y + 46), 99, "#16304b")
        text(draw, (bx + 9, y + 27), badge, 12, PRIMARY_DARK, weight="display")
        bx += tw + 8
    slide_w, slide_h = 520, 292
    sx = x + (w - slide_w) // 2
    sy = y + 138
    if mode == "hero":
        draw_slide(draw, (sx, sy, sx + slide_w, sy + slide_h), "梯度下降的直观理解", "每次沿着损失函数下降最快的方向迈一步，直到找到足够好的参数。", "L(θ) → min")
        caption = "“损失函数的梯度指出当前点上升最快方向，反方向就是最直接的下降路径。”"
        progress = 0.42
        left = "12:48 / 31:20"
        right = "点击字幕时间戳可跳回视频"
    else:
        draw_slide(draw, (sx, sy, sx + slide_w, sy + slide_h), "反向传播：链式法则", "从输出层向输入层逐层传递梯度，复用中间节点的局部导数。", "Screenshot OCR")
        caption = "截图已插入笔记 · OCR 识别 38 个字 · 与字幕时间点绑定"
        progress = 0.66
        left = "课件 18 / 32"
        right = "自动抽帧 · 框选截图 · 本地或阿里云 OCR"
    cy = y + h - 118
    text(draw, (x + w // 2, cy), caption, 15, "#e8e8ed", anchor="ma")
    rounded(draw, (x + 22, cy + 36, x + w - 22, cy + 41), 99, "#34363b")
    rounded(draw, (x + 22, cy + 36, x + 22 + int((w - 44) * progress), cy + 41), 99, PRIMARY_DARK)
    text(draw, (x + 22, cy + 58), left, 12, "#b8b8bd")
    text(draw, (x + w - 22, cy + 58), right, 12, "#b8b8bd", anchor="ra")


def draw_tabs(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, active: str):
    tabs = ["AI 概览", "笔记", "文稿", "课件"]
    tx = x + 18
    for tab in tabs:
        fill = INK if tab == active else MUTED
        text(draw, (tx, y + 17), tab, 14, fill, weight="display")
        if tab == active:
            draw.line((tx, y + 48, tx + 43, y + 48), fill=PRIMARY, width=3)
        tx += 68
    draw.line((x, y + 50, x + w, y + 50), fill=LINE)


def draw_card(draw, box, title, body):
    rounded(draw, box, 10, CANVAS, LINE)
    x1, y1, x2, _ = box
    text(draw, (x1 + 13, y1 + 12), title, 15, weight="display")
    wrapped_text(draw, (x1 + 13, y1 + 40), body, 13, x2 - x1 - 26, "#333333")


def draw_panel(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, mode: str):
    draw.rectangle((x, y, x + w, y + h), fill=CANVAS)
    draw.line((x, y, x, y + h), fill=LINE)
    draw_tabs(draw, x, y, w, "AI 概览" if mode == "hero" else "笔记")
    py = y + 74
    if mode == "hero":
        text(draw, (x + 18, py), "本节可复习材料", 16, weight="display")
        labels = [("章节", "6 段 · 可跳转"), ("图文笔记", "1 篇 · 已保存"), ("脑图", "14 个节点"), ("练习题", "5 道自测")]
        lx, ly = x + 18, py + 28
        for i, (a, b) in enumerate(labels):
            bx = lx + (i % 2) * 158
            by = ly + (i // 2) * 68
            rounded(draw, (bx, by, bx + 146, by + 54), 9, SOFT)
            text(draw, (bx + 10, by + 9), a, 13, weight="display")
            text(draw, (bx + 10, by + 30), b, 12, MUTED)
        draw_card(draw, (x + 18, py + 166, x + w - 18, py + 268), "为什么梯度下降有效", "损失函数的梯度指出当前点上升最快方向，反方向就是最直接的下降路径。[12:48]")
        draw_card(draw, (x + 18, py + 282, x + w - 18, py + 398), "问：学习率太大会怎样？", "每一步会越过低点，参数在谷底两侧来回跳，甚至发散。回答按句标注出处。[14:22]")
    else:
        text(draw, (x + 18, py), "图文笔记", 16, weight="display")
        draw_card(draw, (x + 18, py + 28, x + w - 18, py + 130), "反向传播的关键", "把复杂函数拆成局部计算图，沿计算图反向累乘梯度。截图已和字幕时间点绑定。[18:06]")
        draw_card(draw, (x + 18, py + 144, x + w - 18, py + 238), "文稿命中", "“链式法则让我们不用重新计算每一个参数的影响，而是复用中间节点的局部导数……” [18:06]")
        tx, ty = x + 18, py + 260
        for i, title in enumerate(["16 损失函数", "17 计算图", "18 链式法则", "19 参数更新"]):
            bx = tx + (i % 2) * 188
            by = ty + (i // 2) * 102
            rounded(draw, (bx, by, bx + 176, by + 86), 9, PARCHMENT, LINE)
            text(draw, (bx + 12, by + 14), title, 12, weight="display")
            rounded(draw, (bx + 12, by + 43, bx + 136, by + 49), 99, "#dcdce1")
            rounded(draw, (bx + 12, by + 59, bx + 108, by + 65), 99, "#dcdce1")


def render_app(mode: str, canvas_size=(1240, 780), dark=False) -> Image.Image:
    canvas = Image.new("RGBA", canvas_size, "#272729" if dark else PARCHMENT)
    win = shadowed_window()
    x = (canvas_size[0] - win.width) // 2
    y = (canvas_size[1] - win.height) // 2
    canvas.alpha_composite(win, (x, y))
    draw = ImageDraw.Draw(canvas)
    wx, wy = x + 34, y + 34
    draw_window_chrome(draw, wx, wy, 1180)
    body_y = wy + 38
    sidebar_w = 238 if mode == "hero" else 220
    panel_w = 374 if mode == "hero" else 430
    player_w = 1180 - sidebar_w - panel_w
    draw_sidebar(draw, wx, body_y, sidebar_w, 682, mode)
    draw_player(draw, wx + sidebar_w, body_y, player_w, 682, mode)
    draw_panel(draw, wx + sidebar_w + player_w, body_y, panel_w, 682, mode)
    return canvas.convert("RGB")


def render_og() -> Image.Image:
    img = Image.new("RGBA", (1200, 630), PARCHMENT)
    draw = ImageDraw.Draw(img)
    text(draw, (66, 96), "CoursePilot", 26, PRIMARY, weight="display")
    wrapped_text(draw, (66, 154), "把课程视频变成可复习资料。", 50, 420, INK, spacing=10)
    wrapped_text(draw, (66, 330), "字幕、章节、笔记、课件截图、课程问答，都围绕同一节课展开。", 22, 410, "#333333", spacing=8)
    app = render_app("hero").resize((560, 352), Image.Resampling.LANCZOS)
    img.alpha_composite(app.convert("RGBA"), (590, 154))
    return img.convert("RGB")


def main() -> None:
    render_app("hero").save(ROOT / "promo-hero.png")
    render_app("workbench", dark=True).save(ROOT / "promo-workbench.png")
    render_og().save(ROOT / "og-image.png")
    print("generated realistic mock screenshots")


if __name__ == "__main__":
    main()
