import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { WebDavEntry, WebDavSource } from "@/lib/ipc";
import { WebDavImportDialog } from "./WebDavImportDialog";

const { mockIpc, mockMobile } = vi.hoisted(() => ({
  mockMobile: { value: false },
  mockIpc: {
    webdavImport: {
      sources: vi.fn(),
      saveSource: vi.fn(),
      deleteSource: vi.fn(),
      testSource: vi.fn(),
      browse: vi.fn(),
      importStream: vi.fn(),
    },
    downloads: { enqueue: vi.fn() },
    videos: { list: vi.fn() },
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: () => mockMobile.value }));
const { mockOpenUrl } = vi.hoisted(() => ({ mockOpenUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mockOpenUrl }));
const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: mockConfirm }));

const nas: WebDavSource = { id: "nas", kind: "webdav", name: "家里的 NAS", url: "http://nas:5244/dav/", user: "me", hasPassword: true, isSync: false };
const dir = (name: string, path: string): WebDavEntry => ({ name, path, isDir: true, size: null, isVideo: false, url: "" });
const file = (name: string, path: string, isVideo = true): WebDavEntry => ({
  name,
  path,
  isDir: false,
  size: 300 * 1024 * 1024,
  isVideo,
  url: `http://nas:5244/dav/${encodeURI(path)}`,
});

function renderDialog() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <WebDavImportDialog courseId="c1" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

describe("WebDavImportDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    vi.clearAllMocks();
    window.localStorage.clear();
    mockMobile.value = false;
    mockIpc.videos.list.mockResolvedValue([]);
    mockIpc.webdavImport.browse.mockImplementation(async (_source: string, path: string) =>
      path === ""
        ? [dir("申论 2027", "申论 2027/")]
        : [file("第1讲.mp4", "申论 2027/第1讲.mp4"), file("第2讲.mp4", "申论 2027/第2讲.mp4"), file("讲义.pdf", "申论 2027/讲义.pdf", false)],
    );
  });

  it("还没有网盘时先添加，测试连上后保存，接着就能浏览", async () => {
    mockIpc.webdavImport.sources.mockResolvedValueOnce([]).mockResolvedValue([nas]);
    mockIpc.webdavImport.testSource.mockResolvedValue(3);
    mockIpc.webdavImport.saveSource.mockResolvedValue(nas);
    renderDialog();
    fireEvent.change(await screen.findByLabelText("WebDAV 地址"), { target: { value: "http://nas:5244/dav/" } });
    fireEvent.change(screen.getByLabelText("账号"), { target: { value: "me" } });
    fireEvent.change(screen.getByLabelText("密码"), { target: { value: "secret" } });
    fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
    expect(await screen.findByText("连上了，根目录下有 3 项")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockIpc.webdavImport.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://nas:5244/dav/", user: "me", password: "secret" }),
      ),
    );
    expect(await screen.findByRole("button", { name: /申论 2027/ })).toBeInTheDocument();
  });

  it("下载到本机：勾选的视频排进下载队列（只列视频，处理与否按设置）", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockIpc.downloads.enqueue.mockResolvedValue([]);
    const onClose = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /申论 2027/ }));
    expect(await screen.findByLabelText("第1讲.mp4")).toBeInTheDocument();
    expect(screen.queryByLabelText("讲义.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("全选这里的 2 个视频"));
    fireEvent.click(screen.getByRole("button", { name: "导入 2 个视频" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockIpc.downloads.enqueue).toHaveBeenCalledWith("c1", [
      { url: "http://nas:5244/dav/%E7%94%B3%E8%AE%BA%202027/%E7%AC%AC1%E8%AE%B2.mp4", title: "第1讲" },
      { url: "http://nas:5244/dav/%E7%94%B3%E8%AE%BA%202027/%E7%AC%AC2%E8%AE%B2.mp4", title: "第2讲" },
    ]);
    expect(mockIpc.webdavImport.importStream).not.toHaveBeenCalled();
  });

  it("手机上默认在线看：只建条目，不下载", async () => {
    mockMobile.value = true;
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockIpc.webdavImport.importStream.mockResolvedValue(["v1"]);
    const onClose = renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /申论 2027/ }));
    await screen.findByLabelText("第2讲.mp4");
    expect(screen.getByRole("button", { name: "导入" })).toBeDisabled();
    expect(screen.getByText("勾选要导入的视频")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/第2讲\.mp4/));
    expect(screen.getByText("已选 1 / 2 个视频")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /在线看/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "导入 1 个视频" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mockIpc.webdavImport.importStream).toHaveBeenCalledWith("c1", [
      { url: "http://nas:5244/dav/%E7%94%B3%E8%AE%BA%202027/%E7%AC%AC2%E8%AE%B2.mp4", title: "第2讲" },
    ]);
    expect(mockIpc.downloads.enqueue).not.toHaveBeenCalled();
  });

  it("夸克网盘：只要贴一份 Cookie，不要地址和账号", async () => {
    const quark: WebDavSource = { id: "q", kind: "quark", name: "", url: "quark://", user: "", hasPassword: true, isSync: false };
    mockIpc.webdavImport.sources.mockResolvedValueOnce([]).mockResolvedValue([quark]);
    mockIpc.webdavImport.saveSource.mockResolvedValue(quark);
    mockIpc.webdavImport.browse.mockResolvedValue([dir("申论 2027", "fid-1")]);
    renderDialog();
    fireEvent.click(await screen.findByRole("radio", { name: /夸克网盘/ }));
    expect(screen.queryByLabelText("WebDAV 地址")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Cookie"), { target: { value: "b-user=1; __puus=abc" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(mockIpc.webdavImport.saveSource).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "quark", url: "", user: "", password: "b-user=1; __puus=abc" }),
      ),
    );
    // 夸克按文件夹 id 进目录：面包屑记的是走过的名字。
    fireEvent.click(await screen.findByRole("button", { name: /申论 2027/ }));
    await waitFor(() => expect(mockIpc.webdavImport.browse).toHaveBeenCalledWith("q", "fid-1"));
    expect(screen.getByRole("navigation", { name: "当前位置" })).toHaveTextContent("全部申论 2027");
  });

  it("选 OpenList 时有挂百度网盘的步骤，链接用系统浏览器打开", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([]);
    renderDialog();
    fireEvent.click(await screen.findByText("怎么用 OpenList 挂百度网盘（5 步，一次就好）"));
    expect(screen.getByText(/WebDAV 策略」选成「本地代理」/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /api\.oplist\.org/ }));
    expect(mockOpenUrl).toHaveBeenCalledWith("https://api.oplist.org/");
    fireEvent.click(screen.getByRole("radio", { name: /坚果云/ }));
    expect(screen.queryByText("怎么用 OpenList 挂百度网盘（5 步，一次就好）")).not.toBeInTheDocument();
  });
  it("课程里已经有的视频标出来、不能再勾，全选只选剩下的", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockIpc.webdavImport.browse.mockImplementation(async (_source: string, path: string) =>
      path === ""
        ? [dir("申论 2027", "申论 2027/")]
        : ["第1讲", "第2讲", "第3讲"].map((name) => file(`${name}.mp4`, `申论 2027/${name}.mp4`)),
    );
    mockIpc.videos.list.mockResolvedValue([{ id: "v1", source_uri: file("第1讲.mp4", "申论 2027/第1讲.mp4").url }]);
    mockIpc.downloads.enqueue.mockResolvedValue([]);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /申论 2027/ }));
    expect(await screen.findByLabelText("第1讲.mp4")).toBeDisabled();
    expect(screen.getByText("已在课程里")).toBeInTheDocument();
    expect(screen.getByText("1 个已在课程里")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("全选这里的 2 个视频"));
    expect(screen.getByText("已选 2 个 · 600 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导入 2 个视频" }));
    await waitFor(() => expect(mockIpc.downloads.enqueue).toHaveBeenCalled());
    expect(mockIpc.downloads.enqueue.mock.calls[0][1].map((item: { title: string }) => item.title)).toEqual(["第2讲", "第3讲"]);
  });

  it("按住 Shift 连选一段；不知道大小时只报个数", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockIpc.webdavImport.browse.mockImplementation(async (_source: string, path: string) =>
      path === ""
        ? [dir("申论 2027", "申论 2027/")]
        : ["第1讲", "第2讲", "第3讲", "第4讲"].map((name) => ({ ...file(`${name}.mp4`, `申论 2027/${name}.mp4`), size: null })),
    );
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /申论 2027/ }));
    expect(await screen.findByText("勾选要导入的视频，按住 Shift 可以连选")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("第1讲.mp4"));
    fireEvent.keyDown(window, { key: "Shift", shiftKey: true });
    fireEvent.click(screen.getByLabelText("第3讲.mp4"));
    fireEvent.keyUp(window, { key: "Shift", shiftKey: false });
    expect(screen.getByLabelText("第2讲.mp4")).toBeChecked();
    expect(screen.getByLabelText("第4讲.mp4")).not.toBeChecked();
    expect(screen.getByText("已选 3 个")).toBeInTheDocument();
  });

  it("编辑已保存的网盘：不再给换类型，删除要先确认", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    mockIpc.webdavImport.deleteSource.mockResolvedValue(undefined);
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "编辑这个网盘" }));
    expect(screen.queryByRole("radiogroup", { name: "网盘类型" })).not.toBeInTheDocument();
    // 地址是 OpenList 的默认端口：给 OpenList 的提示。
    expect(screen.getByText(/OpenList 能把百度/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "删除这个网盘" }));
    await waitFor(() => expect(mockConfirm).toHaveBeenCalledTimes(1));
    expect(mockIpc.webdavImport.deleteSource).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除这个网盘" }));
    await waitFor(() => expect(mockIpc.webdavImport.deleteSource).toHaveBeenCalledWith("nas"));
  });

  it("读文件夹失败时能直接去改这个网盘的设置", async () => {
    mockIpc.webdavImport.sources.mockResolvedValue([nas]);
    mockIpc.webdavImport.browse.mockRejectedValue(new Error("网盘拒绝了：账号、密码或 Cookie 不对"));
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: "检查这个网盘的设置" }));
    expect(await screen.findByLabelText("WebDAV 地址")).toHaveValue("http://nas:5244/dav/");
  });
});
