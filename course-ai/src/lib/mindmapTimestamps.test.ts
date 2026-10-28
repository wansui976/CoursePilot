import { describe, expect, it } from "vitest";
import { linkMindmapTimestamps, seekMsFromEvent, stripMindmapTimestamps } from "./mindmapTimestamps";

describe("mindmapTimestamps", () => {
  it("节点末尾的 [mm:ss] 换成可点的时间标签，没有的不动", () => {
    const root = linkMindmapTimestamps({
      content: "梯度下降",
      children: [
        { content: "学习率过大会震荡 [07:12]" },
        { content: "小批量 [1:02:03]", children: [{ content: "无时间" }] },
      ],
    });
    expect(root.content).toBe("梯度下降");
    expect(root.children[0].content).toContain('data-seek-ms="432000"');
    expect(root.children[0].content).toContain(">07:12<");
    expect(root.children[0].content).not.toContain("[07:12]");
    expect(root.children[1].content).toContain('data-seek-ms="3723000"');
    expect(root.children[1].children?.[0].content).toBe("无时间");
  });

  it("中间出现的方括号不当时间戳", () => {
    const root = linkMindmapTimestamps({ content: "区间 [0:30] 内单调" });
    expect(root.content).toBe("区间 [0:30] 内单调");
  });

  it("分享图用的 Markdown 去掉行尾时间戳", () => {
    expect(stripMindmapTimestamps("# 主题\n- 要点 [03:00]\n  - 细节 [03:20]")).toBe(
      "# 主题\n- 要点\n  - 细节",
    );
  });

  it("从点击目标读出毫秒数", () => {
    const span = document.createElement("span");
    span.setAttribute("data-seek-ms", "65000");
    const inner = document.createElement("b");
    span.appendChild(inner);
    expect(seekMsFromEvent(inner)).toBe(65000);
    expect(seekMsFromEvent(document.createElement("div"))).toBeNull();
  });
});
