/** 工作台布局的尺寸约定与判断（组件文件只导出组件，热更新才不受影响）。 */

export const STUDY_PANEL_MIN = 384;
export const PLAYER_MIN_WIDTH = 320;
/** 分隔线在网格里只占 1px（拖动热区是向两侧伸出的透明伪元素，不占列宽）。 */
export const STUDY_RESIZER_WIDTH = 1;

/** 学习面板自身宽到这个程度（平板竖屏、窄桌面窗口），笔记就单独占右半边常驻。 */
export const SPLIT_NOTES_MIN_WIDTH = 720;

/** 播放器与学习面板左右分栏，还是上下叠放。 */
export function isWideWorkbench(shellWide: boolean, availableWidth: number): boolean {
  return shellWide && availableWidth >= STUDY_PANEL_MIN + PLAYER_MIN_WIDTH + STUDY_RESIZER_WIDTH;
}

/**
 * 学习面板能否分成左右两栏（左边标签页、右边笔记常驻）。只在播放器与面板不并排的布局里
 * 考虑；够不够宽由面板量自己（见 TabsPanel）——手机横屏时面板只占半屏，按整个应用的宽度
 * 判断会把四百来像素的面板再劈成两半。
 */
export function allowsNotesSplit(shellWide: boolean, availableWidth: number): boolean {
  return !isWideWorkbench(shellWide, availableWidth);
}
