import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { ErrorNote } from "./ErrorNote";

describe("ErrorNote localization", () => {
  afterEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  it("renders the error guidance and retry action in English", async () => {
    await i18n.changeLanguage("en");
    const retry = vi.fn();

    render(<ErrorNote error="timed out" onRetry={retry} />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The request timed out. Check your network and retry.",
    );
    const button = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("重试")).not.toBeInTheDocument();
  });
});
