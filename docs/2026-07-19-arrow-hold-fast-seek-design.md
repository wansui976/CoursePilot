# 方向键长按快进/快退（B 站式）

日期：2026-07-19
状态：已批准（用户：「左右方向键改成像 bilibili 那样的按下就快进，停下就正常播放」）

## 现状

←/→ 绑定 seekBack/seekForward，每次 keydown 立即 ±5s；按住靠系统连发，
一格一格跳，不是连续快进。

## 目标行为（对齐 B 站）

- **短按 →**：+5s；**短按 ←**：-5s。触发时机移到 keyup（需要区分长短按）。
- **长按 →**（≥300ms）：进入 3 倍速播放（暂停中则先播放），浮层提示
  「3x 快进中」；松开恢复原倍速、浮层消失。
- **长按 ←**：连续快退扫描（每 200ms 回退 0.8s，播放中净速率约 -3x），
  浮层提示「快退中」；松开恢复正常播放。
- 忽略系统 auto-repeat 的 keydown；一次只允许一个方向键处于长按流程，
  另一个按下忽略。窗口失焦（keyup 丢失）时取消扫描并恢复倍速、不补 seek。
- 改键后依旧生效：逻辑挂在 seekBack/seekForward 动作上，不写死 Arrow 键。
- J/L（上/下一句字幕）等其它快捷键行为不变（keydown 即时触发）。

## 实现

- `index.tsx` 键盘 effect：seekBack/seekForward 分支改为「记录按下 + 300ms
  定时器」；定时器触发 = 进入扫描（→ 设 playbackRate=3；← 起 interval）。
  新增 keyup / blur 监听结束流程：engaged → 恢复；未 engaged 且是 keyup →
  执行原 ±5s。
- 浮层复用 gestureHint：union 加 `rate`（3x 快进中）与 `rewind`（快退中），
  长按期间常驻、松开清除。
- 设置页快捷键条目 hint 注明「长按 3 倍速快进 / 长按连续快退」。

## 测试（index.test.tsx，fake timers）

- 短按 → 松开 = +5s，且不改倍速。
- 长按 → 300ms 后倍速变 3、显示「3x 快进中」；keyup 恢复原倍速、无 +5s。
- 长按 ← 引擎周期性回退 currentTime；keyup 停止。
