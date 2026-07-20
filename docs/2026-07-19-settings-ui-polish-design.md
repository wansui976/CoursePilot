# 设置界面打磨：5 缺陷修复 + 3 项改进

日期：2026-07-19
状态：已批准（用户指示「提出改进建议并改进」，自动完成）

## 背景

审查 `SettingsDialog.tsx` / `LlmSettingsPanel.tsx` / `WhisperModelsPanel.tsx`。
整体结构（macOS 风分组卡片、侧栏分类、窄屏下钻）是好的；问题集中在
「保存反馈」与个别表单细节。

## 缺陷修复

### D1 即时保存静默失败

`changeAsrBackend/changeAsrLanguage/changeModel/changeAliyunModel/
changeOcrBackend/changeOcrType/changeSubtitleAutocorrect/
changeCorrectionConcurrency/pickRoot` 全部 `await ipc.settings.set` 无
错误处理：写库失败时界面显示新值、实际没存，还留下 unhandled
rejection。（火山「热词与上下文」处曾修过同类问题。）

**方案**：`saveSetting(key, value)` 统一入口——成功清除错误，失败
`setSaveError` 在详情区顶部显示红色错误条（复用 ErrorNote 风格文案
「设置保存失败」+ 原始错误）。

### D2 存储根目录无法清空

脚注写「留空 = 跟视频同目录的 .courseai/」但没有清空手段。
**方案**：root 非空时在「选择」旁给「清除」按钮，写空串并回显「未设置」。

### D3 LLM「删除此配置」无确认

**方案**：`confirm`（plugin-dialog，与删视频/课程一致）：
`删除配置「{name}」？`；按钮文字色改 `--status-err` 底色 hover。

### D4 并发数显示与存储脱节

输入非法值（0/空/2500+）时 state 保留原文、保存静默跳过。
**方案**：onBlur 归一化：有限数夹到 [1,2500] 取整并保存；无效输入
回退默认 8。onChange 行为不变（合法即存）。

### D5 LLM 面板输入框 placeholder-only

名称 / Base URL / 模型名 / API Key 四个输入框加 `aria-label`。

## 改进

### I1 字幕纠错换 Switch

新 `ui/switch.tsx`：`role="switch"` + `aria-checked`、44px 触摸区、
主题 token（开=--accent，关=--surface-card-hover），150ms transform
过渡。设置里「导入字幕后用 AI 纠错」改用它。

### I2 Whisper 模型显示体积

`size_bytes` 一直没用：行内模型名后追加灰字体积（GB/MB 一位小数）。

### I3 凭证保存统一失败反馈

火山凭证 / 百炼 Key / OCR 凭证 / LLM 配置四个保存 handler 补
try/catch → `SavedBadge` 失败态（已支持含「失败」文案显红），保存
期间按钮 disabled 防连点。

## 测试

- SettingsDialog：清除存储根目录；并发 blur 归一化；识别语言保存失败
  显示错误条；字幕纠错 switch 切换写库；凭证保存失败显示红徽标。
- LlmSettingsPanel（新测试文件）：删除需确认（取消则不删）；输入框
  aria-label 可查；保存失败显示失败徽标。
- WhisperModelsPanel（新测试文件）：显示模型体积。
