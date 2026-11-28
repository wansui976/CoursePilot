import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChaoxingImportDialog } from "./ChaoxingImportDialog";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    chaoxing: {
      status: vi.fn(),
      login: vi.fn(),
      setCookies: vi.fn(),
      logout: vi.fn(),
      courses: vi.fn(),
      courseVideos: vi.fn(),
    },
    downloads: { enqueue: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

const COURSE = { courseId: "1", clazzId: "2", cpi: "3", title: "机器学习", teacher: "张老师" };
const VIDEOS = [
  { url: "https://mooc1.chaoxing.com/ananas/status/a", objectId: "a", title: "1.1 绪论", chapter: "第一章" },
  { url: "https://mooc1.chaoxing.com/ananas/status/b", objectId: "b", title: "1.2 历史", chapter: "第一章" },
  { url: "https://mooc1.chaoxing.com/ananas/status/c", objectId: "c", title: "2.1 回归", chapter: "第二章" },
];

function renderDialog(onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ChaoxingImportDialog courseId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose };
}

describe("ChaoxingImportDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    for (const fn of Object.values(mockIpc.chaoxing)) fn.mockReset();
    mockIpc.downloads.enqueue.mockReset().mockResolvedValue([]);
    mockIpc.chaoxing.courseVideos.mockResolvedValue(VIDEOS);
  });

  it("没登录先登录；登录后选课、按章勾选，交给下载队列", async () => {
    mockIpc.chaoxing.status.mockResolvedValue({ loggedIn: false });
    mockIpc.chaoxing.login.mockResolvedValue([COURSE]);
    const { onClose } = renderDialog();

    fireEvent.change(await screen.findByLabelText("手机号 / 学号"), { target: { value: " 138 " } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(mockIpc.chaoxing.login).toHaveBeenCalledWith("138", "pw"));

    fireEvent.click(await screen.findByRole("button", { name: /机器学习/ }));
    // 默认全选；取消第一章整组，只剩第二章那一个。
    fireEvent.click(await screen.findByRole("checkbox", { name: "第一章" }));
    expect(screen.getByText("已选 1 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^导入 1 / }));

    await waitFor(() =>
      expect(mockIpc.downloads.enqueue).toHaveBeenCalledWith("c1", [
        { url: "https://mooc1.chaoxing.com/ananas/status/c", title: "2.1 回归" },
      ]),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("存着 Cookie 时直接列课程；Cookie 失效回到登录", async () => {
    mockIpc.chaoxing.status.mockResolvedValue({ loggedIn: true });
    mockIpc.chaoxing.courses.mockResolvedValue([COURSE]);
    mockIpc.chaoxing.courseVideos.mockRejectedValue("超星登录已失效，请重新登录");
    renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: /机器学习/ }));
    expect(await screen.findByLabelText("手机号 / 学号")).toBeInTheDocument();
  });

  it("粘贴 Cookie 登录", async () => {
    mockIpc.chaoxing.status.mockResolvedValue({ loggedIn: false });
    mockIpc.chaoxing.setCookies.mockResolvedValue([]);
    renderDialog();

    fireEvent.click(await screen.findByRole("tab", { name: "粘贴 Cookie" }));
    fireEvent.change(screen.getByLabelText("Cookie"), { target: { value: "fid=1; _uid=2" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));
    await waitFor(() => expect(mockIpc.chaoxing.setCookies).toHaveBeenCalledWith("fid=1; _uid=2"));
    expect(await screen.findByText(/这个账号下没有能看的课程/)).toBeInTheDocument();
  });
});
