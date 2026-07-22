# #3 批量导入（本地文件夹 + 网络播放列表）

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 复用处理队列 / ImportVideoDialog

## 现状

导入是单条的：`ipc.videos.addLocal(courseId, path, durationMs)` 一次一个本地文件；
`BilibiliImportDialog` 一次探测+下载一个链接。但课程本质是**系列**——建一门
30 集的课要重复 30 次。处理队列（`processing_jobs` / jobs.rs）已存在，可承载批量。

## 目标

- **A. 本地文件夹批量导入**（零成本、最自然：课程本来就是文件夹）。
- **B. 网络播放列表/合集批量导入**（B站合集/多P、YouTube 播放列表）。

## A. 本地文件夹

- 后端：`cmd_scan_folder(dir) -> [{path, name, durationMs}]`（枚举视频扩展名，
  自然序排序），`cmd_add_local_batch(courseId, paths[])`（循环复用现有 addLocal 逻辑）。
- UI：ImportVideoButton 菜单加「导入整个文件夹」→ 选目录 → 勾选清单（默认全选、
  可排序）→ 导入，order_index 跟清单顺序。
- 去重：跳过已导入（按 `videos.file_path`）。

## B. 网络播放列表

- 枚举：`yt-dlp --flat-playlist` 先拉清单，不下载正片。
  `cmd_probe_playlist(url) -> {title, episodes:[{id,title,durationMs,thumb}]}`。
- UI：探测后显示带缩略图/时长的勾选列表；合集标题预填课程名（可新建课程或加入
  现有课程）；**批量默认项**：把原确认步骤的清晰度/字幕语言/纠错开关提升为整批默认。
- 入队：勾选项逐个进处理队列，**并发 N**（可配），失败重试；队列里逐集显示状态
  （下载中/处理中/完成/失败）。
- 部分失败照常继续：会员/地区限制的集子标记跳过、汇报（复用 relink 的
  missing/ambiguous 汇报模式），不因一集失败中断整批。
- cookie/风控：复用现有 `hasBilibiliCookies` 引导与 412 处理。

## 数据

无新表。`videos.source_uri` 已存来源，可加「同源去重」查询。可选 `import_batches`
表记录批次以便「重试整批失败项」，非必需。

## 分阶段

- **P1**（已完成）：本地文件夹批量导入（纯复用 addLocal，后端风险最低）。
- **P2**（已完成）：播放列表枚举（`probe_playlist`/`parse_playlist_json`，yt-dlp
  `--flat-playlist`）+ 勾选清单 + 批量默认项（清晰度/字幕/纠错）+ 逐集下载入库并处理，
  部分失败不中断、末尾汇总。各集复用 `cmd_import_bilibili`。见 `PlaylistImportDialog`。
- **P3**：并发下载、失败重试、逐集状态；可选懒下载（先存元数据，打开再下）。

## 测试

- 后端：`cmd_scan_folder` 正确枚举+排序+滤非视频；`cmd_add_local_batch` 去重。
- 前端：文件夹清单勾选/取消后导入调用次数正确；播放列表探测渲染清单；
  部分失败时其余项仍入队且失败项被汇报。
