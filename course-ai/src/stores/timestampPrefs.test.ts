import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTimestampPrefs } from "./timestampPrefs";

describe("timestampPrefs store", () => {
  beforeEach(() => {
    localStorage.clear();
    // 复位到默认，避免用例间串味。
    useTimestampPrefs.setState({ showTimestamps: true });
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to showing timestamps", () => {
    expect(useTimestampPrefs.getState().showTimestamps).toBe(true);
  });

  it("toggle flips the flag and persists it to localStorage", () => {
    useTimestampPrefs.getState().toggle();
    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("0");

    useTimestampPrefs.getState().toggle();
    expect(useTimestampPrefs.getState().showTimestamps).toBe(true);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("1");
  });

  it("setShow writes the explicit value", () => {
    useTimestampPrefs.getState().setShow(false);
    expect(useTimestampPrefs.getState().showTimestamps).toBe(false);
    expect(localStorage.getItem("course-ai-show-timestamps")).toBe("0");
  });
});
