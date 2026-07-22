# 概念层地基（#1 P3）设计

日期：2026-07-22
状态：已批准方向（用户确认 主题级粒度 / 按需课程级抽取 / 只做地基）
关联：[learning-loop-roadmap](../../2026-07-20-learning-loop-roadmap.md) ·
[course-level-rag](../../2026-07-20-course-level-rag-design.md)

## 目标与边界

给一门课的字幕片段打**主题级概念标签**，作为 #2（卡片按概念成组）、#5（薄弱主题）、
#6（相关概念还在哪讲过）的共享底座。**本次只做地基**，不接入 #2/#5：

- 交付：迁移 schema + 课程级抽取管线/命令 + 概念列表面板（点概念 → 看在哪讲过 → 跨视频跳转）。
- 不做（各自后续增量）：卡片按概念成组、仪表盘薄弱主题、跨课程、抽取进度流式、
  同义词 LLM 归并。

### 定下的三个设计点

1. **粒度＝主题级**：每门课几十个可命名知识点（如「贝叶斯定理」「参数方程求导」），
   一个概念跨多个片段/视频，**按规范名合并**。不是章节大块，也不是逐术语。
2. **抽取＝按需 · 课程级一次性**：用户点「分析本课程概念」时，把该课程各视频字幕
   逐个抽取再合并，一次成型；可重跑（替换旧结果）。不进自动处理管线（省成本）。
3. **范围＝只做地基**（见上）。

## 技术方案：每视频 map + 本地按名合并

对比过三种：

- ✅ **每视频 map + 本地按名合并**（采用）：逐视频让 LLM 抽「主题名 + 代表时间点」，
  长视频按字符分块（复用 RAG 的 `split_by_chars`）；再把各视频的抽取结果按**规范化名**
  本地精确合并、聚合出现位置。map 的解析、merge 的合并都是纯函数，可单测；只有
  「调 LLM 抽取」是集成环节，需在 Mac 上验。
- ❌ 全课字幕拼成一次调用：大课程必然超出上下文窗口。
- ❌ 向量聚类：项目未为关键词 RAG 建 embeddings，过重且无命名。

v1 合并用**本地精确合并**（规范化后同名即合并），不做「LLM 归并同义词」——留作后续优化
（YAGNI）。代价：同一主题在不同视频用了不同措辞时不会合并；主题级粒度下可接受。

## 1. 存储（迁移 `0015_concepts.sql`）

沿用现有「事件/卡片表无硬外键」的风格，重跑时按 course_id 删旧插新即可，无需级联。

```sql
CREATE TABLE concepts (
  id         TEXT PRIMARY KEY,
  course_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX ux_concepts_course_name ON concepts(course_id, name);
CREATE INDEX ix_concepts_course ON concepts(course_id);

CREATE TABLE concept_occurrences (
  concept_id TEXT NOT NULL,
  video_id   TEXT NOT NULL,
  start_ms   INTEGER NOT NULL,
  PRIMARY KEY (concept_id, video_id, start_ms)
);
CREATE INDEX ix_concept_occ_concept ON concept_occurrences(concept_id);
```

- `UNIQUE(course_id, name)`：同一课程内概念名唯一（合并的落库保证）。
- `concept_occurrences`：该概念在哪个视频哪个时间点讲到；`start_ms` 是 LLM 给的**代表
  时间点**（用于「回看」跳转），不要求正好对齐某字幕段边界。
- **重跑语义**：分析某课程时，在一个事务里先 `DELETE` 该 course_id 的 concepts 与其
  occurrences，再插入新结果——「替换」而非「累加」。

## 2. 抽取管线（新文件 `src-tauri/src/pipeline/concepts.rs`）

### 纯函数（可单测，不碰 LLM/DB）

```rust
/// 一条抽取结果：主题名 + 代表时间点（毫秒，由 LLM 的 "at" 时间戳字符串解析而来）。
pub struct RawConcept { pub name: String, pub start_ms: i64 }

/// 合并后的概念：规范展示名 + 各出现位置（video_id, start_ms）。无 id（入库时再分配）。
pub struct MergedConcept { pub name: String, pub occurrences: Vec<(String, i64)> }

/// 容错解析 LLM 输出的 JSON 数组 `[{"name":"..","at":"mm:ss"}]`。
/// - 非数组 / 非法 JSON → 空。
/// - 缺 name、或 at 解析不出时间 → 跳过该条。
/// - 多余字段忽略；at 支持 mm:ss 与 h:mm:ss。
pub fn parse_concepts_json(raw: &str) -> Vec<RawConcept>;

/// 把各视频的抽取结果按规范化名合并。
/// - 规范化 = trim + 折叠内部空白 + ASCII 小写（中文不受影响）；用于判同名。
/// - 展示名取该规范名下**首次出现**的原始写法。
/// - occurrences 去重（同 concept+video+start_ms 只留一条）。
/// - 返回按「出现次数降序、再按名升序」排序，便于「讲得最多的在前」。
pub fn merge_by_name(raw: Vec<(String /*video_id*/, RawConcept)>) -> Vec<MergedConcept>;
```

`parse_concepts_json` 内部把 `"at"` 时间戳串解析成毫秒（新增小工具 `parse_mmss(&str) -> Option<i64>`，
与 rag/pipeline 里 mm:ss 格式对齐）。

### 编排（集成，Mac 验）

```rust
/// 分析整门课的概念：逐视频抽取 → 合并 → 事务替换入库。返回入库的概念数。
/// - 复用 AiTask::Summary 的 LLM Profile 路由（与「摘要」同一 Profile；避免新增 task/设置项）。
///   未配置该 Profile 时报 Config 错误，前端提示去「设置 → LLM」。
/// - 逐视频取 transcript_text（已是 `[mm:ss] 文本`），长则用 split_by_chars 分块，逐块抽取。
/// - 无字幕的视频跳过；全课都没字幕 → 返回 0（前端提示先处理字幕）。
pub async fn analyze_course_concepts(
    db: &Db, provider: &Provider, chat_model: &str, course_id: &str,
) -> AppResult<usize>;
```

- map 提示（每块）：让模型只输出 JSON 数组 `[{"name","at"}]`，name 用该领域**标准/规范中文
  术语**（利于跨视频/跨块同名合并），at 从本块字幕行首照抄一个 `mm:ss` 代表时间点；
  无明确知识点则返回 `[]`。`temperature` 低。
- 合并后调用 DB 层 `replace_course_concepts(db, course_id, &merged)`（事务删旧插新，为
  每个 MergedConcept 生成 uuid，写 concepts + concept_occurrences）。此函数不依赖 LLM，可单测。

### 复用与小改动

- `pipeline/ai.rs::transcript_text`：已是 `pub async`，直接用。
- `pipeline/rag.rs::split_by_chars`：由私有提升为 `pub(crate)`，供 concepts 复用（单一实现，
  不复制）。
- LLM 装配（parse_profiles/parse_routing/resolve_profile/build_provider/keychain）：在
  `commands/concepts.rs` 写一个与 `commands/rag.rs::rag_provider` 对应的小解析器，按
  `AiTask::Summary` 取 Profile+模型。

## 3. 查询 / 命令（新文件 `src-tauri/src/commands/concepts.rs`）

```rust
pub struct ConceptOccurrence { pub video_id: String, pub video_title: String, pub start_ms: i64 }
pub struct CourseConcept { pub id: String, pub name: String, pub occurrences: Vec<ConceptOccurrence> }

/// 列出某课程的概念，每个带「在哪几节讲到」（join 视频标题，跳过已删除视频）。
/// - 概念按出现次数（存活出现数）降序、再按名升序。
/// - occurrences 按视频 order_index、再按 start_ms 升序。
/// - 所有出现都落在已删除视频上的概念不返回（无可跳转目标）。
pub async fn list_course_concepts(db: &Db, course_id: &str) -> AppResult<Vec<CourseConcept>>;

#[tauri::command] pub async fn cmd_analyze_course_concepts(state, course_id) -> AppResult<usize>;
#[tauri::command] pub async fn cmd_list_course_concepts(state, course_id) -> AppResult<Vec<CourseConcept>>;
```

- 两个命令注册进 `commands/mod.rs` 与 `lib.rs` 的 `generate_handler!`。
- `cmd_analyze_course_concepts`：解析 Provider → `analyze_course_concepts` → 返回概念数。
  同步命令（会有多次 LLM 调用、耗时），前端用 pending 态兜住；**不做**流式进度（后续可接
  jobs 队列）。

## 4. 前端 UI

概念是**课程级**，落在**课程库界面**（选中课程、显示视频列表那一屏），不是每视频右侧面板。

- 该屏（课程头部工具栏处，与其它课程级操作同排）新增「知识点」按钮 → 打开 `ConceptsPanel`
  （整屏覆盖层，样式/返回方式对齐 Dashboard、RecycleBin，从课程库屏打开、可返回）。
- `ConceptsPanel`（新组件 `src/components/ConceptsPanel.tsx`，props：`courseId`、关闭回调）：
  - 用 `useQuery(["course-concepts", courseId])` 拉 `ipc.concepts.list(courseId)`。
  - **空**（从未分析或无结果）→ 「分析本课程概念」CTA，点后 `useMutation` 调
    `ipc.concepts.analyze(courseId)`，成功后失效并重拉列表；分析中显示「分析中…（可能需要
    一会儿）」；无字幕/报错走 ErrorNote。
  - **有数据** → 概念列表：每项概念名 + 出现次数徽标；展开看 occurrences（视频标题 + `mm:ss`），
    点击 → `usePlayer.requestOpenAt(video_id, start_ms)`（复用 P1 跨视频跳转，同课程内，无跨课程
    难题）；顶部「重新分析」再跑一次。
- `ipc.ts` 新增：
  ```ts
  concepts: {
    analyze: (courseId: string): Promise<number> => invoke("cmd_analyze_course_concepts", { courseId }),
    list: (courseId: string): Promise<CourseConcept[]> => invoke("cmd_list_course_concepts", { courseId }),
  }
  ```
  以及 `CourseConcept` / `ConceptOccurrence` 类型（对应后端 serde 输出）。
- Home 接线：课程库屏渲染「知识点」入口与 `ConceptsPanel`；跳转由既有 `pendingSeek` 通路驱动
  （`ConceptsPanel` 只调 `requestOpenAt`，打开+seek 交给 Home/VideoPlayer 现有逻辑）。

## 5. 测试

- **纯函数（Rust）**：
  - `parse_concepts_json`：合法数组解析；`mm:ss` 与 `h:mm:ss` 都解析成毫秒；缺 name / at
    解析失败的条目跳过；非数组、非法 JSON → 空；多余字段忽略。
  - `merge_by_name`：两视频同（规范化）名 → 一个概念、两条 occurrence、次数 2；不同名保持独立；
    结果按次数降序；occurrence 去重。
- **后端 DB（Rust，不依赖 LLM）**：
  - `replace_course_concepts` + `list_course_concepts`：直接喂 MergedConcept 入库，断言
    列表 join 出视频标题、按次数降序、occurrence 按序；已删除视频的出现被排除；重跑替换（旧概念
    不残留、计数正确）。
- **前端（vitest）**：`ConceptsPanel` 渲染概念列表与次数徽标；展开显示 occurrences；点击
  occurrence 调 `requestOpenAt(video_id, start_ms)`；空态 CTA 触发 `analyze` 并在成功后重拉；
  加载/无字幕/错误态。
- **桌面 cfg**：`cargo check --lib`（非 test cfg）必须过——防止只在桌面构建暴露的 cfg 门控问题。

## 贯穿约束

- 全本地、无遥测；数据进 SQLite（迁移顺延 0015）；前端 `ipc.*` 包装。
- 只改/提交自己的文件；容器无法跑真机与真实 LLM，抽取效果需 Mac 验收。
- 单特性 TDD + 单独提交。
