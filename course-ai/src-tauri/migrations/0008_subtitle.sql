-- 待用的 B站自带字幕：导入时写入，ASR 阶段消化后将 path 置空、保留 lang 作来源展示。
ALTER TABLE videos ADD COLUMN subtitle_path TEXT;
ALTER TABLE videos ADD COLUMN subtitle_lang TEXT;
