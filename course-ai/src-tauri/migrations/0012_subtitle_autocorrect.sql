-- 视频级「字幕 AI 纠错」偏好（B站导入对话框里选）；
-- NULL = 跟随全局设置 subtitle_autocorrect。
ALTER TABLE videos ADD COLUMN subtitle_autocorrect BOOLEAN;
