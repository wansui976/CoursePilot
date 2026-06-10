import { beforeEach, describe, expect, it } from "vitest";
import {
  readVideoResumeState,
  resumeStateKey,
  writeVideoResumeState,
} from "./resumeState";

describe("resumeState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores partial resume state for one video without affecting others", () => {
    writeVideoResumeState("video-1", {
      activeTab: "笔记",
      notesScrollTop: 120,
    });

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: "笔记",
      notesScrollTop: 120,
      transcriptScrollTop: 0,
      studyPanelWidth: null,
    });
    expect(readVideoResumeState("video-2").activeTab).toBeNull();
  });

  it("merges updates into existing state", () => {
    writeVideoResumeState("video-1", { activeTab: "笔记" });
    writeVideoResumeState("video-1", { transcriptScrollTop: 240 });

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: "笔记",
      transcriptScrollTop: 240,
    });
  });

  it("falls back to defaults when stored state is invalid", () => {
    localStorage.setItem(resumeStateKey("video-1"), "{bad json");

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: null,
      notesScrollTop: 0,
      transcriptScrollTop: 0,
      studyPanelWidth: null,
    });
  });
});
