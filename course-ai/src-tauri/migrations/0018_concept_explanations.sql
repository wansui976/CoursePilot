-- 每个知识点一段 AI 解释（依据其字幕片段，分析时预生成），供知识点展开时展示。
ALTER TABLE concepts ADD COLUMN explanation TEXT;
