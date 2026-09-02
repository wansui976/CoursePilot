-- 楼中楼的楼中楼 + 头像：
-- direct_parent_rpid 是回复的「直接父回复」（回复另一条回复时指向那条，层级由此而来；
-- parent_rpid 继续只表示归属的根评论，供分组）。avatar 是 B 站头像图 URL。
ALTER TABLE video_comments ADD COLUMN direct_parent_rpid TEXT;
ALTER TABLE video_comments ADD COLUMN avatar TEXT;
