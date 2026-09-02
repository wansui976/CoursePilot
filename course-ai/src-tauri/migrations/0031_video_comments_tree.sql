-- 评论区升级为「根评论 + 楼中楼回复」的树形结构：
-- rpid 是 B 站评论自身的 id（超过 JS 安全整数，必须按字符串存/传），
-- parent_rpid 指向所属根评论（NULL = 根评论本身），reply_count 是根评论的回复总数。
-- (video_id, rpid) 唯一：并发触发两次抓取时后写的一方被 INSERT OR IGNORE 挡住。
ALTER TABLE video_comments ADD COLUMN rpid TEXT;
ALTER TABLE video_comments ADD COLUMN parent_rpid TEXT;
ALTER TABLE video_comments ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_video_comments_parent ON video_comments(video_id, parent_rpid);
CREATE UNIQUE INDEX idx_video_comments_rpid
  ON video_comments(video_id, rpid) WHERE rpid IS NOT NULL;
