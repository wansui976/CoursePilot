-- 同步收方向（apply）的最小结构扩展。合并律见 docs/2026-08-04-sync-merge-laws.md。
--
-- 1) 删除态需要自己的钟。合并按字段组进行：改名等意图编辑与「进/出回收站」各走各的
--    LWW，否则并发的「A 删、B 改」只能二选一——正确结果是带着新内容躺进回收站，
--    这要求两组各有各的最后修改时间。意图组沿用 sync_updated_at / updated_at；
--    删除组用这里新增的 trash_changed_at，删除与恢复时都拨它。
--    存量行回填为 COALESCE(deleted_at, created_at)；新行允许为 NULL，
--    读取方一律用同样的 COALESCE 兜底。
ALTER TABLE videos  ADD COLUMN trash_changed_at INTEGER;
ALTER TABLE courses ADD COLUMN trash_changed_at INTEGER;
UPDATE videos  SET trash_changed_at = COALESCE(deleted_at, created_at);
UPDATE courses SET trash_changed_at = COALESCE(deleted_at, created_at);

-- 2) 并发检测的「基准」。笔记是唯一双方都可能是大段人写内容的记录，静默丢一方
--    不可接受。基准记录「上次与对端达成一致时的内容指纹」：本地当前内容偏离基准
--    即说明本地在此之后改过；此时远端更新的到达不是快进而是并发，败方全文
--    存入 sync_conflicts 而不是被覆盖掉。基准在两处刷新：并入远端保存时、
--    本机外发被确认时。
CREATE TABLE sync_apply_basis (
  record_type  TEXT NOT NULL,
  record_id    TEXT NOT NULL,
  stamp_ms     INTEGER NOT NULL,
  content_hash TEXT,
  PRIMARY KEY (record_type, record_id)
);
