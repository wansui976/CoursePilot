import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistantUi } from "@/stores/assistant";
import { useTheme } from "@/stores/theme";
import type { AssistantAction, AssistantReply } from "@/lib/types";

const { mockIpc, platformMock } = vi.hoisted(() => ({
  mockIpc: {
    assistant: { ask: vi.fn(), cancel: vi.fn() },
    videos: { updateTitle: vi.fn(), delete: vi.fn() },
    courses: { create: vi.fn(), rename: vi.fn() },
    settings: { set: vi.fn(), get: vi.fn() },
    tools: {
      importBilibili: vi.fn(),
      probeBilibili: vi.fn(),
      hasBilibiliCookies: vi.fn(),
    },
    pipeline: { process: vi.fn() },
  },
  platformMock: { mobile: false },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({
  isMobile: () => platformMock.mobile,
  isAndroid: () => platformMock.mobile,
  isIOS: () => false,
  isTablet: () => false,
  isDesktop: () => !platformMock.mobile,
}));

function reply(over: Partial<AssistantReply> = {}): AssistantReply {
  return {
    answer: "好了",
    canceled: false,
    actions: [],
    turns: 1,
    tools_used: [],
    history: [],
    ...over,
  };
}

function renderPanel(
  onNavigate = vi.fn(),
  layout: { compact?: boolean; bottomNavigationVisible?: boolean } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssistantPanel
        context={{ course_id: "c1", video_id: "v1" }}
        onNavigate={onNavigate}
        compact={layout.compact}
        bottomNavigationVisible={layout.bottomNavigationVisible}
      />
    </QueryClientProvider>,
  );
  return onNavigate;
}

async function ask(text: string) {
  fireEvent.change(screen.getByLabelText("对助手说"), { target: { value: text } });
  fireEvent.click(screen.getByLabelText("发送"));
}

describe("AssistantPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    platformMock.mobile = false;
    useAssistantUi.setState({ open: true, side: "right" });
    mockIpc.assistant.ask.mockResolvedValue(reply());
    mockIpc.assistant.cancel.mockResolvedValue(undefined);
  });

  it("收起时在界面边缘留一条可点开的窄条", () => {
    useAssistantUi.setState({ open: false });
    renderPanel();
    expect(screen.queryByLabelText("对助手说")).not.toBeInTheDocument();
    const dockStrip = screen.getByLabelText("打开助手");
    expect(dockStrip).toHaveAttribute("data-dock-side", "right");
    expect(dockStrip).toHaveClass("right-0", "h-28", "w-11");
    fireEvent.click(dockStrip);
    expect(screen.getByLabelText("对助手说")).toBeInTheDocument();
  });

  it("删除空白对话里的示例注脚", () => {
    renderPanel();
    expect(screen.queryByText(/这门课哪讲了梯度下降/)).not.toBeInTheDocument();
    expect(screen.queryByText(/把这个视频改名叫第三讲/)).not.toBeInTheDocument();
  });

  it("空白对话给出可直接执行的当前视频建议", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "查找例题" }));
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "查找当前视频里讲例题的位置",
        { course_id: "c1", video_id: "v1" },
        [],
        expect.any(String),
      ),
    );
  });

  it("可以从标题栏拖动桌面面板", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 648,
      top: 16,
      width: 360,
      height: 600,
      right: 1008,
      bottom: 616,
      x: 648,
      y: 16,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole("button", { name: "拖动助手面板" });
    fireEvent.pointerDown(handle, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 700,
      clientY: 40,
    });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 500, clientY: 140 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 500, clientY: 140 });

    expect(panel).toHaveStyle({ left: "448px", top: "116px" });
    expect(useAssistantUi.getState().open).toBe(true);
  });

  it("拖到左侧边缘后自动吸附成窄条", () => {
    renderPanel();
    const panel = screen.getByRole("complementary", { name: "助手" });
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
      left: 648,
      top: 16,
      width: 360,
      height: 600,
      right: 1008,
      bottom: 616,
      x: 648,
      y: 16,
      toJSON: () => ({}),
    });

    const handle = screen.getByRole("button", { name: "拖动助手面板" });
    fireEvent.pointerDown(handle, {
      pointerId: 2,
      pointerType: "mouse",
      button: 0,
      clientX: 700,
      clientY: 40,
    });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 40, clientY: 180 });
    expect(panel).toHaveAttribute("data-snap-side", "left");
    fireEvent.pointerUp(window, { pointerId: 2, clientX: 40, clientY: 180 });

    const dockStrip = screen.getByRole("button", { name: "打开助手" });
    expect(dockStrip).toHaveAttribute("data-dock-side", "left");
    expect(dockStrip).toHaveClass("left-0", "h-28", "w-11");
    expect(dockStrip).toHaveStyle({ top: "396px" });
    expect(useAssistantUi.getState()).toMatchObject({ open: false, side: "left" });
  });

  it("键盘可以把面板吸附到左右边缘", () => {
    renderPanel();
    fireEvent.keyDown(screen.getByRole("button", { name: "拖动助手面板" }), { key: "Home" });
    expect(screen.getByRole("button", { name: "打开助手" })).toHaveAttribute(
      "data-dock-side",
      "left",
    );
  });

  it("回答按 Markdown 渲染，而不是把 ** 和 - 原样铺出来", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "重点有两条：\n\n- **梯度下降**很关键\n- 学习率要调" }),
    );
    renderPanel();
    await ask("讲了什么");
    // 星号被吃掉、变成加粗元素；列表项也不再带前导的 "- "。
    const strong = await screen.findByText("梯度下降");
    expect(strong.tagName).toBe("STRONG");
    expect(screen.queryByText(/\*\*梯度下降\*\*/)).not.toBeInTheDocument();
    expect(screen.getByText(/学习率要调/).textContent).not.toMatch(/^- /);
  });

  it("主题当场生效，不用再点一次确认", async () => {
    useTheme.setState({ pref: "light" });
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "set_theme", pref: "dark" }] }),
    );
    renderPanel();
    await ask("设置主题为黑夜模式");
    // 无破坏性、一眼可见、再说一句就能改回来——不该为它加一次点击。
    await waitFor(() => expect(useTheme.getState().pref).toBe("dark"));
    expect(await screen.findByText(/已切换到夜间主题/)).toBeInTheDocument();
  });

  it("把界面状态一起发过去，助手才听得懂「这个视频」", async () => {
    renderPanel();
    await ask("这讲了什么");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "这讲了什么",
        { course_id: "c1", video_id: "v1" },
        [],
        expect.any(String),
      ),
    );
  });

  it("续聊时把上一轮的完整往返传回去", async () => {
    const history = [{ role: "user", content: "第一句" }];
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ history }));
    renderPanel();
    await ask("第一句");
    await screen.findByText("好了");
    await ask("那第二个呢");
    // 工具往返也在 history 里；不原样带回去，模型就看不到自己刚查到了什么。
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "那第二个呢",
        expect.anything(),
        history,
        expect.any(String),
      ),
    );
  });

  it("出错时把问题放回输入框，不用重打一遍", async () => {
    mockIpc.assistant.ask.mockRejectedValueOnce(new Error("端点挂了"));
    renderPanel();
    await ask("帮我查查");
    await screen.findByRole("alert");
    expect(screen.getByLabelText("对助手说")).toHaveValue("帮我查查");
  });

  it("把后端错误翻成人能处理的提示", async () => {
    mockIpc.assistant.ask.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));
    renderPanel();
    await ask("帮我查查");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("API Key");
    expect(alert).not.toHaveTextContent("HTTP 401");
  });

  it("等待 Agent 工具链时给屏幕阅读器明确状态", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("找一下例题");

    expect(await screen.findByRole("status")).toHaveTextContent("正在思考并调用工具");
    expect(screen.getByLabelText("停止生成")).toBeEnabled();

    finish(reply());
    await screen.findByText("好了");
  });

  it("停止会取消当前 request_id，并明确标出这一轮没有执行完", async () => {
    let finish!: (value: AssistantReply) => void;
    mockIpc.assistant.ask.mockReturnValueOnce(
      new Promise<AssistantReply>((resolve) => {
        finish = resolve;
      }),
    );
    renderPanel();
    await ask("查完所有课程");

    const requestId = mockIpc.assistant.ask.mock.calls[0][3];
    fireEvent.click(await screen.findByLabelText("停止生成"));
    await waitFor(() => expect(mockIpc.assistant.cancel).toHaveBeenCalledWith(requestId));
    expect(screen.getByRole("status")).toHaveTextContent("正在停止");

    finish(reply({ answer: "", canceled: true }));
    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(screen.getByLabelText("发送")).toBeDisabled();
  });

  it("停止后的半成品动作不会继续改界面或等待确认", async () => {
    useTheme.setState({ pref: "light" });
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        answer: "",
        canceled: true,
        actions: [
          { kind: "set_theme", pref: "dark" },
          { kind: "propose_delete", video_id: "v1", title: "第一讲" },
        ],
      }),
    );
    renderPanel();
    await ask("删掉它并切换主题");

    expect(await screen.findByText("已停止，未继续执行")).toBeInTheDocument();
    expect(useTheme.getState().pref).toBe("light");
    expect(screen.queryByText("删除视频")).not.toBeInTheDocument();
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();
  });

  it("新对话会清掉旧消息和后端历史", async () => {
    const oldHistory = [{ role: "user", content: "旧问题" }];
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ answer: "旧回答", history: oldHistory }),
    );
    renderPanel();
    await ask("旧问题");
    await screen.findByText("旧回答");

    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    expect(screen.queryByText("旧问题")).not.toBeInTheDocument();
    expect(screen.queryByText("旧回答")).not.toBeInTheDocument();

    await ask("重新开始");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenLastCalledWith(
        "重新开始",
        expect.anything(),
        [],
        expect.any(String),
      ),
    );
  });

  it("导航动作点一下才执行，不会自己跳走", async () => {
    const action: AssistantAction = {
      kind: "open_video",
      video_id: "v9",
      title: "第三讲",
      at_ms: 90000,
    };
    mockIpc.assistant.ask.mockResolvedValueOnce(reply({ actions: [action] }));
    const onNavigate = renderPanel();
    await ask("打开第三讲");

    const button = await screen.findByText(/打开《第三讲》/);
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith(action);
  });

  it("自己说的话显示成气泡", async () => {
    renderPanel();
    await ask("这讲了什么");
    const bubble = await screen.findByTestId("user-bubble");
    expect(bubble).toHaveTextContent("这讲了什么");
  });

  it("工具链用人话显示，不是函数名", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        tools_used: ["get_study_progress", "list_due_reviews", "search_content", "open_video"],
        turns: 3,
      }),
    );
    renderPanel();
    await ask("找找看");
    const chips = await screen.findByTestId("tool-chips");
    expect(chips).toHaveTextContent("读取学习进度");
    expect(chips).toHaveTextContent("查看待复习");
    expect(chips).toHaveTextContent("搜索课程内容");
    expect(chips).toHaveTextContent("打开视频");
    // search_content 是给模型看的标识符，摆在界面上只会让人去猜它是什么。
    expect(chips).not.toHaveTextContent("search_content");
    expect(chips).not.toHaveTextContent("get_study_progress");
    // 每轮的工具结果都留在上下文里，花销是乘法涨的，轮次要看得见。
    expect(screen.getByText(/来回 3 轮/)).toBeInTheDocument();
  });

  it("连着调同一个工具折叠成 ×N", async () => {
    // 真实遇到过：连搜三次 B 站，底下并排三颗一模一样的标签。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ tools_used: ["search_bilibili", "search_bilibili", "search_bilibili"], turns: 3 }),
    );
    renderPanel();
    await ask("找视频");
    const chips = await screen.findByTestId("tool-chips");
    expect(chips).toHaveTextContent("搜索 B 站");
    expect(chips).toHaveTextContent("×3");
  });

  it("会改动东西的工具标成「准备」，免得看起来像已经做了", async () => {
    // 它只生成了确认卡、什么都没做。写成「删除视频」会让人以为已经删了，
    // 那底下紧跟着的确认卡就白设了。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ tools_used: ["delete_video"], turns: 2 }),
    );
    renderPanel();
    await ask("删了它");
    expect(await screen.findByTestId("tool-chips")).toHaveTextContent("准备删除");
  });

  it("输入法组词时的回车不发送", async () => {
    renderPanel();
    const box = screen.getByLabelText("对助手说");
    fireEvent.change(box, { target: { value: "梯度" } });
    // 中文用户每选一次候选词都会敲回车，当成发送就会不停误发。
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(mockIpc.assistant.ask).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(mockIpc.assistant.ask).toHaveBeenCalled());
  });

  it("手机端不显示左右停靠按钮", async () => {
    platformMock.mobile = true;
    renderPanel();
    expect(screen.queryByLabelText(/停靠到/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拖动助手面板" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("对助手说")).toBeInTheDocument();
  });

  it("窄视口按移动抽屉渲染，并避开底部主导航", () => {
    renderPanel(vi.fn(), { compact: true, bottomNavigationVisible: true });
    const panel = screen.getByRole("complementary", { name: "助手" });
    expect(screen.queryByRole("button", { name: "拖动助手面板" })).not.toBeInTheDocument();
    expect(panel).toHaveClass("inset-x-0", "h-[70vh]");
    expect(panel.getAttribute("style")).toContain("bottom: calc(56px");
  });
});

describe("确认卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    platformMock.mobile = false;
    useAssistantUi.setState({ open: true, side: "right" });
    mockIpc.assistant.ask.mockResolvedValue(reply());
    mockIpc.assistant.cancel.mockResolvedValue(undefined);
    mockIpc.tools.hasBilibiliCookies.mockResolvedValue(true);
    mockIpc.tools.probeBilibili.mockResolvedValue({
      title: "双曲线",
      qualities: [1080, 720],
      tracks: [
        { lang: "ai-zh", auto: true, label: "AI 中文" },
        { lang: "zh-Hans", auto: false, label: "中文（简体）" },
      ],
    });
    mockIpc.tools.importBilibili.mockResolvedValue({ id: "newvid" });
    mockIpc.settings.get.mockResolvedValue(null);
  });

  it("改名要等用户点确认才真的改", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第三讲 特征值",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改个名");

    // 卡片必须把原名和新名都摆出来——最大的风险不是「AI 要改名」，是它认错了对象。
    expect(await screen.findByText("未命名")).toBeInTheDocument();
    expect(screen.getByText("第三讲 特征值")).toBeInTheDocument();
    // 还没点之前，什么都不该发生。
    expect(mockIpc.videos.updateTitle).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认改名" }));
    await waitFor(() =>
      expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v1", "第三讲 特征值"),
    );
    expect(await screen.findByText("已生效")).toBeInTheDocument();
  });

  it("删除要等确认，并说清楚是进回收站", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel();
    await ask("删了它");

    expect(await screen.findByText("第五讲")).toBeInTheDocument();
    expect(screen.getByText(/30 天内可还原/)).toBeInTheDocument();
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(mockIpc.videos.delete).toHaveBeenCalledWith("v2"));
  });

  it("取消提案就什么都不做", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel();
    await ask("删了它");
    fireEvent.click(await screen.findByRole("button", { name: "取消" }));
    expect(mockIpc.videos.delete).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("第五讲")).not.toBeInTheDocument());
  });

  it("改设置显示改前改后，确认后才写", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_setting",
            key: "subtitle_autocorrect",
            label: "字幕 AI 纠错",
            current: "false",
            value: "true",
          },
        ],
      }),
    );
    renderPanel();
    await ask("把字幕纠错打开");
    expect(await screen.findByText("字幕 AI 纠错")).toBeInTheDocument();
    expect(screen.getByText("false → true")).toBeInTheDocument();
    expect(mockIpc.settings.set).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认修改" }));
    await waitFor(() =>
      expect(mockIpc.settings.set).toHaveBeenCalledWith("subtitle_autocorrect", "true"),
    );
  });

  it("执行失败要说出来，而不是悄悄退回待确认", async () => {
    mockIpc.videos.delete.mockRejectedValueOnce(new Error("文件被占用"));
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ actions: [{ kind: "propose_delete", video_id: "v2", title: "第五讲" }] }),
    );
    renderPanel();
    await ask("删了它");
    fireEvent.click(await screen.findByRole("button", { name: "确认删除" }));
    // 悄悄退回的话，用户会以为自己没点上而再点一次——而第一次可能已经生效了。
    expect(await screen.findByRole("alert")).toHaveTextContent("文件被占用");
  });

  it("新建课程要确认，并显示建在哪个目录", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [{ kind: "propose_create_course", name: "概率论", root_path: "/Users/me/课程" }],
      }),
    );
    renderPanel();
    await ask("新建一门概率论");
    expect(await screen.findByText("概率论")).toBeInTheDocument();
    // 多数人记不清默认存放位置，建错地方后面很难收拾。
    expect(screen.getByText(/\/Users\/me\/课程/)).toBeInTheDocument();
    expect(mockIpc.courses.create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认创建" }));
    await waitFor(() =>
      expect(mockIpc.courses.create).toHaveBeenCalledWith("概率论", "/Users/me/课程"),
    );
  });

  it("课程改名要确认，且和视频改名是两回事", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename_course",
            course_id: "c1",
            current_name: "线性代数",
            new_name: "线代复习",
          },
        ],
      }),
    );
    renderPanel();
    await ask("把课程改个名");
    expect(await screen.findByText("课程改名")).toBeInTheDocument();
    expect(screen.getByText("线性代数")).toBeInTheDocument();
    expect(mockIpc.courses.rename).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确认改名" }));
    await waitFor(() => expect(mockIpc.courses.rename).toHaveBeenCalledWith("c1", "线代复习"));
    // 别把课程改名走成视频改名。
    expect(mockIpc.videos.updateTitle).not.toHaveBeenCalled();
  });

  it("确认之后要让列表失效，否则界面还在显示旧名字", async () => {
    // 真实反馈：确认了但名字没变。库里其实改好了，是界面在拿缓存——
    // 应用里别处的改动都顺带做了失效，这张卡直接调 IPC，漏了这一步。
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_rename",
            video_id: "v1",
            current_title: "未命名",
            new_title: "第三讲",
          },
        ],
      }),
    );
    renderPanel();
    await ask("改个名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalled());
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: ["videos"] }),
      ),
    );
    invalidate.mockRestore();
  });

  it("批量改名合成一张卡，只点一次确认", async () => {
    // 让人为一次批量改名点十下确认，等于把确认训练成一件要赶紧跳过的事，
    // 那就再也拦不住真正该拦的那一次了。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
          { kind: "propose_rename", video_id: "v3", current_title: "03", new_title: "第三讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");

    expect(await screen.findByText("3 项")).toBeInTheDocument();
    // 只有一个确认按钮，不是三个。
    expect(screen.getAllByRole("button", { name: /确认改名/ })).toHaveLength(1);
    expect(screen.getByText("第一讲")).toBeInTheDocument();
    expect(screen.getByText("第三讲")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "确认改名 3 项" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(3));
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v2", "第二讲");
  });

  it("批量里可以单独剔掉认错的那一条", async () => {
    // 批量里错一两个是常态，不该逼着人要么全接受要么全放弃。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "认错了" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "跳过 认错了" }));

    fireEvent.click(screen.getByRole("button", { name: "确认改名 1 项" }));
    await waitFor(() => expect(mockIpc.videos.updateTitle).toHaveBeenCalledTimes(1));
    expect(mockIpc.videos.updateTitle).toHaveBeenCalledWith("v1", "第一讲");
  });

  it("批量里部分失败要说清是哪几项", async () => {
    mockIpc.videos.updateTitle
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("重名"));
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名 2 项" }));
    // 只报一条错的话，用户无从知道该重做哪个。
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("1 项完成");
    expect(alert).toHaveTextContent("第二讲");
  });

  it("批量重试只执行失败项，已经成功的不能再做一次", async () => {
    mockIpc.videos.updateTitle
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("重名"))
      .mockResolvedValueOnce(undefined);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_rename", video_id: "v1", current_title: "01", new_title: "第一讲" },
          { kind: "propose_rename", video_id: "v2", current_title: "02", new_title: "第二讲" },
        ],
      }),
    );
    renderPanel();
    await ask("批量改名");
    fireEvent.click(await screen.findByRole("button", { name: "确认改名 2 项" }));

    const retry = await screen.findByRole("button", { name: "重试失败的 1 项" });
    expect(screen.getByText("已完成")).toBeInTheDocument();
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText("已生效")).toBeInTheDocument());
    expect(mockIpc.videos.updateTitle.mock.calls.filter(([id]) => id === "v1")).toHaveLength(1);
    expect(mockIpc.videos.updateTitle.mock.calls.filter(([id]) => id === "v2")).toHaveLength(2);
  });

  it("导入要带上字幕轨和清晰度，并在之后跑流水线", async () => {
    // 之前这里只调了一次裸的下载：视频进来了，但没字幕、没分析。
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    await waitFor(() =>
      expect(mockIpc.tools.importBilibili).toHaveBeenCalledWith(
        "c1",
        "https://www.bilibili.com/video/BV1",
        1080,
        // 手打中文优先于 AI 中文——必须和导入对话框用同一套规则，
        // 否则同一个视频从不同入口导进来会拿到不同字幕。
        "zh-Hans",
        true,
      ),
    );
    // 有字幕就要立刻跑流水线，否则用户还得自己再点一次「开始处理」。
    await waitFor(() => expect(mockIpc.pipeline.process).toHaveBeenCalledWith("newvid"));
  });

  it("没有 cookies 时说清楚，而不是让人对着 412 猜", async () => {
    mockIpc.tools.hasBilibiliCookies.mockResolvedValueOnce(false);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cookies");
    expect(mockIpc.tools.importBilibili).not.toHaveBeenCalled();
  });

  it("导入完成但流水线失败时，重试只继续处理而不重复下载", async () => {
    mockIpc.pipeline.process
      .mockRejectedValueOnce(new Error("服务暂不可用"))
      .mockResolvedValueOnce(undefined);
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          {
            kind: "propose_import",
            url: "https://www.bilibili.com/video/BV1",
            title: "双曲线",
            course_id: "c1",
          },
        ],
      }),
    );
    renderPanel();
    await ask("导入这个");
    fireEvent.click(await screen.findByRole("button", { name: "确认导入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("视频已导入");
    expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试失败的 1 项" }));

    await waitFor(() => expect(screen.getByText("已生效")).toBeInTheDocument());
    expect(mockIpc.tools.importBilibili).toHaveBeenCalledTimes(1);
    expect(mockIpc.pipeline.process).toHaveBeenCalledTimes(2);
    expect(mockIpc.pipeline.process).toHaveBeenNthCalledWith(2, "newvid");
  });

  it("没有课程时导入卡直说而不是提交一个必然失败的请求", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({
        actions: [
          { kind: "propose_import", url: "https://b23.tv/x", title: "线代速成", course_id: null },
        ],
      }),
    );
    renderPanel();
    await ask("把这个导进来");
    expect(await screen.findByText(/还没选课程/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认导入" })).toBeDisabled();
  });
});
