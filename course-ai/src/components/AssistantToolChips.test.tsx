import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AssistantToolChips } from "./AssistantToolChips";

describe("AssistantToolChips", () => {
  it("shows resume learning in user-facing language", () => {
    render(<AssistantToolChips tools={["resume_learning"]} />);
    const chips = screen.getByTestId("tool-chips");
    expect(chips).toHaveTextContent("继续上次学习");
    expect(chips).not.toHaveTextContent("resume_learning");
  });
});
