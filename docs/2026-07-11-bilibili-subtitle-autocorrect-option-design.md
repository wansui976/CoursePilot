# B站导入「字幕 AI 纠错」选项 设计

日期：2026-07-11 · 状态：已批准

## 背景

B站导入已支持下载自带字幕并消化成文稿；字幕 AI 纠错已存在但只由全局设置 `subtitle_autocorrect` 控制，导入时不可见。本功能把选择权搬进导入对话框，且只影响本次导入的视频。

## 规格

- **迁移 0012**：`ALTER TABLE videos ADD COLUMN subtitle_autocorrect BOOLEAN`（NULL = 跟随全局设置）。`Video` 结构体与前端类型加 `subtitle_autocorrect: Option<bool>`。
- **`cmd_import_bilibili`** 新参数 `subtitle_autocorrect: Option<bool>`；下载成功建行后写入。前端只在带字幕导入时传值，不带字幕传 `undefined`。
- **流水线纠错门槛**（pipeline/mod.rs 字幕分支）：取值顺序改为 视频级 `subtitle_autocorrect` → NULL 回落全局设置（默认 true）→ 再要求有可用 LLM。视频后续「重新处理」同样按此偏好。
- **对话框 UI**（确认步骤，仅当检测到字幕轨时显示，随字幕区隐藏）：字幕下拉框下方加勾选「下载后用 AI 纠错字幕」，默认值读全局设置；灰字提示「未配置大模型时将跳过纠错」。勾选框不因 LLM 未配置而禁用（与流水线静默降级一致）。
- 全局设置开关保留，仅作默认值。

## 测试

- Rust：新列可写读（Video 结构体往返）；纠错 gate 优先级——视频 false + 全局 true → 不纠错；视频 true + 全局 false → 纠错；视频 NULL → 跟随全局。
- 前端：勾选默认值来自 `settings.get("subtitle_autocorrect")`；导入调用把勾选值传给 `ipc.tools.importBilibili`；无字幕轨时不渲染勾选框。
