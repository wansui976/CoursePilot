-- 笔记页边的铅笔批注：AI 读完笔记后在页边写的建议（补漏、纠错、追问、联系前后）。
-- 只是批注，不改笔记原文；用户可以一条条擦掉。只存本机，不进同步。
CREATE TABLE IF NOT EXISTS note_annotations (
  video_id   TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  quote      TEXT NOT NULL,
  note       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (video_id, id)
);
