-- 解释所依据的字幕上下文指纹。重新分析时上下文未变即可复用上一轮的解释，
-- 免掉「每个知识点一次 LLM 调用」的重复开销（新增/变动的知识点才真正重算）。
ALTER TABLE concepts ADD COLUMN explanation_source TEXT;
