import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BINDINGS, useShortcuts } from "./shortcuts";

describe("快捷键改键", () => {
  beforeEach(() => {
    localStorage.clear();
    useShortcuts.getState().resetBindings();
  });

  it("新键被别的动作占着时两边互换，不把那个动作清空", () => {
    const playKey = DEFAULT_BINDINGS.playPause;
    const noteKey = DEFAULT_BINDINGS.takeNote;
    const swap = useShortcuts.getState().setBinding("takeNote", playKey);
    expect(swap).toEqual({ action: "playPause", key: noteKey });
    expect(useShortcuts.getState().bindings.takeNote).toBe(playKey);
    expect(useShortcuts.getState().bindings.playPause).toBe(noteKey);
  });

  it("新键没被占用时没有交换", () => {
    expect(useShortcuts.getState().setBinding("takeNote", "b")).toBeNull();
    expect(useShortcuts.getState().bindings.takeNote).toBe("b");
  });
});
