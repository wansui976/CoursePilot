import { describe, expect, it } from "vitest";
import { canRecorrect } from "./videoActions";
import type { VideoListItem } from "@/lib/types";

function video(over: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id: "v1",
    course_id: "c1",
    title: "第一讲",
    source_type: "bilibili",
    source_uri: null,
    file_path: "/v.mp4",
    duration_ms: 1000,
    width: null,
    height: null,
    order_index: 0,
    data_dir: "/data",
    processed_status: "pending",
    created_at: 0,
    has_transcript: false,
    ...over,
  };
}

describe("canRecorrect", () => {
  it("刚导入、还没处理的自带字幕视频不能纠错", () => {
    // 真实场景：B 站带字幕导入完成，状态还是「待处理」，一句文稿都没有。字幕标记是
    // 下载完当场写上的，只看它的话菜单会给出「重新纠错」——点下去必然失败，而这一项
    // 又是列表里唯一能触发「开始处理」的地方，视频就此卡死，怎么点都动不了。
    expect(canRecorrect(video({ subtitle_lang: "zh-Hans" }))).toBe(false);
  });

  it("字幕消化进库之后才可以只重跑纠错", () => {
    // 这类视频状态不一定是「已处理」（比如后续步骤失败，或处理中途取消过），
    // 但它的文稿是导入来的，重跑完整流程会丢掉自带字幕改用语音识别，既慢又更差。
    expect(
      canRecorrect(video({ subtitle_lang: "zh-Hans", has_transcript: true })),
    ).toBe(true);
  });

  it("处理完成的视频可以纠错", () => {
    expect(canRecorrect(video({ processed_status: "done", has_transcript: true }))).toBe(
      true,
    );
  });

  it("既没有文稿也没有字幕标记的，只能从头处理", () => {
    expect(canRecorrect(video())).toBe(false);
    // 状态写着已处理但库里没有文稿（处理失败后状态没回滚等）也一样：没得可纠。
    expect(canRecorrect(video({ processed_status: "done" }))).toBe(false);
  });
});
