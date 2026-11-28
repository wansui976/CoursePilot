-- 每个视频的讲稿改过几次。检索把整门课的讲稿读进内存缓存，靠它判断哪些视频的缓存过时了。
-- 写讲稿的地方有好几处（识别、纠错、手改、同步），放在触发器里一处都漏不掉。
-- 只在本机用，不进同步。
CREATE TABLE IF NOT EXISTS transcript_revisions (
  video_id TEXT PRIMARY KEY,
  rev INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS transcript_revision_on_insert
AFTER INSERT ON transcripts
BEGIN
  INSERT INTO transcript_revisions(video_id, rev) VALUES (NEW.video_id, 1)
  ON CONFLICT(video_id) DO UPDATE SET rev = rev + 1;
END;

CREATE TRIGGER IF NOT EXISTS transcript_revision_on_update
AFTER UPDATE ON transcripts
BEGIN
  INSERT INTO transcript_revisions(video_id, rev) VALUES (OLD.video_id, 1)
  ON CONFLICT(video_id) DO UPDATE SET rev = rev + 1;
  INSERT INTO transcript_revisions(video_id, rev) VALUES (NEW.video_id, 1)
  ON CONFLICT(video_id) DO UPDATE SET rev = rev + 1;
END;

CREATE TRIGGER IF NOT EXISTS transcript_revision_on_delete
AFTER DELETE ON transcripts
BEGIN
  INSERT INTO transcript_revisions(video_id, rev) VALUES (OLD.video_id, 1)
  ON CONFLICT(video_id) DO UPDATE SET rev = rev + 1;
END;
