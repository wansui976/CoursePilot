# 主题切换按场景分流(重 DOM 瞬切)设计

日期:2026-07-08
状态:已与用户确认

## 背景与问题

打开右侧文稿(数千 DOM 节点)时切换白夜主题会明显卡顿。已排查与尝试:

- 根因:主题切换翻转 `data-theme` → 全部 CSS 令牌变化 → 整树样式重算;
  任何动画方案都在这之上加码。
- 已保留(`d624be7`):优先走 View Transitions,不支持时退回全树过渡类
  `html.theme-animating`。实测文稿打开时仍卡——形态是「点击后冻一下才切」,
  即 VT 路径的一次性成本(旧快照整屏绘制 + flushSync 同步渲染 + 全文档重算 +
  新快照整屏绘制)太重,两张全屏快照是硬成本。
- 已否决(用户撤回):文稿钉扎滞后 420ms 换色——两段式观感不能接受。

## 目标

用户选定方向:**文稿打开时瞬切,其他情况保留现有渐变。**
渐变只保留在它不伤帧率的轻场景(课程库、设置、队列、笔记 tab 等);
重 DOM 在场时直接瞬切,一次重算 + 一次绘制即理论最小成本。

## 设计决策

1. **判定约定**:引入 `data-theme-heavy` 属性标记「大 DOM 子树」。
   文稿滚动区(TranscriptPanel 的「文稿内容滚动区」)挂上它。
   theme store 只认属性、不耦合具体组件;将来笔记编辑器等大子树同法标记。
2. **可见性判定**:`el.checkVisibility()`(WKWebView/Safari 17.4+)。
   TabsPanel 非活动 tab 用 `data-[state=inactive]:hidden`(display:none)隐藏,
   checkVisibility 返回 false → 不算在场 → 渐变保留。
   引擎无 `checkVisibility` 时按「存在即算」保守处理(宁可瞬切不冒卡顿风险)。
3. **分流顺序**(`applyThemeChange`,只插一层,其余现状不动):
   reduce-motion → 瞬切(现状)
   → **可见 heavy DOM → 瞬切(新增)**
   → 支持 VT → 快照淡变(现状)
   → 否则 → 全树过渡类(现状)
4. **不设行数阈值**:空文稿时滚动区也带标记 → 也瞬切;小 DOM 瞬切无观感损失(YAGNI)。

## 改动范围

- `course-ai/src/stores/theme.ts`:新增 ~8 行 `hasVisibleHeavyDom()` +
  `applyThemeChange` 里一行分流。
- `course-ai/src/components/TranscriptPanel.tsx`:滚动区加 `data-theme-heavy` 属性。
- 无 CSS 改动。

## 测试

- `theme.test.ts`:
  - body 中存在 `[data-theme-heavy]` 元素 → toggle 瞬切:`startViewTransition`
    不被调用、无 `theme-animating` 类、`effective` 已翻转;
  - 该元素 `checkVisibility` 桩为 false → 仍走渐变(VT 被调用);
  - 现有 VT / 兜底 / reduce-motion / 无变化用例保持全绿。
- `TranscriptPanel.test.tsx`:滚动区带有 `data-theme-heavy` 属性。

## 风险

- checkVisibility 兜底为「存在即算」:极老引擎在文稿 tab 非活动时也会瞬切,
  属于可接受的保守退化(牺牲渐变,不牺牲流畅)。
