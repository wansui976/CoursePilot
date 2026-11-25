import { describe, expect, it } from "vitest";
import { splitFollowups } from "./followups";

describe("splitFollowups", () => {
  it("拆出正文和追问建议，正文里不留原文", () => {
    const answer = '步子太大会震荡 [07:10]。\n\n```followups\n["学习率太小呢？","举个例子"]\n```';
    expect(splitFollowups(answer)).toEqual({
      text: "步子太大会震荡 [07:10]。",
      followups: ["学习率太小呢？", "举个例子"],
    });
  });

  it("没写完或 JSON 坏了只是没有按钮，正文照常", () => {
    expect(splitFollowups('正文\n```followups\n["半句')).toEqual({ text: "正文", followups: [] });
    expect(splitFollowups("正文\n```followups\n{坏}\n```")).toEqual({ text: "正文", followups: [] });
  });

  it("流式时末尾写了一半的围栏先藏起来，别的代码块不动", () => {
    expect(splitFollowups("正文\n```fol").text).toBe("正文");
    expect(splitFollowups("正文\n``").text).toBe("正文");
    expect(splitFollowups("```python\nprint(1)\n```").text).toBe("```python\nprint(1)\n```");
  });

  it("去重、去掉太长的、最多三条", () => {
    const long = "这".repeat(41);
    const block = JSON.stringify(["a", "a", long, "b", "c", "d"]);
    expect(splitFollowups(`x\n\`\`\`followups\n${block}\n\`\`\``).followups).toEqual(["a", "b", "c"]);
  });

  it("回答以行内代码结尾时不剪掉收尾的反引号", () => {
    expect(splitFollowups("运行 `git status`").text).toBe("运行 `git status`");
    expect(splitFollowups("结论：`O(n)`").text).toBe("结论：`O(n)`");
  });
});
