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
  },
}));
vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));
vi.mock("@/lib/platform", () => ({ isMobile: () => mockMobile.value }));
const { mockOpenUrl } = vi.hoisted(() => ({ mockOpenUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mockOpenUrl }));

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
    mockMobile.value = false;
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
});
