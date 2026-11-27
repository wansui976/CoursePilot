# CoursePilot 0.4.2 / 0.4.3 宣传片

一镜到底的 2 分钟宣传片：粉笔在黑板上一笔一画写出「学而时习之」，镜头从黑板一路推进课桌、笔记、复习卡，再拉到多台设备上，最后回到黑板。整片是一个 HTML 时间轴，画面只由时间 t 决定，Playwright 逐帧截下来交给 ffmpeg。

## 目录

| 路径 | 作用 |
|---|---|
| `index.html`、`film.js`、`film.css` | 片子本身。`?aspect=16x9` / `9x16` 切画幅，`?subs=1` 叠预览字幕，`?t=12.5` 停在某一帧，`?play=1` 实时播放（只看，不用来渲染） |
| `lib/core.js` | 缓动、弹簧、伪噪声、声音事件 `cue()` |
| `lib/chalk.js` | 粉笔字：汉字按 Make Me a Hanzi 的笔顺中线描出来、笔画轮廓裁边；西文用 EMS 单线手写字体；粉尘、颗粒 |
| `lib/clawd.js` | Clawd，照 Claude Code 终端里的三行方块字拼出来 |
| `script/narration.json` | 旁白和字幕的唯一来源（时间、字幕、配音读法） |
| `script/voiceover.md`、`script/subtitles-*.srt` | 由 `node script/build-subs.mjs` 生成 |
| `render.mjs` | 逐帧渲染（多进程、180° 快门运动模糊） |
| `audio/mix.py` | 按画面事件合成音效，剪音乐，按旁白位置给音乐让出音量 |

## 出片

```bash
npm install
```

```bash
./audio/fetch-music.sh
```

```bash
node render.mjs --aspect 16x9 --fps 60 --blur 2 --out out/promo-16x9.mp4
```

```bash
python3 audio/mix.py --events out/promo-16x9.events.json --dur 120 --out out/promo-16x9
```

```bash
ffmpeg -i out/promo-16x9.mp4 -i out/promo-16x9.mix.wav -c:v copy -c:a aac -b:a 256k -shortest out/promo-16x9.final.mp4
```

竖屏把 `16x9` 换成 `9x16`。只看几张静帧：`node render.mjs --aspect 9x16 --stills 3,12.5,17 --out out/stills`。

## 素材与授权

- 音乐：Kevin MacLeod《Inspired》（incompetech.com），CC BY 4.0。发布时在简介里写：Music: "Inspired" by Kevin MacLeod (incompetech.com), licensed under CC BY 4.0。
- 汉字笔画：Make Me a Hanzi / hanzi-writer-data（Arphic Public License）。
- 手写西文：EMS Allure、EMS Readability（SIL OFL，hersheytext）。
- 字体：Noto Serif SC / Noto Sans SC（OFL）、Newsreader、Instrument Sans、JetBrains Mono（OFL）。
- Clawd 是 Anthropic 的 Claude Code 吉祥物，片中作为客串出现。
