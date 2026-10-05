import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controls } from "./Controls";
import i18n from "@/i18n";
import { NO_INSETS } from "@/lib/blackBars";
import { usePlayer } from "@/stores/player";

let controlsWidth = 1_024;
const resizeObservers = new Set<ResizeObserverMock>();

class ResizeObserverMock {
  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this);
  }

  observe() {}

  disconnect() {
    resizeObservers.delete(this);
  }

  unobserve() {}
}

function resizeControls(width: number) {
  controlsWidth = width;
  act(() => {
    resizeObservers.forEach((observer) => {
      observer.callback([], observer as unknown as ResizeObserver);
    });
  });
}

beforeEach(() => {
  controlsWidth = 1_024;
  window.innerWidth = 1_440;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
    () => controlsWidth,
  );
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
});

afterEach(() => {
  resizeObservers.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.innerWidth = 1_024;
});

function renderControls(props: Partial<Parameters<typeof Controls>[0]> = {}) {
  const base = {
    playing: false,
    rate: 1,
    effectiveRate: 1,
    volume: 1,
    muted: false,
    captionsOn: false,
    smartRate: false,
    smartRateAvailable: true,
    skipSilence: false,
    skipSilenceAvailable: true,
    skipSilenceLoading: false,
    skipRanges: [],
    cropOn: false,
    cropInsets: NO_INSETS,
    fullscreen: false,
    danmakuAvailable: false,
    danmakuOn: false,
    onToggleCrop: vi.fn(),
    onToggleCaptions: vi.fn(),
    onToggleDanmaku: vi.fn(),
    onToggleSkipSilence: vi.fn(),
    onToggleSmartRate: vi.fn(),
    onPreviewSkip: vi.fn(),
    onPlayPause: vi.fn(),
    onRate: vi.fn(),
    onVolume: vi.fn(),
    onMuteToggle: vi.fn(),
    onFullscreenToggle: vi.fn(),
  };
  return render(<Controls {...base} {...props} />);
}

describe("Controls speed button", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("labels the button 倍速 at 1x", () => {
    renderControls({ rate: 1 });
    expect(
      screen.getByRole("button", { name: /倍速，当前 1\.0x/ }),
    ).toHaveTextContent("倍速");
  });

  it("uses the selected language for player controls", async () => {
    await i18n.changeLanguage("en");

    renderControls();

    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Speed, currently 1.0x" }),
    ).toHaveTextContent("Speed");
    expect(screen.getByRole("button", { name: "Adaptive speed, off" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Skip pauses, off" })).toBeInTheDocument();
  });

  it("shows the current rate on the button when not 1x", () => {
    renderControls({ rate: 1.5, effectiveRate: 1.5 });
    const button = screen.getByRole("button", { name: /倍速，当前 1\.5x/ });
    expect(button).toHaveTextContent("1.5x");
    expect(button.className).toContain("text-[var(--video-accent)]");
  });

  it("shows the smart-adjusted effective rate while keeping the base menu selection", () => {
    renderControls({ rate: 1, effectiveRate: 1.4 });

    fireEvent.click(screen.getByRole("button", { name: "倍速，当前 1.4x" }));

    expect(screen.getByRole("button", { name: "倍速，当前 1.4x" })).toHaveTextContent("1.4x");
    expect(screen.getByRole("menuitemradio", { name: "1.0x" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("rounds floating-point effective rates for display", () => {
    renderControls({ rate: 0.75, effectiveRate: 0.75 * 1.1 });

    expect(screen.getByRole("button", { name: "倍速，当前 0.83x" })).toHaveTextContent(
      "0.83x",
    );
  });

  it("focuses the first speed when the menu opens", () => {
    renderControls({ rate: 1 });

    fireEvent.click(screen.getByRole("button", { name: /^倍速，当前/ }));

    expect(screen.getAllByRole("menuitemradio")[0]).toHaveFocus();
  });

  it("moves focus through the speed menu with arrow keys, Home, and End", () => {
    renderControls({ rate: 1 });
    fireEvent.click(screen.getByRole("button", { name: /^倍速，当前/ }));
    const items = screen.getAllByRole("menuitemradio");
    const lastItem = items[items.length - 1];

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(items[1], { key: "End" });
    expect(lastItem).toHaveFocus();

    fireEvent.keyDown(lastItem, { key: "ArrowDown" });
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(items[0], { key: "ArrowUp" });
    expect(lastItem).toHaveFocus();

    fireEvent.keyDown(lastItem, { key: "Home" });
    expect(items[0]).toHaveFocus();
  });

  it("closes the speed menu on Escape and restores focus to its trigger", () => {
    renderControls({ rate: 1 });
    // 精确名字：控制栏里「智能倍速」也含「倍速」，松匹配会同时命中两个按钮。
    const trigger = screen.getByRole("button", { name: /^倍速，当前/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "倍速" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getAllByRole("menuitemradio")[0], { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "倍速" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

describe("Controls narrow-screen menu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    usePlayer.setState({ currentMs: 12_000, durationMs: 60_000 });
    controlsWidth = 450;
  });

  it("uses the compact controls at 450px even when the viewport is wide", () => {
    const { container } = renderControls();
    const controls = container.querySelector<HTMLElement>(".ca-player-controls");
    const desktopControls = container.querySelector<HTMLElement>(
      ".ca-player-controls-desktop",
    );
    const compactControls = container.querySelector<HTMLElement>(
      ".ca-player-mobile-more",
    );
    const time = container.querySelector<HTMLElement>(".ca-player-controls-time");
    const play = screen.getByRole("button", { name: "播放" });
    const more = screen.getByRole("button", { name: "更多" });
    const fullscreen = screen.getByRole("button", { name: "全屏" });

    expect(window.innerWidth).toBe(1_440);
    expect(controls).toHaveAttribute("data-controls-layout", "compact");
    expect(desktopControls).toHaveAttribute("aria-hidden", "true");
    expect(desktopControls).toHaveAttribute("inert");
    expect(compactControls).not.toHaveAttribute("aria-hidden");
    expect(compactControls).not.toHaveAttribute("inert");
    expect(controls).toContainElement(play);
    expect(controls).toContainElement(time);
    expect(controls).toContainElement(more);
    expect(controls).toContainElement(fullscreen);
    expect(desktopControls).toContainElement(
      within(desktopControls!).getByRole("button", {
        name: /^倍速，当前/,
        hidden: true,
      }),
    );
    expect(desktopControls).not.toContainElement(play);
    expect(desktopControls).not.toContainElement(more);
    expect(desktopControls).not.toContainElement(fullscreen);
    expect(time).toHaveTextContent("00:12 / 01:00");
  });

  it("restores the full desktop group when the same controls container becomes wide", () => {
    const { container } = renderControls();
    const controls = container.querySelector<HTMLElement>(".ca-player-controls");
    const desktopControls = container.querySelector<HTMLElement>(
      ".ca-player-controls-desktop",
    );
    const compactControls = container.querySelector<HTMLElement>(
      ".ca-player-mobile-more",
    );

    resizeControls(1_000);

    expect(controls).toHaveAttribute("data-controls-layout", "full");
    expect(desktopControls).not.toHaveAttribute("aria-hidden");
    expect(desktopControls).not.toHaveAttribute("inert");
    expect(compactControls).toHaveAttribute("aria-hidden", "true");
    expect(compactControls).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: /^倍速，当前/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "更多" })).not.toBeInTheDocument();
  });

  it("closes the menu that becomes inactive instead of reopening it after another resize", () => {
    controlsWidth = 1_000;
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: /^倍速，当前/ }));
    expect(screen.getByRole("menu", { name: "倍速" })).toBeInTheDocument();

    resizeControls(450);
    resizeControls(1_000);
    expect(screen.queryByRole("menu", { name: "倍速" })).not.toBeInTheDocument();

    resizeControls(450);
    fireEvent.click(screen.getByRole("button", { name: "更多" }));
    expect(screen.getByRole("menu", { name: "更多" })).toBeInTheDocument();

    resizeControls(1_000);
    resizeControls(450);
    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
  });

  it("exposes secondary controls with menu semantics and current states", () => {
    renderControls({
      rate: 1.5,
      smartRate: true,
      captionsOn: true,
      muted: true,
    });

    const trigger = screen.getByRole("button", { name: "更多" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "更多" });
    const menuQueries = within(menu);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    expect(menuQueries.getAllByRole("menuitemradio")).toHaveLength(6);
    expect(menuQueries.getByRole("menuitemradio", { name: "1.5x" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      menuQueries.getByRole("menuitemcheckbox", { name: "智能倍速" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      menuQueries.getByRole("menuitemcheckbox", { name: "字幕" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      menuQueries.getByRole("menuitemcheckbox", { name: "静音" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(menuQueries.getByRole("menuitemradio", { name: "1.5x" }).className).toContain(
      "text-[var(--video-accent)]",
    );
  });

  it("supports menu keyboard navigation and restores focus on Escape", () => {
    renderControls({ smartRateAvailable: false, skipSilenceAvailable: false });
    const trigger = screen.getByRole("button", { name: "更多" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "更多" });
    const enabledItems = Array.from(
      menu.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])'),
    );
    const lastEnabledItem = enabledItems[enabledItems.length - 1];

    expect(enabledItems[0]).toHaveFocus();
    fireEvent.keyDown(enabledItems[0], { key: "ArrowDown" });
    expect(enabledItems[1]).toHaveFocus();
    fireEvent.keyDown(enabledItems[1], { key: "End" });
    expect(lastEnabledItem).toHaveFocus();
    fireEvent.keyDown(lastEnabledItem, { key: "Home" });
    expect(enabledItems[0]).toHaveFocus();
    fireEvent.keyDown(enabledItems[0], { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("runs a selected action, closes the menu, and returns focus", () => {
    const onRate = vi.fn();
    const onToggleSmartRate = vi.fn();
    renderControls({ onRate, onToggleSmartRate });
    const trigger = screen.getByRole("button", { name: "更多" });

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "更多" })).getByRole(
        "menuitemradio",
        { name: "1.25x" },
      ),
    );
    expect(onRate).toHaveBeenCalledWith(1.25);
    expect(screen.queryByRole("menu", { name: "更多" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("menu", { name: "更多" })).getByRole(
        "menuitemcheckbox",
        { name: "智能倍速" },
      ),
    );
    expect(onToggleSmartRate).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveFocus();
  });
});

describe("Controls skip-silence toggle", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("reflects and toggles the skip-silence switch", () => {
    const onToggleSkipSilence = vi.fn();
    renderControls({ skipSilence: true, onToggleSkipSilence });

    const button = screen.getByRole("button", { name: "跳停顿，已开启" });
    // 开着时按钮要看得出来是开着的，否则用户不知道画面为什么会自己往前跳。
    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button.className).toContain("text-[var(--video-accent)]");

    fireEvent.click(button);
    expect(onToggleSkipSilence).toHaveBeenCalledTimes(1);
  });

  it("says 开 on the button so the state is readable at a glance", () => {
    const { rerender } = renderControls({ skipSilence: false });
    // 关着时只有名字，没有多余的状态字。
    expect(screen.getByRole("button", { name: "跳停顿，已关闭" })).toHaveTextContent(
      /^跳停顿$/,
    );

    rerender(<div />);
    renderControls({ skipSilence: true });
    expect(screen.getByRole("button", { name: "跳停顿，已开启" })).toHaveTextContent(
      "跳停顿 · 开",
    );
  });

  it("shows 分析中 while the first scan is still running", () => {
    renderControls({ skipSilence: true, skipSilenceLoading: true });
    // 首次开启要扫音轨，这几秒内还跳不了，按钮上得说实话。
    expect(screen.getByRole("button", { name: "跳停顿，已开启" })).toHaveTextContent(
      "跳停顿 · 分析中",
    );
  });

  it("offers try-it buttons that land just before a pause", () => {
    const onPreviewSkip = vi.fn();
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
    renderControls({
      skipSilence: true,
      skipRanges: [
        { start_ms: 10_000, end_ms: 20_000 },
        { start_ms: 40_000, end_ms: 45_000 },
      ],
      onPreviewSkip,
    });

    // 在开头：没有上一处可去，下一处落在第一段停顿前 1.5 秒。
    expect(screen.getByRole("button", { name: "上一处" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "下一处" }));
    expect(onPreviewSkip).toHaveBeenCalledWith(8_500);
  });

  it("hides the try-it buttons when there is nothing to skip", () => {
    renderControls({ skipSilence: true, skipRanges: [] });
    expect(screen.queryByRole("button", { name: "下一处" })).not.toBeInTheDocument();

    // 开关没打开时也不该出现——那两个按钮只为验证跳停顿而存在。
    renderControls({
      skipSilence: false,
      skipRanges: [{ start_ms: 10_000, end_ms: 20_000 }],
    });
    expect(screen.queryByRole("button", { name: "下一处" })).not.toBeInTheDocument();
  });

  it("disables skip-silence where audio scanning is unavailable", () => {
    renderControls({ skipSilenceAvailable: false });

    const button = screen.getByRole("button", { name: "跳停顿，已关闭" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "当前设备暂不支持跳停顿");
  });
});

describe("Controls smart-rate toggle", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("reflects and toggles the smart-rate switch", () => {
    const onToggleSmartRate = vi.fn();
    renderControls({ smartRate: true, onToggleSmartRate });

    const button = screen.getByRole("button", { name: "智能倍速，已开启" });
    expect(button).toHaveTextContent("智能倍速 · 开");
    fireEvent.click(button);
    expect(onToggleSmartRate).toHaveBeenCalledTimes(1);
  });

  it("disables itself when there are no subtitles to measure speech rate from", () => {
    renderControls({ smartRate: false, smartRateAvailable: false });
    // 语速是从字幕算的，没有字幕就排不出倍率表——按钮置灰并说明原因。
    const button = screen.getByRole("button", { name: "智能倍速，已关闭" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "还没有字幕，智能倍速排不出来");
  });

  it("still lets an enabled global switch be turned off on an unavailable video", () => {
    const onToggleSmartRate = vi.fn();
    renderControls({
      smartRate: true,
      smartRateAvailable: false,
      onToggleSmartRate,
    });

    const button = screen.getByRole("button", { name: "智能倍速，已开启" });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("title", "关闭智能倍速（当前视频没有可用字幕）");
    fireEvent.click(button);
    expect(onToggleSmartRate).toHaveBeenCalledTimes(1);
  });
});

describe("Controls crop toggle", () => {
  it("spells out the detected insets so a lopsided picture can be diagnosed", () => {
    const onToggleCrop = vi.fn();
    renderControls({
      cropOn: true,
      cropInsets: { top: 0.0625, right: 0, bottom: 0.0625, left: 0.125 },
      onToggleCrop,
    });

    const button = screen.getByRole("button", { name: "去黑边，已开启" });
    expect(button).toHaveAttribute(
      "title",
      "检测到的黑边：上 6.3% / 右 0.0% / 下 6.3% / 左 12.5%。关掉看原始画面",
    );

    fireEvent.click(button);
    expect(onToggleCrop).toHaveBeenCalledTimes(1);
  });

  it("stays clickable while off, since nothing has been measured yet", () => {
    const onToggleCrop = vi.fn();
    renderControls({
      cropOn: false,
      cropInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      onToggleCrop,
    });

    // 探测只在开关打开后才跑，关着的时候「有没有黑边」根本还不知道；
    // 按「没检测到」把按钮锁住，等于这功能永远打不开。
    const button = screen.getByRole("button", { name: "去黑边，已关闭" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("title", "打开自动去掉黑边（会先花几秒探测）");

    fireEvent.click(button);
    expect(onToggleCrop).toHaveBeenCalledTimes(1);
  });

  it("says so when the measurement came back empty", () => {
    renderControls({ cropOn: true, cropInsets: { top: 0, right: 0, bottom: 0, left: 0 } });
    // 开着却一条边都没测到：这本身就是「源片本来如此」的线索，得说出来。
    expect(screen.getByRole("button", { name: "去黑边，已开启" })).toHaveAttribute(
      "title",
      "这个视频没检测到黑边",
    );
  });
});

describe("Controls unified on-state and compact skip-nav", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("gives 字幕 and 去黑边 the same accent ring on-state as 智能倍速/跳停顿", () => {
    renderControls({
      captionsOn: true,
      cropOn: true,
      cropInsets: { top: 0.05, right: 0, bottom: 0.05, left: 0 },
    });

    // 开启时统一为 accent 底 + 内描边（不再是以前那种只看文字变色的弱反馈）。
    for (const name of ["字幕", "去黑边，已开启"]) {
      const button = screen.getByRole("button", { name });
      expect(button.className).toContain("bg-[var(--surface-card-active)]");
      expect(button.className).toContain("ring-inset");
    }
  });

  it("uses compact icon buttons for skip-silence try-it nav", () => {
    renderControls({
      skipSilence: true,
      skipRanges: [
        { start_ms: 10_000, end_ms: 20_000 },
        { start_ms: 40_000, end_ms: 45_000 },
      ],
    });

    const prev = screen.getByRole("button", { name: "上一处" });
    const next = screen.getByRole("button", { name: "下一处" });
    // 图标化：不再显示文字，按钮是正方形图标钮（svg 存在、无文本）。
    expect(prev.querySelector("svg")).not.toBeNull();
    expect(next.querySelector("svg")).not.toBeNull();
    expect(prev.textContent).toBe("");
  });
});

describe("Controls danmaku toggle", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("hides the danmaku toggle when data is unavailable", () => {
    renderControls({ danmakuAvailable: false });

    expect(screen.queryByRole("button", { name: "弹幕" })).not.toBeInTheDocument();
  });

  it("shows the danmaku toggle only for videos with danmaku and toggles it", () => {
    const onToggleDanmaku = vi.fn();
    renderControls({ danmakuAvailable: true, danmakuOn: true, onToggleDanmaku });

    const button = screen.getByRole("button", { name: "弹幕" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleDanmaku).toHaveBeenCalledTimes(1);
  });

  it("exposes danmaku in the compact more-menu", () => {
    renderControls({
      danmakuAvailable: true,
      danmakuOn: true,
    });
    resizeControls(360);

    const trigger = screen.getByRole("button", { name: "更多" });
    fireEvent.click(trigger);

    const danmakuItem = screen.getByRole("menuitemcheckbox", { name: "弹幕" });
    expect(danmakuItem).toHaveAttribute("aria-checked", "true");
  });
});
