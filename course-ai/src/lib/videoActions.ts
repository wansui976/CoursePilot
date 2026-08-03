import type { VideoListItem } from "@/lib/types";

/**
 * 这个视频能不能只重跑 AI 纠错（而不是从头抽音频、重新识别一遍）。
 *
 * 处理完成的当然可以。自带字幕的（B 站导入、本地 SRT）也可以，哪怕状态不是「已处理」
 * ——它的文稿是导入来的，重跑完整流程会把自带字幕丢掉、改用语音识别，既慢又更差。
 * `subtitle_lang` 在字幕消化完之后仍然保留，正是用来标记来源的。
 *
 * **但前提是文稿真的在库里。** 那个标记是下载完当场就写上的，早于流水线跑起来：
 * 刚导入、还没处理的视频照样带着它。只看标记的话，菜单会对着一份不存在的文稿提议
 * 「重新纠错」，点下去必然失败——而这个菜单项正是列表里唯一能触发「开始处理」的地方，
 * 于是这类视频再也动不了了。
 *
 * 单独放在这里而不是留在页面里，是为了能直接测：它是一个纯判断，也是上面那个死结的全部。
 */
export function canRecorrect(video: VideoListItem): boolean {
  if (!video.has_transcript) return false;
  return video.processed_status === "done" || !!video.subtitle_lang;
}
