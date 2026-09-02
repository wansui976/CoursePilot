import "@/i18n";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiGeneration } from "./useAiGeneration";

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
    ai: {
      generate: vi.fn(),
      staleArtifacts: vi.fn(),
    },
  },
}));

vi.mock("@/lib/ipc", () => ({ ipc: mockIpc }));

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Harness() {
  const generation = useAiGeneration("video-1", "summary");
  return (
    <div>
      <button type="button" onClick={generation.start} disabled={generation.isPending}>
        {generation.isPending ? "生成中" : "生成"}
      </button>
      {generation.isError && (
        <button type="button" onClick={generation.start}>
          重试
        </button>
      )}
    </div>
  );
}

describe("useAiGeneration", () => {
  beforeEach(() => {
    mockIpc.ai.generate.mockReset();
    mockIpc.ai.staleArtifacts.mockReset().mockResolvedValue([]);
  });

  it("restores a pending generation after remount and prevents a duplicate request", async () => {
    const pending = deferred();
    mockIpc.ai.generate.mockReturnValueOnce(pending.promise);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await screen.findByRole("button", { name: "生成中" });
    view.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    const restored = screen.getByRole("button", { name: "生成中" });
    expect(restored).toBeDisabled();
    fireEvent.click(restored);
    expect(mockIpc.ai.generate).toHaveBeenCalledTimes(1);

    pending.resolve();
    await waitFor(() => expect(screen.getByRole("button", { name: "生成" })).toBeEnabled());
  });

  it("restores a failed generation and retries with a new mutation", async () => {
    mockIpc.ai.generate
      .mockRejectedValueOnce(new Error("quota exceeded"))
      .mockResolvedValueOnce(undefined);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "生成" }));
    await screen.findByRole("button", { name: "重试" });

    view.unmount();
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "重试" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "重试" })).toBeNull());
    expect(mockIpc.ai.generate).toHaveBeenCalledTimes(2);
  });
});
