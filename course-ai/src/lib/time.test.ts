import { describe, expect, it } from "vitest";
import { formatMs } from "./time";

describe("formatMs", () => {
  it("formats zero", () => {
    expect(formatMs(0)).toBe("00:00");
  });

  it("formats mm:ss", () => {
    expect(formatMs(83_000)).toBe("01:23");
  });

  it("formats hh:mm:ss when at least one hour", () => {
    expect(formatMs(3_725_000)).toBe("01:02:05");
  });

  it("clamps negative values to zero", () => {
    expect(formatMs(-500)).toBe("00:00");
  });
});
