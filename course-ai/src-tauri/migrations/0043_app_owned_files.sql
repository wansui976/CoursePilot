-- 视频文件是不是应用自己下载到这台设备上的。永久删除只删这种文件。
--
-- 不能按 source_type 判断：同步来的 B 站 / 网络视频行在对端下载，到本机文件路径是空的，
-- 「重新关联课程文件夹」会把它指向用户自己的那份文件——按类型删就把用户的原片删了。
-- 这一列只在本机下载时置 1，重新关联时清零；不参与同步。
ALTER TABLE videos ADD COLUMN app_owned_file INTEGER NOT NULL DEFAULT 0;

-- 已有的下载视频按下载算（与升级前删除时的判断一致）；本机路径为空的同步行不算。
UPDATE videos SET app_owned_file = 1 WHERE source_type <> 'local' AND file_path <> '';
