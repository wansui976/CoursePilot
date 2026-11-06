-- 课程手动排序与颜色标记。两者都归课程的「意图组」，随 updated_at 一起同步。
-- sort_order 越小越靠前；NULL = 还没排过（新建或从旧版本同步来的），排在最前。
ALTER TABLE courses ADD COLUMN sort_order INTEGER;
-- 预设色板的键（red / orange / …）；NULL = 不标颜色。
ALTER TABLE courses ADD COLUMN color TEXT;

-- 存量课程按原来的列表顺序（updated_at 倒序）编号，升级后侧栏顺序不变。
-- 这是本机的派生回填，不是用户意图：关掉同步触发器，免得每门课都发一次同步。
UPDATE sync_apply_guard SET applying = 1 WHERE singleton = 1;
UPDATE courses SET sort_order = (
  SELECT COUNT(*) FROM courses c2
  WHERE c2.updated_at > courses.updated_at
     OR (c2.updated_at = courses.updated_at AND c2.id < courses.id)
);
UPDATE sync_apply_guard SET applying = 0 WHERE singleton = 1;
