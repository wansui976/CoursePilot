import { invoke } from "@tauri-apps/api/core";
import type { ChaoxingCourse, ChaoxingVideo } from "./types";

/**
 * 超星 / 学习通导入。登录只存 Cookie（在密钥存储里），密码用完即弃；选好的视频交给
 * 下载队列（`downloads.enqueue`），地址是 `ananas/status/<objectId>`。
 */
export const chaoxing = {
  status: (): Promise<{ loggedIn: boolean }> => invoke("cmd_chaoxing_status"),
  /** 账号密码登录，成功后直接返回课程列表。 */
  login: (username: string, password: string): Promise<ChaoxingCourse[]> =>
    invoke("cmd_chaoxing_login", { username, password }),
  /** 粘贴浏览器里的 Cookie 登录（学校统一认证的账号）。 */
  setCookies: (cookies: string): Promise<ChaoxingCourse[]> =>
    invoke("cmd_chaoxing_set_cookies", { cookies }),
  logout: (): Promise<void> => invoke("cmd_chaoxing_logout"),
  courses: (): Promise<ChaoxingCourse[]> => invoke("cmd_chaoxing_courses"),
  /** 列出一门课的视频；进度见 `chaoxing:list-progress` 事件（带 requestId）。 */
  courseVideos: (course: ChaoxingCourse, requestId: string): Promise<ChaoxingVideo[]> =>
    invoke("cmd_chaoxing_course_videos", { course, requestId }),
};
