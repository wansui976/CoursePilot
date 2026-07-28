# Apple 跨设备同步设计

日期：2026-07-25  
状态：已批准（用户：继续）  
应用：CoursePilot（Tauri 2 + React + Rust/sqlx + SQLite）  
目标平台：macOS 14+、iOS/iPadOS 17+

## 1. 背景

CoursePilot 已同时具备 macOS、iPhone/iPad 客户端，但所有课程与学习状态仍保存在各设备
自己的 `app_data_dir/courseai.db`。同一个用户在 Mac 上学习后，iPad 看不到播放进度、笔记、
收藏、复习卡和课程知识；在 iPad 上继续学习产生的数据也不会回到 Mac。

当前数据模型还有三个不适合直接同步的特征：

1. `videos.file_path`、`videos.data_dir` 是设备本地绝对路径，不能复制到另一台设备。
2. 多个表使用本地自增 id，或缺少稳定的更新时间/版本，无法可靠去重与解决冲突。
3. SQLite 是应用运行时数据库，不能把整个 `courseai.db` 当普通文件放入 iCloud Drive；
   两台设备并发修改同一个数据库文件会产生覆盖、锁和损坏风险。

Apple 对“已有自定义本地存储”的应用提供 `CKSyncEngine`。它负责 CloudKit 增量收发、
系统调度、推送触发、临时错误重试和账户变更通知；应用只负责把本地模型与 `CKRecord`
互转、持久化同步状态、处理业务冲突。

参考：

- [Deciding whether CloudKit is right for your app](https://developer.apple.com/documentation/cloudkit/deciding-whether-cloudkit-is-right-for-your-app)
- [CKSyncEngine](https://developer.apple.com/documentation/cloudkit/cksyncengine)
- [Sync to iCloud with CKSyncEngine](https://developer.apple.com/videos/play/wwdc2023/10188/)
- [Enabling CloudKit in Your App](https://developer.apple.com/documentation/cloudkit/enabling-cloudkit-in-your-app)

## 2. 目标与非目标

### 2.1 目标

- 使用用户当前登录的 iCloud 账号，在其 **CloudKit Private Database** 内同步个人数据。
- Mac、iPhone、iPad 离线可继续使用；恢复网络后自动增量合并。
- 同步课程结构、视频元数据、学习进度、笔记、收藏片段、复习卡与复习记录。
- 后续同一条同步通路可扩展到字幕与 AI 派生资料，无需重写同步底座。
- 任何一次同步中断、重复投递或应用崩溃都不能造成记录重复或静默丢失。
- 用户能看到同步状态、失败原因和待同步数量，并可主动触发“立即同步”。
- 保持 CoursePilot 的 local-first 语义：CloudKit 不可用时，本地功能仍正常。

### 2.2 非目标

- 首版不上传原始视频文件，不承诺另一台设备自动获得可播放视频。
- 首版不支持 Android、Windows 或 Web；这些平台不能直接使用用户的私有 CloudKit 数据库。
- 不做多人协作、公开课程、`CKShare` 或团队空间。
- 不同步 API Key、Bilibili Cookie、OCR/ASR 密钥等敏感凭证。
- 不同步 ffmpeg 中间文件、Whisper 模型、embeddings、缓存和处理队列运行态。
- 不追求毫秒级实时同步；遵循系统的网络、电量和后台调度。
- 不用 CloudKit 替代本地 SQLite；SQLite 始终是 UI 的读取来源和离线真相。

## 3. 已定关键决策

| 决策点 | 选择 |
| --- | --- |
| 云端 | CloudKit Private Database，每位用户数据天然隔离 |
| 同步引擎 | `CKSyncEngine`，不用 `NSPersistentCloudKitContainer` |
| 最低系统 | iOS/iPadOS 17、macOS 14；不为 iOS 14 手写双轨同步引擎 |
| CloudKit Container | `iCloud.dev.courseai.app`，上线前确认后不再改名 |
| 本地存储 | 继续使用 Rust/sqlx/SQLite，不迁移 Core Data/SwiftData |
| 同步粒度 | 一条业务实体对应一个 CloudKit Record，不同步整个数据库文件 |
| 数据库区域 | 私有数据库中的自定义 Zone：`CoursePilotUserZone` |
| 首版媒体 | 只同步视频元数据与关联身份；原视频留在本机 |
| 冲突排序 | 逻辑时钟 + device id，`updated_at` 只用于展示，不单独决定胜负 |
| 删除 | 业务软删除优先；永久删除同时写云端 Tombstone，防止旧设备复活数据 |
| 原生边界 | Swift 负责 CloudKit；Rust 负责业务库、序列化、合并与前端 IPC |
| 同步开关 | 用户主动启用；退出/切换 iCloud 账号时暂停并要求确认 |

## 4. 用户体验

### 4.1 设置入口

设置页新增“iCloud 同步”分区，仅在 macOS/iOS/iPadOS 显示：

- 开关：“在 Apple 设备间同步学习资料”。
- 状态：未启用 / 等待 iCloud 登录 / 正在同步 / 已同步 / 同步失败 / 已暂停。
- 辅助信息：上次成功时间、待上传 N 项、待应用 N 项。
- 操作：“立即同步”“查看同步问题”“关闭同步”。
- 固定说明：“原始视频不会上传；在另一台设备上需要重新关联本地文件。”

首次启用时展示确认页，列出会同步和不会同步的内容。确认后才创建 CloudKit Zone、
生成设备 id 并上传本机已有数据。

### 4.2 另一台设备的课程表现

远端 `Course`、`Video` 到达后，课程和视频立即显示。没有本地原视频的 `Video` 显示
“需要关联视频”，可以查看已同步的笔记/复习内容，但播放按钮不可用。

用户点击“关联本地文件”后：

1. 选择本机视频；
2. 后端计算内容指纹并与远端 `Video.content_fingerprint` 比对；
3. 匹配则只更新本机 `file_path`、`data_dir`、`media_state`，不产生新的云端视频；
4. 指纹不一致时明确提示，并允许取消或在二次确认后强制关联。

本机后来导入同一文件时，若指纹命中一个“需要关联”的远端视频，也自动合并到该 video id，
不能再创建一条重复视频。

### 4.3 冲突提示

大部分冲突自动解决，不打断学习。只有笔记出现真正的并发编辑时显示非阻塞提示：

> 这篇笔记在另一台设备上也被修改。已保留两个版本。

用户可查看“当前版本 / 冲突版本”，选择保留其中一个或手动合并。任何情况下都不能静默
丢掉一份用户输入。

## 5. 总体架构

```text
React UI
  │ ipc.sync.*
  ▼
Rust Sync Coordinator ─────────────── SQLite 业务表
  │                                      │
  │ materialize / apply                  │ 同事务标记 outbox
  ▼                                      ▼
app_data_dir/apple-sync/            sync_outbox / tombstones / versions
  ├── outgoing/   Rust 写，Swift 读
  ├── incoming/   Swift 写，Rust 读
  ├── ack/        Swift 写，Rust 消费
  └── state/      Swift 保存 CKSyncEngine state serialization
  │
  ▼
Swift CloudSyncKit
  │ CKSyncEngineDelegate
  ▼
CloudKit Private DB / CoursePilotUserZone
  │ silent push / scheduler
  ▼
用户的其他 Apple 设备
```

### 5.1 为什么使用文件桥接

- Swift 不直接打开 `courseai.db`，避免与 sqlx 连接池形成第二套数据库所有者。
- Rust 不实现 CloudKit 协议、Apple 账户和 APNs 生命周期。
- outgoing/incoming 都使用“写临时文件 → fsync → 原子 rename”，崩溃后可重复处理。
- CloudKit Record ID 固定，重复上传是幂等操作；ack 丢失只会导致安全重试。
- Swift 在后台收到推送时可以先持久化 incoming，即使前端尚未恢复也不会丢变更。

### 5.2 Swift 共享实现

新增独立 Apple 原生模块 `src-tauri/apple-sync/`，不塞进媒体用途的
`MobileFilesPlugin.swift`：

- `CloudSyncManager.swift`：持有 `CKContainer`、`CKSyncEngine` 与 actor 状态。
- `RecordCodec.swift`：`SyncEnvelope` 与 `CKRecord` 互转。
- `SpoolStore.swift`：原子读写 outgoing/incoming/ack/state。
- `CloudSyncStatus.swift`：账号状态、队列数、最近错误与最近成功时间。
- iOS adapter：使用 Tauri iOS plugin binding。
- macOS adapter：同一 Swift Package 编译为静态库，通过窄 C ABI 暴露
  `start/status/sync_now/stop`；异步结果和远端变更均落入 spool，不跨 FFI 传复杂对象。

`CKSyncEngine` 必须在应用启动早期初始化，才能接住推送和后台调度。未启用同步时只检查
本地开关，不访问 CloudKit。

## 6. CloudKit 模型

所有记录进入 `CoursePilotUserZone`。Record Name 由稳定业务 id 确定，不使用随机上传 id。
每条可变记录都包含：

```text
schemaVersion   Int64
entityID        String
versionCounter  Int64
versionDevice   String
updatedAt       Date          仅展示/诊断
deletedAt       Date?         有回收站语义的实体使用
```

`(versionCounter, versionDevice)` 按字典序比较，得到所有设备一致的确定性顺序。每次看到远端
counter 后，本机逻辑时钟推进到 `max(local, remote) + 1`。这避免设备时间不准导致旧数据覆盖
新数据。

### 6.1 首阶段 Record Types

| Record Type | Record Name | 同步字段 | 明确排除 |
| --- | --- | --- | --- |
| `Course` | `course-{course_id}` | name、createdAt、deletedAt | root_path、本地封面路径 |
| `Video` | `video-{video_id}` | courseID、title、sourceType、sourceIdentity、fingerprint、duration、order、deletedAt | file_path、data_dir、processed_status |
| `Note` | `note-{video_id}` | contentJson、contentMd、userEditedAt | 编辑器临时态 |
| `Clip` | `clip-{sync_id}` | videoID、startMs、endMs、note、createdAt | 本地自增 id |
| `Card` | `card-{card_id}` | courseID、videoID、kind、front、back、sourceMs、createdAt | 无 |
| `VideoProgress` | `progress-{video_id}` | positionMs、durationMs、updatedAt | localStorage 面板状态 |
| `StudyEvent` | `event-{event_id}` | kind、courseID、videoID、ts、durationMs、metaJson | 本地自增 id |
| `Tombstone` | `tombstone-{type}-{id}` | targetType、targetID、version、deletedAt | 无 |

`CardSchedule` 不独立作为最终真相同步。review 类型的 `StudyEvent` 是不可变事实；合并事件后，
Rust 按同一套 FSRS 逻辑重放该卡的事件并重建 `card_schedule`。这样两台离线设备各复习一次时，
不会因最后写入者覆盖而丢掉其中一次复习。

### 6.2 第二阶段 Record Types

| Record Type | 内容 | 存储形式 |
| --- | --- | --- |
| `TranscriptBundle` | 一个视频的全部字幕段 | gzip JSON `CKAsset` |
| `ChapterBundle` | 章节 | gzip JSON 或小记录字段 |
| `Summary` | 摘要 | 文本字段 |
| `QuizBundle` | 题目 | gzip JSON `CKAsset` |
| `Mindmap` | Markdown | 文本或 `CKAsset` |
| `CourseKnowledge` | 课程总览、概念、出现位置与解释 | gzip JSON `CKAsset` |

字幕和派生资料使用“整 bundle 替换”，不逐字幕段创建数千条 CKRecord。Bundle 记录包含
`contentFingerprint`；内容相同不重复上传。`CKAsset` 下载后必须立即移入应用容器，不能长期
依赖 CloudKit staging URL。

课件图片、截图和 embeddings 首版不进入 CloudKit。它们可重新生成，且会显著增加存储与网络成本。

## 7. SQLite 改造

当前最新迁移是 `0020_video_progress.sql`，实现时新增 `0021_apple_sync.sql`；若实现前已有新迁移，
编号顺延。

### 7.1 业务表补充

```sql
ALTER TABLE videos ADD COLUMN content_fingerprint TEXT;
ALTER TABLE videos ADD COLUMN media_state TEXT NOT NULL DEFAULT 'local'
  CHECK (media_state IN ('local', 'missing'));
ALTER TABLE videos ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE clips ADD COLUMN sync_id TEXT;
ALTER TABLE clips ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX ux_clips_sync_id ON clips(sync_id) WHERE sync_id IS NOT NULL;

ALTER TABLE cards ADD COLUMN sync_updated_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE study_events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX ux_study_events_event_id
  ON study_events(event_id) WHERE event_id IS NOT NULL;
```

- 课程、视频、卡片已有字符串 id，继续沿用。
- clip 保留本地 INTEGER 主键，跨设备身份使用 `sync_id` UUID。
- study event 保留本地 INTEGER 主键，跨设备去重使用 `event_id` UUID。
- 启用同步前运行一次 Rust backfill，为存量 clip/event 生成 UUID；backfill 可重入，事务完成后
  才允许初始上传。
- `content_fingerprint` 格式固定为 `sha256:<lowercase hex>`。使用流式读取计算完整文件 SHA-256，
  不把大视频一次载入内存；导入主流程不等待 hash，后台完成后再补一次 Video outbox。只有完整 hash
  相等才允许自动合并，标题、时长、文件大小只能作为人工关联提示，不能自动判同一视频。
- 远端 Course 首次落地时，`root_path` 设为本机
  `app_data_dir/synced-courses/<course_id>` 并创建目录；该路径永不上传。
- 远端视频占位行使用 `file_path=''`，`data_dir` 指向本机稳定应用数据目录，
  `media_state='missing'`、`processed_status='done'`。占位视频不创建本地处理任务；所有播放入口先
  检查 media_state，不能把空路径交给媒体层。

### 7.2 同步底座表

```sql
CREATE TABLE sync_device_state (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  device_id       TEXT NOT NULL,
  logical_clock   INTEGER NOT NULL DEFAULT 0,
  enabled         INTEGER NOT NULL DEFAULT 0,
  account_id_hash TEXT,
  last_success_at INTEGER,
  last_error      TEXT
);

CREATE TABLE sync_entity_versions (
  record_type     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  version_counter INTEGER NOT NULL,
  version_device  TEXT NOT NULL,
  change_tag      TEXT,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_outbox (
  record_type TEXT NOT NULL,
  record_id   TEXT NOT NULL,
  operation   TEXT NOT NULL CHECK (operation IN ('save', 'delete')),
  changed_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  leased_at   INTEGER,
  last_error  TEXT,
  version_counter INTEGER,
  version_device  TEXT,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_tombstones (
  record_type     TEXT NOT NULL,
  record_id       TEXT NOT NULL,
  version_counter INTEGER NOT NULL,
  version_device  TEXT NOT NULL,
  deleted_at      INTEGER NOT NULL,
  PRIMARY KEY (record_type, record_id)
);

CREATE TABLE sync_conflicts (
  id            TEXT PRIMARY KEY,
  record_type   TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  local_json    TEXT NOT NULL,
  remote_json   TEXT NOT NULL,
  detected_at   INTEGER NOT NULL,
  resolved_at   INTEGER
);

CREATE TABLE sync_apply_guard (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  applying  INTEGER NOT NULL DEFAULT 0
);
```

迁移只创建 schema；`device_id` 需要 Rust 生成 UUID，因此应用 setup 阶段用幂等 transaction 初始化
`sync_device_state(singleton=1, ...)` 与 `sync_apply_guard(singleton=1, applying=0)`。初始化未完成时
同步命令返回 Config 错误，不能部分启用。

### 7.3 写入不变量

所有会改变同步实体的 Rust 命令必须满足：

1. 在一个 SQLite transaction 内修改业务表；
2. 同 transaction upsert `sync_outbox`；
3. 若是永久删除，同 transaction 写 `sync_tombstones`；
4. transaction commit 后通知 sync coordinator；
5. 云端 apply 时设置 `sync_apply_guard.applying=1`，业务触发器不产生回声 outbox；
6. apply 和清 guard 必须在同一 transaction 内完成。

为防未来新代码忘记入队，核心同步表增加 INSERT/UPDATE/DELETE trigger，只负责把实体 id 标记进
outbox，不在 SQL trigger 内生成 JSON。Rust 在物化 outgoing envelope 前读取业务表最新状态。
若远端变更到达时同一实体仍有未物化的本地 outbox，先为本地变更分配逻辑版本，再进行冲突比较。

## 8. Sync Envelope

Swift 与 Rust 之间只交换版本化 JSON，不交换 SQLite row 或 Swift 对象：

```json
{
  "schemaVersion": 1,
  "recordType": "Note",
  "recordID": "note-video-uuid",
  "operation": "save",
  "version": { "counter": 42, "device": "device-uuid" },
  "updatedAt": 1784995200000,
  "payload": {
    "videoID": "video-uuid",
    "contentJson": "{...}",
    "contentMd": "..."
  }
}
```

规则：

- `schemaVersion` 未识别时不应用、不删除 incoming，状态显示“需要升级应用”。
- payload 字段只增不改语义；删除字段先经历至少一个兼容版本。
- 每个 envelope 文件名包含 recordType、recordID、counter、device，便于诊断和幂等去重。
- outgoing 物化后即使 SQLite outbox 尚未 ack，也可重复覆盖同版本文件。
- Swift 成功上传后写 ack；Rust 只有在 ack 版本仍等于当前 entity version 时才清 outbox，
  防止上传过程中发生的新修改被误清。

CloudKit 不保证同一批父子记录的回调顺序。Rust apply 固定按
`Course → Video → Note/Clip/Card/Progress/Event → Bundle` 排序；父记录仍缺失的 child 不报永久错误，
而是保留 incoming 等下一轮重试。跨实体关系在 CloudKit 中使用稳定字符串 id，不依赖级联删除。

### 8.1 首次启用 / 重装 bootstrap

首次启用同步、应用重装或 CKSyncEngine state 丢失时必须 **先拉后推**：

1. 确认 iCloud account 与绑定的 account hash；
2. 创建或确认 `CoursePilotUserZone`；
3. 拉取并应用该 Zone 的完整远端快照（含 Tombstone）；
4. 将本地记录与远端版本合并，生成 conflict copy；
5. 仅把合并后仍领先或云端缺失的本地实体加入 outgoing；
6. 上传完成后保存新的 CKSyncEngine state。

禁止在未完成首次 fetch 时把“本机全量数据”直接推到云端，否则新安装设备可能覆盖已有 iCloud
资料。bootstrap 可取消和续跑；完成标志写入 `sync_device_state`，不能只存在内存。

## 9. 冲突与合并规则

### 9.1 通用规则

1. 本地没有该记录：应用远端。
2. 版本完全相同：视为重复投递，直接 ack。
3. 本地无 pending 修改：较大逻辑版本胜出。
4. 本地有 pending 修改且基于同一 change tag：按业务规则合并后产生一个新的本地逻辑版本并重传。
5. CloudKit 返回 `serverRecordChanged`：读取 server record，走同一合并函数，不直接使用 `allKeys`
   覆盖服务端。
6. 网络、限流、服务暂不可用交给 CKSyncEngine 重试；业务错误才进入“同步问题”。

CloudKit 保存使用 `ifServerRecordUnchanged`。只有明确可交换、无需冲突检测的诊断字段才允许
`changedKeys`。

### 9.2 实体规则

| 实体 | 合并方式 |
| --- | --- |
| Course/Video 元数据 | 逻辑版本 LWW；本地路径字段不参与 |
| VideoProgress | 逻辑版本 LWW；完成状态不能由更旧进度倒退 |
| Note | 无并发则 LWW；并发时保留 winner，同时写 `sync_conflicts` 保存两份 |
| Clip | 单条 LWW；不同 sync_id 自然并存 |
| Card 内容 | 单条 LWW；手工卡不因另一设备重新生成题库而删除 |
| StudyEvent | append-only，以 event_id 去重，已同步事件不原地更新 |
| CardSchedule | 不直接 LWW；按所有 review events 重放 FSRS |
| Transcript/AI Bundle | 逻辑版本 LWW；保留本机尚未上传的人工作品冲突副本 |
| 删除 | 更高版本 Tombstone 胜出；低版本更新不能复活 |

`VideoProgress` 的“完成”判定仍由 position/duration 计算。若较新记录是用户主动从头重看，允许位置
变小；因此不能简单永久取 `max(position_ms)`，只禁止旧版本覆盖新版本。

### 9.3 回收站

- Course/Video 进入现有 30 天回收站时同步 `deletedAt`，另一设备也隐藏到回收站。
- 30 天内恢复会清空 deletedAt 并产生更高版本。
- 彻底清除时保存 `Tombstone` 并删除业务 Record；Tombstone 长期保留，首版不自动清理。
- 云端永久删除用同一 custom zone 内的原子 modify：保存 Tombstone 与删除业务 Record 要么同时
  成功，要么同时失败。
- 远端永久删除到达后，本地媒体文件是否删除沿用现有 purge 语义；执行前仍须确认目标位于该视频
  data_dir，不能因远端路径字段删除任意文件。

## 10. iCloud 账户生命周期

CloudKit 使用系统 iCloud 账号，不增加“使用 Apple 登录”。Swift 将当前 CloudKit user record id
做单向 hash，只把 hash 存在 `sync_device_state.account_id_hash`，用于判断账号是否变化。

- 未登录：本地继续工作，状态“等待登录 iCloud”，outbox 保留。
- 退出账号：暂停上传与应用远端变更，保留本地数据。
- 切换账号：默认暂停，绝不把旧账号的本地课程自动上传到新账号。
- 用户必须选择：
  - “仅使用本机资料，关闭同步”；
  - “将本机资料合并到新的 iCloud”；
  - “切换到新 iCloud 资料”（执行前创建本地备份）。
- 收到 account change 时清除旧 CKSyncEngine state/spool，但不能清业务库，直到用户确认选择。

## 11. Apple 工程配置

### 11.1 系统版本

- `gen/apple/project.yml`：deployment target 从 iOS 14 提升为 iOS 17。
- `ios/Package.swift`：`.iOS(.v14)` 提升为 `.iOS(.v17)`，macOS target 提升为 `.v14`。
- macOS bundle 的最低版本同步提升为 14。

### 11.2 Capabilities / Entitlements

iOS 与 macOS 使用同一个 Apple Developer Team，并关联同一个 CloudKit Container：

```text
com.apple.developer.icloud-container-identifiers = [iCloud.dev.courseai.app]
com.apple.developer.icloud-services = [CloudKit]
aps-environment = development / production（由签名配置决定）
```

iOS `Info.plist` 增加 `UIBackgroundModes = [remote-notification]`。Xcode target 开启：

- iCloud / CloudKit
- Push Notifications
- Background Modes / Remote notifications

macOS 当前的临时签名 `signingIdentity: "-"` 不能作为 CloudKit 发布配置。开发、TestFlight/商店或
Developer ID 构建必须使用包含上述 entitlement 的有效 provisioning/signing profile。

CloudKit 开发环境完成 record schema 与索引验证后，必须在 CloudKit Console 将 schema 部署到
Production，再发布依赖该 schema 的正式版本。Container 创建后不能改名，首次创建前再次确认
`iCloud.dev.courseai.app`。

## 12. Rust 接口与前端接线

### 12.1 Rust 模块

新增 `src-tauri/src/sync/`：

```text
sync/
  mod.rs          coordinator 生命周期与队列调度
  envelope.rs     DTO、schema version、JSON codec
  outbox.rs       标记、物化、lease、ack、重试
  apply.rs        incoming transaction 与 query invalidation 摘要
  merge.rs        通用版本比较和逐实体冲突规则
  identity.rs     device id、clip/event backfill、视频 fingerprint
  spool.rs        原子文件桥接
```

新增 `commands/sync.rs`：

```rust
#[derive(Serialize)]
pub struct SyncStatus {
    pub enabled: bool,
    pub phase: String,
    pub account_state: String,
    pub pending_uploads: i64,
    pub pending_downloads: i64,
    pub last_success_at: Option<i64>,
    pub last_error: Option<String>,
}

#[tauri::command] pub async fn cmd_sync_status(...) -> AppResult<SyncStatus>;
#[tauri::command] pub async fn cmd_sync_set_enabled(enabled: bool, ...) -> AppResult<SyncStatus>;
#[tauri::command] pub async fn cmd_sync_now(...) -> AppResult<()>;
#[tauri::command] pub async fn cmd_sync_apply_inbox(...) -> AppResult<ApplySummary>;
#[tauri::command] pub async fn cmd_sync_link_video(video_id: String, path: String, ...) -> AppResult<()>;
#[tauri::command] pub async fn cmd_sync_conflicts(...) -> AppResult<Vec<SyncConflict>>;
#[tauri::command] pub async fn cmd_sync_resolve_conflict(...) -> AppResult<()>;
```

Coordinator 在启动、恢复前台、网络变为可用、业务写入后和用户点击立即同步时工作。高频播放进度
继续按现有节流策略写库；outbox 以 `(record_type, record_id)` 合并，因此不会每秒产生一个云端操作。

### 12.2 前端

- `src/lib/ipc.ts` 增加 `sync.*` 包装与类型。
- 新增 `CloudSyncPanel.tsx`，嵌入 `SettingsDialog`，不额外创建卡片式设置首页。
- Home 监听 `cloud-sync://applied`，按 `ApplySummary.changedScopes` 精确 invalidation：
  courses、videos、notes、clips、srs、stats、concepts。
- Video/Card UI 对 `media_state='missing'` 显示关联入口，所有 seek/open 前先走统一可播放性检查。
- 同步错误放在设置页和非阻塞状态入口；普通离线、后台延迟不弹错误 toast。

## 13. 原始视频的后续方案

原始视频同步独立为后续特性，不与本 spec 的首版混做。

推荐使用 iCloud Documents/ubiquity container，而不是为每个视频创建普通 CloudKit 字段：

- 用户逐课程或逐视频开启“同步原视频”。
- 文件存为稳定逻辑路径，例如 `Courses/<course-id>/<video-id>/original.ext`。
- 元数据仍在 CloudKit，文件只在需要播放时按需下载。
- UI 显示未下载/下载中/本地可用，占用空间可清理但不删除云端副本。
- 支持“仅 Wi-Fi”“低电量暂停”“最大本地缓存”与明确的 iCloud 空间提示。
- 需要 `NSFileCoordinator`/`NSMetadataQuery` 或等价的系统文件协调，不能由 Rust 直接轮询 ubiquity
  目录假设文件立即可用。

在此能力完成前，产品文案必须始终叫“同步学习资料”，不能暗示原视频会自动出现。

## 14. 故障处理

| 场景 | 行为 |
| --- | --- |
| 无网络/低电量 | 保留 outbox，CKSyncEngine 按系统条件重试 |
| iCloud 未登录 | 暂停同步，不影响本地学习 |
| CloudKit 限流 | 记录诊断，遵循 retryAfter，不自行紧密循环 |
| outgoing 写完后崩溃 | 下次启动重复提交同 Record ID/版本，幂等 |
| 云端成功但 ack 丢失 | 重发；按 change tag/版本识别为已存在 |
| incoming 写完后崩溃 | 文件仍在，下次 Rust 重放；版本表去重 |
| 未识别 schemaVersion | 保留 incoming，提示升级应用 |
| child 先于 Course/Video 到达 | 保留 incoming，按依赖顺序在下一轮重试 |
| Zone 被删除 | 停止自动上传，重建前先确认账号与本地数据策略 |
| 远端记录损坏/缺字段 | 隔离到同步问题，不删除本地有效记录 |
| 磁盘空间不足 | 停止下载 Asset，保留元数据与同步 token，提示清理空间 |

日志不得记录笔记全文、字幕全文、API Key、Cookie 或 CloudKit 用户标识原文。可记录 record type、
截断后的 record id、版本、操作、耗时和错误码。

## 15. 分阶段交付

### P0：Apple 能力与同步地基

- 提升最低系统版本；配置 CloudKit container、entitlements、签名和 remote notification。
- 新增 SQLite 同步表、稳定 id backfill、逻辑时钟、outbox/tombstone。
- 建立 Swift CloudSyncKit、spool、CKSyncEngine state 和开发环境 Zone。
- 只用一组测试 Record 验证 Mac ↔ iPad 双向收发、后台推送与重复投递。

#### P0 双设备传输探针

单机上传成功不能作为 P0 通过。探针使用独立、账号隔离的 spool，并采用
`SyncProbeRequest` + `SyncProbeReceipt` 两个逻辑 Record 完成往返证明：

1. Mac 生成 32 位十六进制会话码并执行 `cmd_sync_probe`；iPad 使用同一会话码执行同一命令。
   两端 arm 时只做显式基线 fetch，随后保持 `CKSyncEngine` 运行并使用系统自动调度。
2. 会话码只在两台测试设备间传递。云端只保存由它派生的 session id、会话内 participant id 和
   account proof；不得上传原始 `device_id`、`account_id_hash` 或会话密钥。
3. iPad 进入后台后，Mac 执行 `cmd_sync_probe_send(replay=false)`。请求使用固定 message id、nonce、
   过期时间与 HMAC。iPad 的 Swift delegate 在自动 fetch 回调中直接生成确定性 Receipt，不依赖前端
   或 Rust 命令再次运行。
4. Mac 使用 `cmd_sync_probe_status` 只读本地 incoming/journal；该命令严禁调用 fetch/send，避免把
   显式拉取伪装成后台投递。
5. Mac 执行 `cmd_sync_probe_send(replay=true)`，原样重放同一 Request。iPad 更新同一个 Receipt，
   `observedDeliveries` 增加，但 `appliedCount` 必须保持 1。发送前先持久化重放意图及当时的观察数基线；
   Request payload、message id 和逻辑版本保持不变，envelope `updatedAt` 标识本次传输尝试。崩溃恢复后
   只有收到匹配该 `updatedAt` 的 CloudKit ACK，且 `observedDeliveries` 严格大于基线，才能证明这次
   显式重放已经到达。
6. `cmd_sync_probe_status` 仅在请求已获 CloudKit ACK、Receipt 来自另一 participant、nonce/account
   proof/HMAC 均匹配、首次投递为 `automatic + background`、重复观察次数至少为 2 且逻辑应用次数
   恰好为 1 时返回 `complete`。

探针首次 arm 会把经过 CloudKit 验证的账号 hash 绑定到本地 `sync_device_state`。账号退出时清理旧
engine token；账号切换时把旧账号的 state、incoming、outgoing、ack 移入本地 quarantine，且在用户
明确确认前不得用新账号恢复或上传。确认入口 `cmd_sync_probe_confirm_account_change` 必须重新验证当前
CloudKit 账号、停止旧 engine、删除旧探针会话密钥、隔离旧账号目录，再事务更新本地绑定；普通 arm
不得静默重绑。应用启动时仅恢复仍在有效期内、且配置文件仍标记为 armed 的探针；运行中的探针到期
后由后台到期任务停止 engine 并删除会话密钥，不依赖用户再次打开状态页。

### P1：核心学习状态

- Course、Video placeholder、Note、Clip、Card、StudyEvent、VideoProgress。
- 本地视频 fingerprint、远端占位视频、关联本地文件。
- FSRS 由合并后的 review events 重建。
- 设置页状态、立即同步、账号切换门槛、笔记冲突副本。

P1 完成后，用户已经可以在 Mac 学习、在 iPad 关联同一视频并继续进度与复习。

### P2：完整学习资料

- TranscriptBundle、ChapterBundle、Summary、QuizBundle、Mindmap、CourseKnowledge。
- gzip/asset、内容指纹、按需下载、空间不足处理。
- 首次同步大课程的分批进度与取消/续传。

### P3：原始视频（独立立项）

- iCloud Documents 按需下载、缓存与空间管理。
- 不是 P0–P2 的发布阻塞项。

每个阶段单独 TDD、单独提交；P0 未在真实 Mac+iPad 上稳定前，不开始 P1 全实体接入。

## 16. 测试与验收

### 16.1 Rust 单元/数据库测试

1. 逻辑版本比较在 counter 相同、device 不同时结果确定。
2. 同一实体连续修改只保留一个 outbox 项，payload 是最新业务状态。
3. 旧 ack 不能清掉上传期间产生的新版本。
4. incoming 重放两次只应用一次。
5. remote apply 不产生回声 outbox。
6. Tombstone 阻止低版本 save 复活实体。
7. clip/event backfill 可重入且 UUID 唯一。
8. 两台设备各产生 review event，合并后两条都存在，FSRS 重放结果一致。
9. 笔记并发编辑保留 winner 与 conflict copy。
10. 远端 Video 不写入另一设备的 file_path/data_dir。

### 16.2 Swift 测试

1. Envelope ↔ CKRecord 往返不丢字段，未知字段向前兼容。
2. spool 临时文件不会被 reader 当成完整消息。
3. state serialization 每次更新后持久化，重启可恢复。
4. sent changes 只 ack 成功记录，失败记录保留。
5. serverRecordChanged 进入业务 merge，不直接覆盖。
6. account sign-out/switch 产生暂停状态。
7. incoming asset 立即复制到应用容器，staging URL 不被持久化。

### 16.3 前端测试

1. 非 Apple 平台不显示 iCloud 同步入口。
2. 首次启用明确说明原视频不上传。
3. 未登录、同步中、失败、已同步状态文案和操作正确。
4. missing video 禁止播放并可发起关联。
5. cloud-sync applied 只失效受影响的查询。
6. 笔记冲突可查看两个版本并完成解决。

### 16.4 双设备验收矩阵

以同一开发 iCloud 账号，在真实 Mac + iPad 上完成：

1. Mac 新建课程/视频占位 → iPad 自动出现。
2. iPad 关联同一文件 → 恢复 Mac 的播放进度与笔记。
3. 两边离线编辑不同笔记 → 恢复网络后保留冲突副本。
4. 两边离线各复习一次同一卡 → 两次事件都保留，排期一致。
5. Mac 删除、iPad 长时间离线后修改旧记录 → Tombstone 不允许复活。
6. 强制结束应用发生在上传前、上传后 ack 前、incoming apply 前，重启均收敛。
7. iCloud 退出/切换账号不会把旧账号数据自动上传到新账号。
8. 删除应用重装后能从 CloudKit bootstrap 学习资料，不依赖旧 change token。
9. CloudKit Development schema 验收通过后部署 Production，再以发布签名复测。

验收标准不是“最终两边看起来一样”而已；还必须证明离线并发、重复投递、崩溃恢复、永久删除
和账号切换不会丢数据或串账号。

## 17. 预计文件清单

- `src-tauri/migrations/0021_apple_sync.sql`
- `src-tauri/src/sync/mod.rs`
- `src-tauri/src/sync/envelope.rs`
- `src-tauri/src/sync/outbox.rs`
- `src-tauri/src/sync/apply.rs`
- `src-tauri/src/sync/merge.rs`
- `src-tauri/src/sync/identity.rs`
- `src-tauri/src/sync/spool.rs`
- `src-tauri/src/commands/sync.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/build.rs`
- `src-tauri/apple-sync/Package.swift`
- `src-tauri/apple-sync/Sources/CloudSyncManager.swift`
- `src-tauri/apple-sync/Sources/RecordCodec.swift`
- `src-tauri/apple-sync/Sources/SpoolStore.swift`
- `src-tauri/gen/apple/project.yml`
- `src-tauri/gen/apple/course-ai_iOS/course-ai_iOS.entitlements`
- `src-tauri/tauri.macos.conf.json`
- `src/lib/ipc.ts`
- `src/components/CloudSyncPanel.tsx`
- `src/components/CloudSyncPanel.test.tsx`
- `src/components/SettingsDialog.tsx`
- `src/pages/Home.tsx`

实际实施前先确认 Tauri 生成 Apple 工程时哪些文件会被重建；CloudKit capability 的来源必须放在
可重复生成的配置/脚本中，不能只在生成后的 `.xcodeproj` 里手工勾选。

## 18. 发布门槛

- P0/P1 的 Rust、Swift、前端测试全部通过。
- `pnpm build`、Rust 非 test cfg 构建、iOS/macOS 正式签名构建通过。
- 真实 Mac+iPad 双设备验收矩阵通过。
- CloudKit Development schema 已部署到 Production。
- 隐私说明明确写出：学习资料在用户私有 iCloud 中同步，原视频默认不上传，密钥不同步。
- 关闭同步不会删除本地数据；删除云端数据必须是单独、明确、可确认的操作。
- 支持在设置中导出同步诊断摘要，但不包含用户内容或秘密。
