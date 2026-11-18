-- 网盘（WebDAV）同步：每台设备只往网盘里自己的文件夹追加「变更批次」文件，
-- 这里记着从别的每台设备读到了哪一个批次，下次只取更新的。
CREATE TABLE IF NOT EXISTS sync_remote_cursors (
  device_id   TEXT PRIMARY KEY NOT NULL,
  last_batch  TEXT NOT NULL,
  device_name TEXT,
  platform    TEXT,
  seen_at     INTEGER NOT NULL
);
