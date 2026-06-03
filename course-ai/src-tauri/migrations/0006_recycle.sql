-- 回收站：软删除。视频/课程被删时只置 deleted_at，30 天后由后台清理永久删除，期间可恢复。
ALTER TABLE videos ADD COLUMN deleted_at INTEGER;
ALTER TABLE courses ADD COLUMN deleted_at INTEGER;
CREATE INDEX idx_videos_deleted ON videos(deleted_at);
CREATE INDEX idx_courses_deleted ON courses(deleted_at);
