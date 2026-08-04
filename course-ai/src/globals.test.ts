import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/globals.css"), "utf8");

describe("强调色令牌的用法约束", () => {
  it("前景色一律用 --accent-text，不用 --accent", () => {
    // --accent 是实心块的底色。它在暗色主题里刻意保持原值，白字才压得住；
    // --accent-text 才是随主题走的前景变体（暗色下会变亮）。
    // 拿 --accent 当图标/文字色，在近黑底上只有 3.7:1，而且与页面别处的强调蓝
    // 明显不是同一个颜色——左栏选中项、底部选中页签、空态图标一度全踩了这个坑。
    const misuse = [
      ...css.matchAll(
        /^[ \t]*(?:color|-webkit-text-fill-color):\s*var\(--accent\)\s*;/gm,
      ),
    ].map((match) => match[0].trim());

    expect(misuse).toEqual([]);
  });

  it("--accent-text 在两套主题下都有值", () => {
    // 上一条把前景都指向了 --accent-text；它若只在亮色下定义，等于把问题挪了个地方。
    const light = css.match(/^:root\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";
    const dark = css.match(/^\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";

    expect(light).toMatch(/--accent-text:/);
    expect(dark).toMatch(/--accent-text:/);
  });
});

describe("动效的实现约束", () => {
  /** 取出所有 @keyframes 块（名字 -> 块内声明的属性集合）。 */
  function keyframeProperties() {
    const out = new Map<string, Set<string>>();
    const header = /@keyframes\s+([\w-]+)\s*\{/g;
    for (let match = header.exec(css); match; match = header.exec(css)) {
      let index = match.index + match[0].length;
      let depth = 1;
      while (depth > 0 && index < css.length) {
        if (css[index] === "{") depth += 1;
        else if (css[index] === "}") depth -= 1;
        index += 1;
      }
      const body = css.slice(match.index + match[0].length, index - 1);
      const properties = new Set(
        [...body.matchAll(/^[ \t]*([a-z-]+)[ \t]*:/gm)].map((line) => line[1]),
      );
      out.set(match[1], properties);
    }
    return out;
  }

  it("关键帧只动合成器扛得住的属性", () => {
    // 动 width/height/top/margin 这类会让浏览器每帧重排整棵子树——列表长一点就掉帧。
    // transform / opacity / clip-path 走合成，与布局无关，长文稿页面上也稳。
    const allowed = new Set([
      "transform",
      "opacity",
      "clip-path",
      "visibility",
      "animation-timing-function",
    ]);

    const offenders: string[] = [];
    for (const [name, properties] of keyframeProperties()) {
      for (const property of properties) {
        if (!allowed.has(property)) offenders.push(`${name}: ${property}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("减少动效的全局兜底还在，且过渡与动画都关得掉", () => {
    // 真正保护前庭敏感用户的是这一块：无限循环的打字点、主题圆形揭开这些没有单独
    // 包 no-preference 的动画，全靠它压平。它一旦被删，整个应用的动效就再也关不掉了，
    // 而这种缺失在开发机上永远看不出来——开发者的系统通常没开「减少动态效果」。
    const reduce =
      css.match(
        /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\}\n/m,
      )?.[0] ?? "";

    expect(reduce).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    expect(reduce).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
    expect(reduce).toMatch(/animation-iteration-count:\s*1\s*!important/);
    // 这里刻意不断言「圆形揭开也被关掉」：它只在用户亲手点切换按钮时触发，属于对直接
    // 操作的即时反馈，文件里有一段注释专门解释为什么减动效下也照常展示。断言它会把
    // 那个决定反过来钉死。
  });

  it("每个关键帧都真的被用上了", () => {
    // 留着没人用的关键帧，下次改动效时会照着一段死代码猜意图。
    const unused = [...keyframeProperties().keys()].filter(
      (name) => !new RegExp(`animation:[^;]*\\b${name}\\b`).test(css),
    );

    expect(unused).toEqual([]);
  });
});

describe("阴影与过渡的写法约束", () => {
  function componentSources() {
    const root = resolve("src/components");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test."))
          files.push(full);
      }
    };
    walk(root);
    return files;
  }

  it("阴影走主题令牌，不用 Tailwind 的原生档位", () => {
    // Tailwind 的 shadow-sm/lg/xl 是按浅色背景调的 10% 纯黑，放到暗色主题近黑的底上
    // 等于没有——浮层、选中丸、划选浮出的按钮全部与背景糊在一起。
    // 例外是视频舞台里那两处：它们永远压在纯黑上，原生阴影在那儿本来就是对的。
    const offenders: string[] = [];
    for (const file of componentSources()) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          if (!/\bshadow-(sm|md|lg|xl|2xl)\b/.test(line)) return;
          if (line.includes("bg-black")) return;
          offenders.push(`${file.replace(resolve("src/components"), "")}:${index + 1}`);
        });
    }

    expect(offenders).toEqual([]);
  });

  it("自定义阴影令牌不与 Tailwind 的同名变量撞车", () => {
    // Tailwind v4 在 @theme 里定义 --shadow-xs/sm/md/lg/xl/2xl 并据此生成工具类。
    // 在 :root 上重定义同名变量，会连带改掉全应用 shadow-* 的输出——而且只在
    // 构建产物里看得出来，源码上一切正常。
    const reserved = ["xs", "sm", "md", "lg", "xl", "2xl", "inner", "none"];
    const declared = [...css.matchAll(/^\s*--shadow-([\w-]+)\s*:/gm)].map((m) => m[1]);

    expect(declared.filter((name) => reserved.includes(name))).toEqual([]);
  });

  it("暗色主题的每档阴影都带顶部内高光", () => {
    // 底已经接近纯黑，再黑也黑不出边界——暗色下把层次分开的其实是那道 inset 亮边，
    // 不是投影。去掉它，卡片、菜单、选中丸就全平贴在背景上了。
    const dark =
      css.match(/^\[data-theme="dark"\]\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";
    const tokens = [...dark.matchAll(/--shadow-([\w-]+)\s*:\s*([^;]+);/g)];

    expect(tokens.length).toBeGreaterThan(0);
    expect(
      tokens.filter(([, , value]) => !value.includes("inset")).map(([, name]) => name),
    ).toEqual([]);
  });

  it("受光层不占用 box-shadow", () => {
    // .ca-sheen 会和挂着 --shadow-pop 的浮层按钮叠在同一个元素上。
    // 两条 box-shadow 是互相覆盖而不是叠加的，所以高光只能走 background-image。
    const sheen = css.match(/^\.ca-sheen\s*\{[\s\S]*?\n\}/m)?.[0] ?? "";

    expect(sheen).toMatch(/background-image:/);
    expect(sheen).not.toMatch(/box-shadow:/);
  });

  it("不用 transition-all", () => {
    // transition-all 会把「所有」属性都纳入过渡，包括 width/height 这类触发重排的。
    // 进度条正是这么写的：宽度由内联样式驱动，每帧都要重排一次父容器。
    // 写清楚要过渡哪个属性，别人也才看得出这里到底想动什么。
    const offenders = componentSources().filter((file) =>
      /\btransition-all\b/.test(readFileSync(file, "utf8")),
    );

    expect(offenders.map((file) => file.replace(resolve("src/components"), ""))).toEqual([]);
  });
});
