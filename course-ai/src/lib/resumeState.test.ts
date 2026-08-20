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
      activeTab: "notes",
      notesScrollTop: 120,
    });

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: "notes",
      notesScrollTop: 120,
      transcriptScrollTop: 0,
      studyPanelWidth: null,
      studyPanelCollapsed: false,
    });
    expect(readVideoResumeState("video-2").activeTab).toBeNull();
  });

  it("merges updates into existing state", () => {
    writeVideoResumeState("video-1", { activeTab: "notes" });
    writeVideoResumeState("video-1", { transcriptScrollTop: 240 });

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: "notes",
      transcriptScrollTop: 240,
    });
  });

  it("keeps the legacy transcriptTopIndex across unrelated writes until migrated", () => {
    localStorage.setItem(
      resumeStateKey("video-1"),
      JSON.stringify({ transcriptTopIndex: 42 }),
    );

    writeVideoResumeState("video-1", { activeTab: "notes" });
    expect(readVideoResumeState("video-1").transcriptTopIndex).toBe(42);

    writeVideoResumeState("video-1", {
      transcriptScrollTop: 500,
      transcriptTopIndex: 0,
    });
    expect(readVideoResumeState("video-1")).toMatchObject({
      transcriptScrollTop: 500,
      transcriptTopIndex: 0,
    });
  });

  it.each([
    ["AI 概览", "overview"],
    ["学习", "notes"],
    ["课件", "more"],
    ["片段", "more"],
  ])("migrates the legacy '%s' active tab to '%s'", (legacy, expected) => {
    localStorage.setItem(
      resumeStateKey("video-1"),
      JSON.stringify({ activeTab: legacy }),
    );

    expect(readVideoResumeState("video-1").activeTab).toBe(expected);
  });

  it("falls back to defaults when stored state is invalid", () => {
    localStorage.setItem(resumeStateKey("video-1"), "{bad json");

    expect(readVideoResumeState("video-1")).toMatchObject({
      activeTab: null,
      notesScrollTop: 0,
      transcriptScrollTop: 0,
      studyPanelWidth: null,
      studyPanelCollapsed: false,
    });
  });

  it("stores the study panel collapsed state per video", () => {
    writeVideoResumeState("video-1", { studyPanelCollapsed: true });

    expect(readVideoResumeState("video-1").studyPanelCollapsed).toBe(true);
    expect(readVideoResumeState("video-2").studyPanelCollapsed).toBe(false);
  });
});
