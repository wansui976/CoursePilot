-- 课程复习资料：整门课的笔记按知识逻辑重排成分章的复习资料。
-- outline_json：[{title,intro,sections:[小节键]}]。小节键由「视频 + 第几节 + 节标题」算出，
-- 笔记只改正文、不增删小节时不变，目录就不必重排。
CREATE TABLE course_review_books (
  course_id    TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  outline_json TEXT NOT NULL,
  generated_at INTEGER NOT NULL
);

-- 每章一行。content_md 为 NULL 表示还没写成；fingerprint 是写这版正文时所用素材的指纹，
-- 和当前素材的指纹不同就是「素材有变化」。sources_json 是正文里出处编号 → 视频与时间，
-- 跟着这版正文存：编号每次生成都会重排，旧正文得配旧的对照表。
CREATE TABLE course_review_chapters (
  course_id    TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,
  title        TEXT NOT NULL,
  intro        TEXT NOT NULL DEFAULT '',
  content_md   TEXT,
  sources_json TEXT,
  quiz_json    TEXT,
  fingerprint  TEXT NOT NULL DEFAULT '',
  error        TEXT,
  generated_at INTEGER,
  PRIMARY KEY (course_id, idx)
);
