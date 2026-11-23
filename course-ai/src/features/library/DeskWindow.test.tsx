import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "@/i18n";
import { DeskWindow } from "./DeskWindow";

describe("DeskWindow", () => {
  it("shows the time of day without a place", () => {
    const { container } = render(<DeskWindow part="night" weather={null} />);
    expect(container.querySelector("figcaption")).toBeNull();
    expect(container.querySelector(".ca-window-fall")).toBeNull();
  });

  it("rains and names the place, weather and temperature", () => {
    const { container } = render(
      <DeskWindow
        part="day"
        weather={{ condition: "rain", is_day: true, temperature_c: 9.6, sunrise_ms: null, sunset_ms: null, fetched_at: 0 }}
        placeName="上海"
      />,
    );
    expect(container.querySelector(".ca-window-fall.rain")).not.toBeNull();
    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("上海");
    expect(container.querySelector("figcaption")?.textContent).toMatch(/10°/);
  });
});
