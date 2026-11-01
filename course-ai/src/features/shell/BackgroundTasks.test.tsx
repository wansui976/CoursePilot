import "@testing-library/jest-dom/vitest";
import "@/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { taskMeta, type TaskMeta } from "@/lib/backgroundTasks";
import { useTaskNotices } from "@/lib/taskNotices";
import { BackgroundTasksButton, TaskCompletionNotices } from "./BackgroundTasks";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function Runner({ wait, kind = "summary" as const }: { wait: Promise<void>; kind?: "summary" }) {
  const mutation = useMutation({ meta: taskMeta(kind, { videoId: "v1" }), mutationFn: () => wait });
  const { mutate } = mutation;
  useEffect(() => mutate(), [mutate]);
  return null;
}

function setup(isWatching: (task: TaskMeta) => boolean = () => false) {
  const gate = deferred();
  const onOpenTask = vi.fn();
  const client = new QueryClient();
  client.setQueryData(["videos", "c1"], [{ id: "v1", title: "梯度下降的直觉" }]);
  render(
    <QueryClientProvider client={client}>
      <Runner wait={gate.promise} />
      <BackgroundTasksButton variant="sidebar" onOpenTask={onOpenTask} />
      <TaskCompletionNotices isWatching={isWatching} onOpenTask={onOpenTask} bottomOffset={0} />
    </QueryClientProvider>,
  );
  return { gate, onOpenTask };
}

describe("BackgroundTasks", () => {
  beforeEach(() => {
    useTaskNotices.setState({ notices: [] });
  });

  it("有任务在跑时出现入口，列表里点一项打开那项任务", async () => {
    const { onOpenTask } = setup();
    const trigger = await screen.findByRole("button", { name: /后台任务/ });
    fireEvent.click(trigger);
    const item = screen.getByRole("menuitem", { name: /生成摘要/ });
    expect(item).toHaveTextContent("梯度下降的直觉");
    fireEvent.click(item);
    expect(onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ kind: "summary", videoId: "v1" }));
  });

  it("跑完后入口消失，并在用户没看着时弹出完成提示", async () => {
    const { gate, onOpenTask } = setup();
    await screen.findByRole("button", { name: /后台任务/ });
    await act(async () => gate.resolve());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /后台任务/ })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("生成摘要已完成")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(onOpenTask).toHaveBeenCalled();
  });

  it("删除视频后清掉它残留的完成提示", async () => {
    const { gate } = setup();
    await screen.findByRole("button", { name: /后台任务/ });
    await act(async () => gate.resolve());
    expect(await screen.findByText("生成摘要已完成")).toBeInTheDocument();

    act(() => useTaskNotices.getState().clearScope({ videoId: "v1" }));
    expect(screen.queryByText("生成摘要已完成")).not.toBeInTheDocument();
  });

  it("用户正看着结果时不打扰", async () => {
    const { gate } = setup(() => true);
    await screen.findByRole("button", { name: /后台任务/ });
    await act(async () => gate.resolve());
    expect(screen.queryByText("生成摘要已完成")).not.toBeInTheDocument();
  });
});
