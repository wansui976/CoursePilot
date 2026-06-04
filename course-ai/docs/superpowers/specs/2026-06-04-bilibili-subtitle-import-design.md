# B站自带字幕导入 — 设计稿

日期：2026-06-04
状态：已确认，待写实现计划

## 背景与目标

导入 B站视频时，若该视频自带字幕（UP 主手打的 CC 字幕，或 B站 AI 字幕
`ai-zh`），应让用户选择**直接是否使用该字幕作为文稿**，而不是重新做语音转写
（ASR）。字幕本身带时间轴，质量通常不差于本地 ASR，且省去转写耗时与算力。
若视频没有自带字幕，则回退到用户已配置的「抽音频 + ASR」方式。

字幕本质是「另一种来源的文稿」，因此采用**方案 A**：让字幕在现有流水线的 ASR
阶段内消化（替换掉转写这一步），后续的「AI 纠错 / 笔记 / 摘要 / 出题」等链路
全部复用，不另开旁路。

## 关键技术约束

- B站自带字幕走播放器接口，**绝大多数情况下需要登录态（cookie）才能列出和
  下载**，AI 字幕尤其如此。因此交互上**先引导用户配置 cookie，再探测字幕**；
  没 cookie 时往往连「有没有字幕」都探测不到。
- cookie 对视频下载本身也有用（不登录很多视频被限到 360/480p）。已有
  `bilibili_cookies` 设置项（存 cookies.txt 路径，下载时传给 `yt-dlp --cookies`），
  本特性与之共用。
- cookie 由用户用浏览器扩展 **Get cookies.txt LOCALLY** 在 bilibili.com 导出
  cookies.txt（Netscape 格式），桌面应用无法代为安装扩展，只能给说明 + 文件选择器。

## 交互流程（导入向导）

现有「下载网络视频」是个小 popover，容不下多步流程，升级为分步对话框
`BilibiliImportDialog`：

1. **粘贴链接** → 「下一步」。
2. **cookie 引导**（仅当未配置 cookie 时）：说明用 *Get cookies.txt LOCALLY*
   导出 cookies.txt 的步骤 + 「选择 cookies.txt」文件选择器。选中后把文件复制进
   appdata（稳定路径），写入 `bilibili_cookies` 设置。
3. **探测**：后端用 cookie 跑 `yt-dlp -J`，拿到标题 + 字幕轨列表 + 可选清晰度档位。
4. **确认页**（一屏，含两组选择）：
   - **清晰度**：列出探测到的可选档位（如 1080P / 720P / 480P / 360P，外加
     「最高可用」），默认预选最高可用。实际可达档位受 cookie 登录态影响，故以
     带 cookie 探测的结果为准。
   - **字幕**：
     - **探到字幕** → 列出可选轨（如 `ai-zh` / `zh-Hans`），默认按「手打CC优先 >
       AI字幕 > 其它」预选，问「检测到自带字幕，用它替代 AI 转写？」
       → [使用所选字幕] / [不用，走语音转写]。
     - **没探到** → 提示「未检测到自带字幕，将用语音转写」。
5. 确认后按所选清晰度（+ 可选字幕）触发下载 + 入库 + 跑流水线。

## 后端：探测 + 下载（`pipeline/download.rs`）

- 新增 `probe(url, cookies) -> ProbeResult { title, tracks: Vec<SubtitleTrack>,
  qualities: Vec<u32> }`：跑 `yt-dlp -J --skip-download`，解析输出 JSON：
  - `subtitles` map（B站 AI/CC 字幕都在此）→ 每轨产出 `SubtitleTrack { lang,
    name, auto }`。
  - `formats` 数组的 `height` → 去重降序得 `qualities`（如 `[1080, 720, 480, 360]`）。
  JSON 解析为纯函数，单测覆盖。
- 新增 `pick_default_track(tracks) -> Option<&SubtitleTrack>`：优选规则
  手打中文 CC（`zh-Hans`/`zh-CN`/`zh`，非 auto）> AI 中文（`ai-zh`）> 第一条。
- `build_ytdlp_args` 增参 `max_height: Option<u32>`：给定时加
  `-f "bv*[height<=H]+ba/b[height<=H]"` 选档；`None`（最高可用）则不加、用 yt-dlp
  默认取最优。
- 下载分支：
  - **用字幕**：再加 `--write-subs --sub-langs <lang> --convert-subs srt`，一趟把
    mp4 + 字幕文件落到课程目录。yt-dlp 落地的字幕命名为 `<title>.<lang>.srt`
    （例：`example.ai-zh.srt`）。
  - **不用字幕**：仅按清晰度下载。
- 下载后定位到落地的 mp4 与（若有）`<title>.<lang>.srt` 路径回传。

## 字幕解析（`pipeline/subtitle.rs`）

- 新增 `parse_srt(text) -> Vec<SubSegment { start_ms, end_ms, text }>`，纯函数。
  覆盖标准时间轴 `00:00:01,200 --> 00:00:03,400`、多行文本、空行分隔、
  不规范/缺失项的容错。统一用 srt（`--convert-subs srt`），免去多格式适配。
- 复用写库：把 `pipeline/asr.rs::store_transcripts` 抽出接受通用段落的
  `store_segments`，whisper 与字幕共用。同样存一份 `transcript_backups`，
  `source` 记 `bilibili_sub`。

## 流水线改动（`pipeline/mod.rs`，方案 A）

- `run_all` 的 ASR 阶段开头判断：video 是否有**待用字幕文件**（`subtitle_path`
  非空且文件存在）？
  - 有 → 读取 srt → `parse_srt` → `store_segments` → **跳过 whisper/云 ASR**，
    job 信息标注「来源：B站字幕」；消化后清空 `subtitle_path`（保留
    `subtitle_lang` 作来源展示，避免重复导入）。
  - 无 → 现状不变（按 `asr_backend` 走 whisper/volcengine/aliyun）。
- 之后照常进入「AI 纠错」阶段，**受设置 `subtitle_autocorrect` 控制**（仅对字幕
  来源生效；ASR 来源仍按原逻辑纠错）。

## 数据模型

新迁移 `0008_subtitle.sql`：

```sql
ALTER TABLE videos ADD COLUMN subtitle_path TEXT;   -- 待用字幕文件绝对路径
ALTER TABLE videos ADD COLUMN subtitle_lang TEXT;   -- 轨道语言（ai-zh / zh-Hans…）
```

导入时若用字幕则写这两列；ASR 阶段消化字幕后将 `subtitle_path` 置空、保留
`subtitle_lang`。

## 设置项

- `bilibili_cookies`（已有，存 cookies.txt 路径，复用）。
- 新增 `subtitle_autocorrect`（默认 `true`）：导入字幕后是否走 AI 纠错。
  放进设置页「转写 / 纠错」区。

## 命令 / IPC

- 新 `cmd_probe_bilibili(course_id, url) -> ProbeResult`：确保 cookie 后探测字幕轨
  与可选清晰度。
- 改 `cmd_import_bilibili`：增参「选用字幕轨 lang（可空）」与「清晰度 max_height
  （可空=最高可用）」。选了字幕则带 `--write-subs` 下载并写 `subtitle_path`/
  `subtitle_lang`；清晰度透传给 `build_ytdlp_args`。
- 新 `cmd_set_bilibili_cookies(file_path)`：复制 cookies.txt 进 appdata 并写设置。
- 前端 `ipc.tools.*` 增对应封装；`BilibiliImportDialog` 调用之。

## 测试

- `parse_srt`：标准 / 多行 / 空行 / 不规范时间轴的容错。
- `probe` JSON 解析：B站 `-J` 样例（含 `subtitles` 多轨 + `formats` 多档 `height`）
  → 轨列表 + 清晰度降序去重；无字幕样例 → 空轨。
- `pick_default_track`：CC > AI > 其它的优选。
- `build_ytdlp_args`：带 `--write-subs --sub-langs` 分支；带 `max_height` 时含
  `-f "bv*[height<=H]+ba/b[height<=H]"`，`None` 时不含 `-f`。
- 流水线：mock 一个带 `subtitle_path` 的 video → 走解析分支、不调 whisper、写入文稿。

## 范围 / YAGNI

- **只做 B站**：机制通用，但 UI/文案只针对 B站，YouTube 等暂不做。
- 不做字幕在线预览/编辑（导入后用现有文稿面板即可）。
- 不做多轨合并，只用单轨。

## 不在本特性内（后续单独 spec）

- 用 [modelscope/FunASR](https://github.com/modelscope/FunASR) 替换本地 whisper.cpp
  —— 涉及 Python 运行时 / 打包方式的根本性改动，单列一份 spec 处理。
