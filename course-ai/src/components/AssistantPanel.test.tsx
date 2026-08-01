import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPanel } from "./AssistantPanel";
import { useAssistantUi } from "@/stores/assistant";
import type { AssistantAction, AssistantReply } from "@/lib/types";

const { mockIpc, platformMock } = vi.hoisted(() => ({
  mockIpc: {
    assistant: { ask: vi.fn() },
    videos: { updateTitle: vi.fn(), delete: vi.fn() },
    settings: { set: vi.fn() },
    tools: { importBilibili: vi.fn() },
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
    actions: [],
    turns: 1,
    tools_used: [],
    history: [],
    ...over,
  };
}

function renderPanel(onNavigate = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AssistantPanel context={{ course_id: "c1", video_id: "v1" }} onNavigate={onNavigate} />
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
  });

  it("收起时只留一个可点开的入口", () => {
    useAssistantUi.setState({ open: false });
    renderPanel();
    expect(screen.queryByLabelText("对助手说")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("打开助手"));
    expect(screen.getByLabelText("对助手说")).toBeInTheDocument();
  });

  it("把界面状态一起发过去，助手才听得懂「这个视频」", async () => {
    renderPanel();
    await ask("这讲了什么");
    await waitFor(() =>
      expect(mockIpc.assistant.ask).toHaveBeenCalledWith(
        "这讲了什么",
        { course_id: "c1", video_id: "v1" },
        [],
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

  it("把调了哪些工具、来回几轮摆出来", async () => {
    mockIpc.assistant.ask.mockResolvedValueOnce(
      reply({ tools_used: ["search_content", "open_video"], turns: 3 }),
    );
    renderPanel();
    await ask("找找看");
    // 每一轮的工具结果都留在上下文里，花销是乘法涨的，不该是笔糊涂账。
    expect(await screen.findByText(/search_content、open_video/)).toBeInTheDocument();
    expect(screen.getByText(/3 轮/)).toBeInTheDocument();
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
    expect(screen.getByLabelText("对助手说")).toBeInTheDocument();
  });
});

describe("确认卡", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    platformMock.mobile = false;
    useAssistantUi.setState({ open: true, side: "right" });
    mockIpc.assistant.ask.mockResolvedValue(reply());
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
  });
});
