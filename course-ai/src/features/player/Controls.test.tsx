import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Controls } from "./Controls";
import i18n from "@/i18n";
import { NO_INSETS } from "@/lib/blackBars";
import { usePlayer } from "@/stores/player";
import { useCaptionPrefs } from "@/stores/captionPrefs";

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
    fireEvent.click(screen.getByRole("button", { name: "Playback settings" }));
    expect(screen.getByRole("menuitemcheckbox", { name: "Adaptive speed" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemcheckbox", { name: "Skip pauses" })).toBeInTheDocument();
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
    const trigger = screen.getByRole("button", { name: /^倍速，当前/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "倍速" })).toBeInTheDocument();

    fireEvent.keyDown(screen.getAllByRole("menuitemradio")[0], { key: "Escape" });

    expect(screen.queryByRole("menu", { name: "倍速" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});

function openSettings() {
  const trigger = screen.getByRole("button", { name: "播放设置" });
  fireEvent.click(trigger);
  return { trigger, menu: screen.getByRole("menu", { name: "播放设置" }) };
}

describe("Controls layout", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    usePlayer.setState({ currentMs: 12_000, durationMs: 60_000 });
  });

  it("shows the chapter the playhead is in after the time, like YouTube", () => {
    renderControls({
      chapters: [
        { id: 1, video_id: "v", title: "开场", summary: null, start_ms: 0, end_ms: 10_000, order_index: 0 },
        { id: 2, video_id: "v", title: "梯度下降", summary: null, start_ms: 10_000, end_ms: 60_000, order_index: 1 },
      ],
    });
    expect(screen.getByTitle("梯度下降")).toBeInTheDocument();
    expect(screen.queryByTitle("开场")).not.toBeInTheDocument();
  });

  it("marks the settings gear while a playback-changing switch is on", () => {
    const { unmount } = renderControls();
    expect(screen.queryByTestId("settings-active-dot")).not.toBeInTheDocument();
    unmount();

    renderControls({ skipSilence: true });
    expect(screen.getByTestId("settings-active-dot")).toBeInTheDocument();
  });

  it("toggles captions from a CC button that reports its pressed state", () => {
    const onToggleCaptions = vi.fn();
    renderControls({ captionsOn: true, onToggleCaptions });
    const button = screen.getByRole("button", { name: "字幕" });
    expect(button).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(button);
    expect(onToggleCaptions).toHaveBeenCalledTimes(1);
  });
});

describe("Controls narrow-screen menu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    usePlayer.setState({ currentMs: 12_000, durationMs: 60_000 });
    controlsWidth = 450;
  });

  it("uses the compact controls at 450px even when the viewport is wide", () => {
    const { container } = renderControls({ danmakuAvailable: true });
    const controls = container.querySelector<HTMLElement>(".ca-player-controls");
    const time = container.querySelector<HTMLElement>(".ca-player-controls-time");

    expect(window.innerWidth).toBe(1_440);
    expect(controls).toHaveAttribute("data-controls-layout", "compact");
    expect(controls).toContainElement(screen.getByRole("button", { name: "播放" }));
    expect(controls).toContainElement(screen.getByRole("button", { name: "播放设置" }));
    expect(controls).toContainElement(screen.getByRole("button", { name: "全屏" }));
    // 倍速和弹幕收进设置菜单，不再占按钮行。
    expect(screen.queryByRole("button", { name: /^倍速，当前/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "弹幕" })).not.toBeInTheDocument();
    expect(time).toHaveTextContent("00:12 / 01:00");
  });

  it("restores the full row when the same controls container becomes wide", () => {
    const { container } = renderControls({ danmakuAvailable: true });
    resizeControls(1_000);

    expect(container.querySelector(".ca-player-controls")).toHaveAttribute(
      "data-controls-layout",
      "full",
    );
    expect(screen.getByRole("button", { name: /^倍速，当前/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "弹幕" })).toBeInTheDocument();
  });

  it("closes open menus when the layout switches instead of reopening them later", () => {
    controlsWidth = 1_000;
    renderControls();

    fireEvent.click(screen.getByRole("button", { name: /^倍速，当前/ }));
    expect(screen.getByRole("menu", { name: "倍速" })).toBeInTheDocument();

    resizeControls(450);
    resizeControls(1_000);
    expect(screen.queryByRole("menu", { name: "倍速" })).not.toBeInTheDocument();

    resizeControls(450);
    openSettings();
    resizeControls(1_000);
    resizeControls(450);
    expect(screen.queryByRole("menu", { name: "播放设置" })).not.toBeInTheDocument();
  });

  it("puts speed and danmaku into the settings menu with their current states", () => {
    renderControls({ rate: 1.5, smartRate: true, danmakuAvailable: true, danmakuOn: true });

    const { trigger, menu } = openSettings();
    const menuQueries = within(menu);

    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-controls", menu.id);
    const speeds = within(menuQueries.getByRole("group", { name: "倍速" }));
    expect(speeds.getAllByRole("menuitemradio")).toHaveLength(6);
    expect(speeds.getByRole("menuitemradio", { name: "1.5x" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(menuQueries.getByRole("menuitemcheckbox", { name: "智能倍速" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(menuQueries.getByRole("menuitemcheckbox", { name: "弹幕" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("supports menu keyboard navigation and restores focus on Escape", () => {
    renderControls({ smartRateAvailable: false, skipSilenceAvailable: false });
    const { trigger, menu } = openSettings();
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

    expect(screen.queryByRole("menu", { name: "播放设置" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("keeps the settings menu open while several options are changed", () => {
    const onRate = vi.fn();
    const onToggleSmartRate = vi.fn();
    renderControls({ onRate, onToggleSmartRate });
    const { menu } = openSettings();

    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "1.25x" }));
    fireEvent.click(within(menu).getByRole("menuitemcheckbox", { name: "智能倍速" }));

    expect(onRate).toHaveBeenCalledWith(1.25);
    expect(onToggleSmartRate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menu", { name: "播放设置" })).toBeInTheDocument();
  });
});

describe("Controls skip-silence switch", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("reflects and toggles the skip-silence switch", () => {
    const onToggleSkipSilence = vi.fn();
    renderControls({ skipSilence: true, onToggleSkipSilence });
    const { menu } = openSettings();

    const item = within(menu).getByRole("menuitemcheckbox", { name: "跳停顿" });
    expect(item).toHaveAttribute("aria-checked", "true");
    expect(item).toHaveAttribute("title", "关闭跳停顿（不再跳过无声的空档）");
    fireEvent.click(item);
    expect(onToggleSkipSilence).toHaveBeenCalledTimes(1);
  });

  it("shows 分析中 while the first scan is still running", () => {
    renderControls({ skipSilence: true, skipSilenceLoading: true });
    const { menu } = openSettings();
    // 首次开启要扫音轨，这几秒内还跳不了，得说实话。
    expect(within(menu).getByRole("menuitemcheckbox", { name: /跳停顿/ })).toHaveTextContent(
      "分析中",
    );
  });

  it("offers try-it buttons that land just before a pause", () => {
    const onPreviewSkip = vi.fn();
    renderControls({
      skipSilence: true,
      skipRanges: [
        { start_ms: 10_000, end_ms: 20_000 },
        { start_ms: 40_000, end_ms: 45_000 },
      ],
      onPreviewSkip,
    });

    // 在开头：没有上一处可去，下一处落在第一段停顿前 1.5 秒。
    const prev = screen.getByRole("button", { name: "上一处" });
    expect(prev).toBeDisabled();
    expect(prev.querySelector("svg")).not.toBeNull();
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
    const { menu } = openSettings();

    const item = within(menu).getByRole("menuitemcheckbox", { name: "跳停顿" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "当前设备暂不支持跳停顿");
  });
});

describe("Controls smart-rate switch", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  it("disables itself when there are no subtitles to measure speech rate from", () => {
    renderControls({ smartRate: false, smartRateAvailable: false });
    const { menu } = openSettings();
    // 语速是从字幕算的，没有字幕就排不出倍率表——置灰并说明原因。
    const item = within(menu).getByRole("menuitemcheckbox", { name: "智能倍速" });
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute("title", "还没有字幕，智能倍速排不出来");
  });

  it("still lets an enabled global switch be turned off on an unavailable video", () => {
    const onToggleSmartRate = vi.fn();
    renderControls({ smartRate: true, smartRateAvailable: false, onToggleSmartRate });
    const { menu } = openSettings();

    const item = within(menu).getByRole("menuitemcheckbox", { name: "智能倍速" });
    expect(item).toBeEnabled();
    expect(item).toHaveAttribute("title", "关闭智能倍速（当前视频没有可用字幕）");
    fireEvent.click(item);
    expect(onToggleSmartRate).toHaveBeenCalledTimes(1);
  });
});

describe("Controls crop switch", () => {
  beforeEach(() => {
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
  });

  function cropItem() {
    const { menu } = openSettings();
    return within(menu).getByRole("menuitemcheckbox", { name: "去黑边" });
  }

  it("spells out the detected insets so a lopsided picture can be diagnosed", () => {
    const onToggleCrop = vi.fn();
    renderControls({
      cropOn: true,
      cropInsets: { top: 0.0625, right: 0, bottom: 0.0625, left: 0.125 },
      onToggleCrop,
    });

    const item = cropItem();
    expect(item).toHaveAttribute("aria-checked", "true");
    expect(item).toHaveAttribute(
      "title",
      "检测到的黑边：上 6.3% / 右 0.0% / 下 6.3% / 左 12.5%。关掉看原始画面",
    );
    fireEvent.click(item);
    expect(onToggleCrop).toHaveBeenCalledTimes(1);
  });

  it("stays clickable while off, since nothing has been measured yet", () => {
    renderControls({ cropOn: false, cropInsets: { top: 0, right: 0, bottom: 0, left: 0 } });
    // 探测只在开关打开后才跑，关着的时候「有没有黑边」根本还不知道；
    // 按「没检测到」把开关锁住，等于这功能永远打不开。
    const item = cropItem();
    expect(item).not.toBeDisabled();
    expect(item).toHaveAttribute("title", "打开自动去掉黑边（会先花几秒探测）");
  });

  it("says so when the measurement came back empty", () => {
    renderControls({ cropOn: true, cropInsets: { top: 0, right: 0, bottom: 0, left: 0 } });
    // 开着却一条边都没测到：这本身就是「源片本来如此」的线索，得说出来。
    expect(cropItem()).toHaveAttribute("title", "这个视频没检测到黑边");
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
});

describe("Controls caption settings", () => {
  beforeEach(() => {
    localStorage.clear();
    usePlayer.setState({ currentMs: 0, durationMs: 60_000 });
    useCaptionPrefs.setState({ mode: "original", size: "medium", background: "translucent" });
  });

  it("offers original / bilingual / translation only when a translation exists", () => {
    const { unmount } = renderControls({ captionsOn: true });
    expect(within(openSettings().menu).queryByRole("group", { name: "内容" })).toBeNull();
    unmount();

    renderControls({ captionsOn: true, translationAvailable: true });
    const content = within(within(openSettings().menu).getByRole("group", { name: "内容" }));
    fireEvent.click(content.getByRole("menuitemradio", { name: "双语" }));
    expect(useCaptionPrefs.getState().mode).toBe("bilingual");
    expect(content.getByRole("menuitemradio", { name: "双语" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("changes and persists the caption size and background", () => {
    renderControls();
    const menu = within(openSettings().menu);

    fireEvent.click(
      within(menu.getByRole("group", { name: "字号" })).getByRole("menuitemradio", { name: "大" }),
    );
    fireEvent.click(
      within(menu.getByRole("group", { name: "背景" })).getByRole("menuitemradio", { name: "无" }),
    );

    expect(useCaptionPrefs.getState()).toMatchObject({ size: "large", background: "none" });
    expect(localStorage.getItem("course-ai-caption-size")).toBe("large");
  });
});
