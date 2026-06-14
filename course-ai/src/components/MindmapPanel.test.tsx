import "@testing-library/jest-dom/vitest";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { MindmapPanel } from "./MindmapPanel";
import { useTheme } from "@/stores/theme";

const { mockSetData, mockFit, mockRescale, mockCreate, mockTransform } = vi.hoisted(
  () => {
    const mockSetData = vi.fn();
    const mockFit = vi.fn();
    const mockRescale = vi.fn();
    const mockCreate = vi.fn(() => ({
      setData: mockSetData,
      fit: mockFit,
      rescale: mockRescale,
    }));
    const mockTransform = vi.fn(() => ({ root: { id: "root" } }));
    return { mockSetData, mockFit, mockRescale, mockCreate, mockTransform };
  },
);

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: "# 根\n- 子节点", isLoading: false }),
}));

vi.mock("markmap-lib", () => ({
  Transformer: vi.fn(function Transformer() {
    return {
      transform: mockTransform,
    };
  }),
}));

vi.mock("markmap-view", () => ({
  Markmap: {
    create: mockCreate,
  },
}));

vi.mock("@/lib/ipc", () => ({
  ipc: {
    ai: {
      getMindmap: vi.fn(),
    },
  },
}));

describe("MindmapPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    useTheme.getState().setPref("dark");
    mockSetData.mockClear();
    mockFit.mockClear();
    mockRescale.mockClear();
    mockCreate.mockClear();
    mockTransform.mockClear();
  });

  afterEach(() => {
    useTheme.getState().setPref("light");
  });

  it("applies the dark markmap theme in dark mode", async () => {
    const { container } = render(<MindmapPanel videoId="video-1" />);

    expect(container.firstElementChild).toHaveClass("markmap-dark");

    await waitFor(() => {
      expect(mockCreate).toHaveBeenCalled();
      expect(mockTransform).toHaveBeenCalledWith("# 根\n- 子节点");
      expect(mockSetData).toHaveBeenCalled();
      expect(mockFit).toHaveBeenCalled();
    });
  });
});
