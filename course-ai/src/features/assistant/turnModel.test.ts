import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { bracketBareTimestamps, formatElapsed, withoutInlineSeeks } from "./turnModel";
import { matchSlashCommands, slashQuery, type SlashCommand } from "./slashCommands";

describe("bracketBareTimestamps", () => {
  it("把裸写的时间点补成可点的方括号形式", () => {
    expect(bracketBareTimestamps("出现在 11:04，停留到 12:30。")).toBe(
      "出现在 [11:04]，停留到 [12:30]。",
    );
    expect(bracketBareTimestamps("1. 03:00 讲梯度方向")).toBe("1. [03:00] 讲梯度方向");
    expect(bracketBareTimestamps("见 1:02:03")).toBe("见 [1:02:03]");
    expect(bracketBareTimestamps("11:04–12:30")).toBe("[11:04]–[12:30]");
  });

  it("已经带方括号的、比分比例、超出时钟范围的都不动", () => {
    expect(bracketBareTimestamps("见 [11:04] 和 [1:02:03]")).toBe("见 [11:04] 和 [1:02:03]");
    expect(bracketBareTimestamps("比分 3:2，比例 16:9")).toBe("比分 3:2，比例 16:9");
    expect(bracketBareTimestamps("12:75")).toBe("12:75");
    expect(bracketBareTimestamps("123:45")).toBe("123:45");
  });
});

describe("formatElapsed", () => {
  const t = i18n.getFixedT("zh-CN");
  it("十秒内带一位小数，再长到秒，过一分钟换成分秒", () => {
    expect(formatElapsed(4_230, t)).toBe("用时 4.2 秒");
    expect(formatElapsed(23_400, t)).toBe("用时 23 秒");
    expect(formatElapsed(65_000, t)).toBe("用时 1 分 05 秒");
  });
});

describe("slash commands", () => {
  const command = (keyword: string, aliases: string[]): SlashCommand => ({
    id: keyword,
    keyword,
    aliases,
    label: keyword,
    description: "",
  });
  const commands = [command("总结", ["summary", "zj"]), command("出题", ["quiz", "ct"])];

  it("只有整段输入是「/词」时才算在打指令", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/出")).toBe("出");
    expect(slashQuery("/出 题")).toBeNull();
    expect(slashQuery("问 /出题")).toBeNull();
  });

  it("按关键词、英文和拼音首字母前缀匹配", () => {
    expect(matchSlashCommands(commands, "").map((c) => c.id)).toEqual(["总结", "出题"]);
    expect(matchSlashCommands(commands, "出").map((c) => c.id)).toEqual(["出题"]);
    expect(matchSlashCommands(commands, "QU").map((c) => c.id)).toEqual(["出题"]);
    expect(matchSlashCommands(commands, "zj").map((c) => c.id)).toEqual(["总结"]);
    expect(matchSlashCommands(commands, "xyz")).toEqual([]);
  });
});

describe("withoutInlineSeeks", () => {
  const seek = (at_ms: number) => ({ kind: "seek_to" as const, at_ms });
  const open = { kind: "open_video" as const, video_id: "v", at_ms: 430_000 };

  it("正文里已有同一时间点（差一秒以内）就收掉跳转按钮", () => {
    expect(withoutInlineSeeks([seek(430_600)], "越过谷底 [07:10]。")).toEqual([]);
    expect(withoutInlineSeeks([seek(431_200)], "见 [07:10]")).toEqual([]);
    expect(withoutInlineSeeks([seek(3_723_000)], "在 [1:02:03] 讲过")).toEqual([]);
  });

  it("正文没提到的时间点和打开视频照常保留", () => {
    expect(withoutInlineSeeks([seek(90_000), open], "见 [07:10]")).toEqual([seek(90_000), open]);
    expect(withoutInlineSeeks([seek(430_000)], "没有时间戳")).toEqual([seek(430_000)]);
  });
});
