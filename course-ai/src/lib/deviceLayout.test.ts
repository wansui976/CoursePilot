import { describe, expect, it } from "vitest";
import { detectDeviceLayout } from "./deviceLayout";

describe("detectDeviceLayout", () => {
  it("treats iPhone-style user agents as phone layouts", () => {
    expect(
      detectDeviceLayout({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
        orientation: "portrait-primary",
      }),
    ).toBe("phone");
  });

  it("treats iPad portrait as tablet portrait", () => {
    expect(
      detectDeviceLayout({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        platform: "iPad",
        maxTouchPoints: 5,
        orientation: "portrait-primary",
      }),
    ).toBe("tablet-portrait");
  });

  it("treats iPad landscape as tablet landscape", () => {
    expect(
      detectDeviceLayout({
        userAgent:
          "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        platform: "iPad",
        maxTouchPoints: 5,
        orientation: "landscape-primary",
      }),
    ).toBe("tablet-landscape");
  });

  it("falls back to desktop for notebook and desktop user agents", () => {
    expect(
      detectDeviceLayout({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
        orientation: "landscape-primary",
      }),
    ).toBe("desktop");
  });
});
