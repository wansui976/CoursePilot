-- 云端分段识别的断点缓存。
--
-- 云端识别是整条流水线上最贵的一步：既是分钟级的等待，也是真金白银。而它内部是分片
-- 并发跑的——一节两小时的课切成二十多片。中途退出（用户点停、应用崩溃、机器休眠被杀）
-- 时，已经识别完、已经付过钱的那十几片会连同结果一起丢掉，下次从第一片重来。
--
-- 键取**分片音频内容 + 识别参数**的哈希，不是序号：
--   - 同一段音频重跑必然算出同一个键，所以断点续跑天然命中；
--   - 源文件换了、切片长度改了、热词改了，键就跟着变，不会拿旧结果冒充新结果；
--   - 万一 ffmpeg 的输出不是逐字节可复现，最坏也只是命不中，退化成今天的行为。
--
-- 识别成功落库之后这份缓存会被清掉：它只为「这一次识别被打断」而存在，不是长期缓存
-- ——留着的话，用户明确要求「重新处理」时会静默拿回旧结果。
CREATE TABLE asr_chunk_results (
  video_id        TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  chunk_key       TEXT NOT NULL,
  transcript_json TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (video_id, chunk_key)
);
