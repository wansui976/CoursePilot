// 首次使用向导看过没有：记在本机。识别模型和 Key 都是这台设备自己的配置，换台设备要重新配。

const DONE_KEY = "course-ai-setup-wizard-done";

export function setupWizardSeen(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markSetupWizardSeen() {
  try {
    window.localStorage.setItem(DONE_KEY, "1");
  } catch {
    // 存不进去就只在这次会话里不再出现。
  }
}
