# #1 课程级 RAG（跨视频提问与搜索）

日期：2026-07-20
状态：设计
关联：[roadmap](2026-07-20-learning-loop-roadmap.md) · 复用 rag.rs / RagSearchPanel

## 现状

RAG 全部锁在单视频：`cmd_rag_query_stream(video_id, …)` 与
`cmd_search_transcript`→`rag::keyword_search(db, video_id, query, 30)` 都按 `video_id`
过滤。`embeddings(video_id, chunk_text, start_ms, end_ms, vector_json)` 每块只关联视频，
但 `videos.course_id` 可 join 出课程。用户真正想问的是「这门课哪节讲了 X」
「把整门课重点串起来」，现在做不到。

## 目标

- 提问/搜索加**作用域**：本视频 / 本课程 / 全部课程。
- 跨视频回答的引用带**来源视频**信息，点击跳到对应视频并 seek。
- （P3）**概念层**：字幕片段打概念标签，作为 #2/#5 的共享底座。

## 后端

- 检索按 scope 过滤：
  - video：`embeddings.video_id = ?`（现状）。
  - course：`video_id IN (SELECT id FROM videos WHERE course_id = ?)`。
  - all：不过滤。
- 命令加 scope 维度，如 `cmd_rag_query_stream(scope, scope_id, query, history, requestId)`
  与 `cmd_search_transcript(scope, scope_id, query)`；`scope ∈ {video,course,all}`。
- 课程级候选多 → **两段式**：先按视频粗筛（每视频取 topK 后聚合）再全局重排，
  控制喂给 LLM 的上下文量与延迟。
- `Citation` 扩展 `video_id` + `video_title`（现只有 start_ms/text/index）。

## 概念层（P3，共享底座）

新增迁移：`concepts(id, course_id, name)` 与
`segment_concepts(embedding_id, concept_id)`；处理后由 AI 抽取/归并概念标签。
供 #2 卡片成组、#5 薄弱主题、#6 「相关概念还在哪讲过」。

## UI

- 提问框/搜索框加**作用域切换器**（本视频/本课程/全部）。
- 引用**按视频分组**展示；点击 → `openVideo(videoId)` + `requestSeek(startMs)`
  （复用 Home 既有的打开视频 + player requestSeek）。
- 课程级综合问法引导语：「总结整门课」「第 5 讲与第 7 讲对 X 的讲法差异」等建议 chip。

## 分阶段

- **P1**：course 作用域检索 + 跨视频引用带来源 + 点击跨视频跳转。
- **P2**：all-courses 作用域；两段式重排优化。
- **P3**：概念层抽取与索引（为 #2/#5 铺路）。

## 测试

- 后端：course 作用域检索只命中该课程视频；引用含 video_id/title。
- 前端：切到「本课程」后 `ragQueryStream` 收到 course scope；引用分组渲染；
  点击引用触发 openVideo + requestSeek。
