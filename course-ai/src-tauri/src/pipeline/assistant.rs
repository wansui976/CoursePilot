//! 全局助手能调的那批工具。
//!
//! agent 循环本身不认识任何工具（见 llm 那边的 agent 模块），**安全策略全在这一层**。
//! 一条硬规矩贯穿始终：
//!
//! **只读的直接执行，会改动的一律只提案。**
//!
//! 改名、删除、改设置、下载导入，工具本身**不动任何数据**，只是把「打算做什么」记下来，
//! 交给界面渲染成一张确认卡，用户点了才真的执行。这不只是防误删——真正的风险不是
//! 「AI 决定删东西」，而是**它认错了对象**：你说「删掉刚才那个」，它删了另一个。
//! 把解析出来的目标摆出来让人看一眼，这个问题就消失了。
//!
//! 还有一条同样重要：助手会读到字幕和课件 OCR，而那些内容来自网上下载的视频。
//! 所以「根据内容回答」和「决定做什么动作」必须分开——动作只能由用户的原话触发，
//! 检索到的内容永远是资料，不是指令。这一层的体现是：所有工具的入参都来自模型，
//! 而模型的动作意图要经过确认卡才落地。

use crate::commands::courses::Course;
use crate::commands::videos::Video;
use crate::db::Db;
use crate::llm::agent::{parse_arguments, ToolBox, ToolOutcome};
use crate::llm::{ToolCall, ToolSpec};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;

/// 助手想让界面做的事。只读工具不产生这些；会改动的工具只产生这些、不落地。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssistantAction {
    /// 导航：打开某个视频（可带跳转时刻）。无破坏性，界面可以直接执行。
    OpenVideo {
        video_id: String,
        title: String,
        at_ms: Option<i64>,
    },
    /// 导航：在当前视频里跳到某一刻。
    SeekTo { at_ms: i64 },
    /// 提案：改名。界面渲染确认卡，用户点了才调真正的改名命令。
    ProposeRename {
        video_id: String,
        current_title: String,
        new_title: String,
    },
    /// 提案：删除（真正执行的是软删除，回收站留 30 天）。
    ProposeDelete { video_id: String, title: String },
    /// 提案：改一项设置。
    ProposeSetting {
        key: String,
        label: String,
        current: Option<String>,
        value: String,
    },
    /// 提案：从网上导入一个视频。
    ProposeImport {
        url: String,
        title: String,
        course_id: Option<String>,
    },
    /// 提案：新建课程。目录来自「默认存放位置」设置——助手没法替用户挑目录，
    /// 而这个位置多数人也记不清，所以卡片上要把它显示出来。
    ProposeCreateCourse { name: String, root_path: String },
    /// 提案：给课程改名。
    ProposeRenameCourse {
        course_id: String,
        current_name: String,
        new_name: String,
    },
    /// 切换主题。
    ///
    /// 不走确认卡：它无破坏性、一眼可见、再说一句就能改回来。给它加一次点击
    /// 只是让「把主题调暗」这种最该一步到位的事变成两步。
    ///
    /// 也不走设置白名单——主题存在前端本地，后端的设置表里根本没有这一项，
    /// 加进白名单只会写出一条谁也不读的记录。
    SetTheme { pref: String },
}

/// 允许助手改动的设置，以及每项的取值约束。
///
/// 这是一张**白名单**，不是「除了密钥都能改」的黑名单。理由：黑名单只要漏一个新加的
/// 敏感键就出事，而白名单漏了最多是助手说「这项我改不了」。
///
/// API Key 永远不在这里，而且不是「忘了加」——助手要能读 Key，Key 就会进它的上下文，
/// 上下文会被发给模型服务商，等于把密钥主动交出去。这条是逻辑上的不可能，不是保守。
struct SettingRule {
    key: &'static str,
    label: &'static str,
    /// 允许的取值；空表示接受任意整数（见 `validate`）。
    allowed: &'static [&'static str],
    numeric_range: Option<(i64, i64)>,
}

const SETTING_RULES: &[SettingRule] = &[
    SettingRule {
        key: "subtitle_autocorrect",
        label: "字幕 AI 纠错",
        allowed: &["true", "false"],
        numeric_range: None,
    },
    SettingRule {
        key: "slides_auto_extract",
        label: "自动提取课件页",
        allowed: &["true", "false"],
        numeric_range: None,
    },
    SettingRule {
        key: "asr_correction_concurrency",
        label: "字幕纠错并发数",
        allowed: &[],
        numeric_range: Some((1, 2500)),
    },
    SettingRule {
        key: "ocr_backend",
        label: "课件文字识别引擎",
        allowed: &["local", "aliyun"],
        numeric_range: None,
    },
    SettingRule {
        key: "asr_language",
        label: "语音识别语言",
        allowed: &["auto", "zh", "en", "ja", "ko"],
        numeric_range: None,
    },
];

impl SettingRule {
    fn validate(&self, value: &str) -> Result<(), String> {
        if let Some((low, high)) = self.numeric_range {
            return match value.parse::<i64>() {
                Ok(n) if (low..=high).contains(&n) => Ok(()),
                Ok(n) => Err(format!("{n} 超出范围 {low}–{high}")),
                Err(_) => Err(format!("「{value}」不是整数")),
            };
        }
        if self.allowed.contains(&value) {
            Ok(())
        } else {
            Err(format!("只能是 {}", self.allowed.join(" / ")))
        }
    }
}

fn setting_rule(key: &str) -> Option<&'static SettingRule> {
    SETTING_RULES.iter().find(|rule| rule.key == key)
}

/// 助手当前看到的界面状态：它得知道「你现在在看哪个」，才听得懂「把这个改个名」。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AssistantContext {
    pub course_id: Option<String>,
    pub video_id: Option<String>,
    pub position_ms: Option<i64>,
}

pub struct AssistantTools<'a> {
    db: &'a Db,
    context: AssistantContext,
    /// 工具执行期间攒下的动作，循环跑完由调用方取走。
    ///
    /// 用 Mutex 而不是 RefCell：ToolBox 的方法拿的是 `&self`，而循环是 async 的，
    /// 编译器要求跨 await 持有的东西是 Sync。
    actions: Mutex<Vec<AssistantAction>>,
}

impl<'a> AssistantTools<'a> {
    pub fn new(db: &'a Db, context: AssistantContext) -> Self {
        Self {
            db,
            context,
            actions: Mutex::new(Vec::new()),
        }
    }

    pub fn take_actions(&self) -> Vec<AssistantAction> {
        std::mem::take(&mut self.actions.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn record(&self, action: AssistantAction) {
        self.actions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(action);
    }

    /// 模型给的 video_id 可能是它自己编的。所有涉及具体视频的工具都要先过这一关：
    /// 查不到就把错误喂回去让它重查，而不是拿着一个不存在的 id 往下走。
    async fn find_video(&self, video_id: &str) -> Result<Video, ToolOutcome> {
        crate::commands::videos::get_video(self.db, video_id)
            .await
            .map_err(|_| {
                ToolOutcome::failed(format!(
                    "找不到 id 为 {video_id} 的视频。先用 list_videos 或 search_content 查到真实 id，不要凭印象填"
                ))
            })
    }

    /// 没指定视频时用「当前正在看的那个」。
    fn resolve_video_id(&self, given: Option<String>) -> Result<String, ToolOutcome> {
        given
            .or_else(|| self.context.video_id.clone())
            .ok_or_else(|| ToolOutcome::failed("没有指定视频，当前也没有正在观看的视频"))
    }
}

fn courses_summary(courses: &[Course]) -> String {
    if courses.is_empty() {
        return "还没有任何课程。".into();
    }
    courses
        .iter()
        .map(|c| format!("- {} （id={}）", c.name, c.id))
        .collect::<Vec<_>>()
        .join("\n")
}

fn videos_summary(videos: &[Video]) -> String {
    if videos.is_empty() {
        return "这门课程下还没有视频。".into();
    }
    videos
        .iter()
        .map(|v| {
            let mins = v.duration_ms.map(|ms| ms / 60_000).unwrap_or(0);
            format!("- {} （id={}，约 {mins} 分钟）", v.title, v.id)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---------- 各工具的入参 ----------

#[derive(Deserialize)]
struct ListVideosArgs {
    course_id: Option<String>,
}

#[derive(Deserialize)]
struct SearchArgs {
    query: String,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Deserialize)]
struct OpenVideoArgs {
    video_id: String,
    #[serde(default)]
    at_ms: Option<i64>,
}

#[derive(Deserialize)]
struct SeekArgs {
    at_ms: i64,
}

#[derive(Deserialize)]
struct RenameArgs {
    video_id: Option<String>,
    new_title: String,
}

#[derive(Deserialize)]
struct DeleteArgs {
    video_id: Option<String>,
}

#[derive(Deserialize)]
struct SettingArgs {
    key: String,
    value: String,
}

#[derive(Deserialize)]
struct BilibiliSearchArgs {
    query: String,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct CreateCourseArgs {
    name: String,
}

#[derive(Deserialize)]
struct RenameCourseArgs {
    course_id: Option<String>,
    new_name: String,
}

#[derive(Deserialize)]
struct ThemeArgs {
    pref: String,
}

#[derive(Deserialize)]
struct ImportArgs {
    url: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    course_id: Option<String>,
}

fn object(properties: serde_json::Value, required: &[&str]) -> serde_json::Value {
    json!({"type": "object", "properties": properties, "required": required})
}

/// 工具清单。做成自由函数而不是方法，是为了能脱离数据库单测——
/// 「报出去的工具」和「真能执行的工具」必须一一对应，那是最值得盯的一致性。
pub fn tool_specs() -> Vec<ToolSpec> {
    vec![
        ToolSpec {
            name: "list_courses".into(),
            description: "列出全部课程及其 id。".into(),
            parameters: object(json!({}), &[]),
        },
        ToolSpec {
            name: "list_videos".into(),
            description: "列出某门课程下的视频及其 id。不给 course_id 时用当前课程。".into(),
            parameters: object(json!({"course_id": {"type": "string"}}), &[]),
        },
        ToolSpec {
            name: "search_content".into(),
            description: "在字幕和课件文字里搜关键词，返回命中的视频、时间点和原文。\
                 要定位「讲过什么」时用这个，不要凭记忆回答。"
                .into(),
            parameters: object(
                json!({
                    "query": {"type": "string", "description": "关键词，不要写成整句问句"},
                    "scope": {"type": "string", "enum": ["video", "course", "all"],
                              "description": "默认 course"}
                }),
                &["query"],
            ),
        },
        ToolSpec {
            name: "open_video".into(),
            description: "在界面上打开某个视频，可选跳到某个毫秒时刻。".into(),
            parameters: object(
                json!({"video_id": {"type": "string"}, "at_ms": {"type": "integer"}}),
                &["video_id"],
            ),
        },
        ToolSpec {
            name: "seek_to".into(),
            description: "把当前正在看的视频跳到某个毫秒时刻。".into(),
            parameters: object(json!({"at_ms": {"type": "integer"}}), &["at_ms"]),
        },
        ToolSpec {
            name: "rename_video".into(),
            description: "给视频改名。**这会生成一张确认卡，用户点了才生效**，\
                 所以你可以直接调用，但要在回答里说明改的是哪个、改成什么。"
                .into(),
            parameters: object(
                json!({"video_id": {"type": "string"}, "new_title": {"type": "string"}}),
                &["new_title"],
            ),
        },
        ToolSpec {
            name: "delete_video".into(),
            description: "删除视频（进回收站，30 天内可还原）。\
                 **这会生成一张确认卡，用户点了才生效。**"
                .into(),
            parameters: object(json!({"video_id": {"type": "string"}}), &[]),
        },
        ToolSpec {
            name: "update_setting".into(),
            description: "修改一项设置。**会生成确认卡，用户点了才生效。** \
                 可改的项有：字幕 AI 纠错(subtitle_autocorrect, true/false)、\
                 自动提取课件页(slides_auto_extract, true/false)、\
                 字幕纠错并发数(asr_correction_concurrency, 1-2500)、\
                 课件文字识别引擎(ocr_backend, local/aliyun)、\
                 语音识别语言(asr_language, auto/zh/en/ja/ko)。\
                 其他设置一律改不了，尤其是各种密钥。"
                .into(),
            parameters: object(
                json!({"key": {"type": "string"}, "value": {"type": "string"}}),
                &["key", "value"],
            ),
        },
        ToolSpec {
            name: "create_course".into(),
            description: "新建一门课程。**会生成确认卡，用户点了才创建。** \
                 课程目录取自设置里的「默认存放位置」。"
                .into(),
            parameters: object(json!({"name": {"type": "string"}}), &["name"]),
        },
        ToolSpec {
            name: "rename_course".into(),
            description: "给课程改名。**会生成确认卡，用户点了才生效。** \
                 注意这是改**课程**的名字；改单个视频的标题用 rename_video。"
                .into(),
            parameters: object(
                json!({"course_id": {"type": "string"}, "new_name": {"type": "string"}}),
                &["new_name"],
            ),
        },
        ToolSpec {
            name: "set_theme".into(),
            description: "切换界面主题：dark 夜间、light 日间、auto 跟随系统。立即生效。".into(),
            parameters: object(
                json!({"pref": {"type": "string", "enum": ["dark", "light", "auto"]}}),
                &["pref"],
            ),
        },
        ToolSpec {
            name: "search_bilibili".into(),
            description: "在 B 站搜索视频，返回候选的标题和链接。\
                 用户说「找个讲 X 的视频」时用这个。搜到之后要把候选列给用户挑，\
                 不要自己替他决定导入哪个。"
                .into(),
            parameters: object(
                json!({
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "description": "默认 8，最多 20"}
                }),
                &["query"],
            ),
        },
        ToolSpec {
            name: "import_video".into(),
            description: "把一个视频链接导入课程。**会生成确认卡，用户点了才真的下载。**".into(),
            parameters: object(
                json!({
                    "url": {"type": "string"},
                    "title": {"type": "string"},
                    "course_id": {"type": "string"}
                }),
                &["url"],
            ),
        },
    ]
}

impl ToolBox for AssistantTools<'_> {
    fn specs(&self) -> Vec<ToolSpec> {
        tool_specs()
    }

    async fn run(&self, call: &ToolCall) -> ToolOutcome {
        match self.dispatch(call).await {
            Ok(outcome) => outcome,
            Err(outcome) => outcome,
        }
    }
}

impl AssistantTools<'_> {
    /// 内层用 `Result<_, ToolOutcome>`，这样参数解析和查不到对象都能直接 `?`——
    /// 两者都不是「错误」，而是要交还给模型、让它改正的结果。
    async fn dispatch(&self, call: &ToolCall) -> Result<ToolOutcome, ToolOutcome> {
        match call.name.as_str() {
            "list_courses" => {
                let courses = crate::commands::courses::list_courses(self.db)
                    .await
                    .map_err(ToolOutcome::failed)?;
                Ok(ToolOutcome::ok(courses_summary(&courses)))
            }

            "list_videos" => {
                let args: ListVideosArgs = parse_arguments(call)?;
                let course_id = args
                    .course_id
                    .or_else(|| self.context.course_id.clone())
                    .ok_or_else(|| {
                        ToolOutcome::failed("没有指定课程，当前也没有打开的课程。先调 list_courses")
                    })?;
                let videos = crate::commands::videos::list_videos(self.db, &course_id)
                    .await
                    .map_err(ToolOutcome::failed)?;
                Ok(ToolOutcome::ok(videos_summary(&videos)))
            }

            "search_content" => {
                let args: SearchArgs = parse_arguments(call)?;
                self.search(&args).await
            }

            "open_video" => {
                let args: OpenVideoArgs = parse_arguments(call)?;
                let video = self.find_video(&args.video_id).await?;
                self.record(AssistantAction::OpenVideo {
                    video_id: video.id.clone(),
                    title: video.title.clone(),
                    at_ms: args.at_ms,
                });
                Ok(ToolOutcome::ok(format!("已打开《{}》。", video.title)))
            }

            "seek_to" => {
                let args: SeekArgs = parse_arguments(call)?;
                if self.context.video_id.is_none() {
                    return Err(ToolOutcome::failed(
                        "当前没有正在观看的视频，先用 open_video 打开一个",
                    ));
                }
                self.record(AssistantAction::SeekTo { at_ms: args.at_ms });
                Ok(ToolOutcome::ok(format!(
                    "已跳到 {}。",
                    crate::pipeline::rag::mmss(args.at_ms)
                )))
            }

            "rename_video" => {
                let args: RenameArgs = parse_arguments(call)?;
                let new_title = args.new_title.trim().to_string();
                if new_title.is_empty() {
                    return Err(ToolOutcome::failed("新名字不能为空"));
                }
                let video = self
                    .find_video(&self.resolve_video_id(args.video_id)?)
                    .await?;
                self.record(AssistantAction::ProposeRename {
                    video_id: video.id.clone(),
                    current_title: video.title.clone(),
                    new_title: new_title.clone(),
                });
                Ok(ToolOutcome::ok(format!(
                    "已提出把《{}》改名为《{new_title}》，等用户确认。还没有生效。",
                    video.title
                )))
            }

            "delete_video" => {
                let args: DeleteArgs = parse_arguments(call)?;
                let video = self
                    .find_video(&self.resolve_video_id(args.video_id)?)
                    .await?;
                self.record(AssistantAction::ProposeDelete {
                    video_id: video.id.clone(),
                    title: video.title.clone(),
                });
                Ok(ToolOutcome::ok(format!(
                    "已提出删除《{}》，等用户确认。还没有删，确认后也只是进回收站，30 天内可还原。",
                    video.title
                )))
            }

            "update_setting" => {
                let args: SettingArgs = parse_arguments(call)?;
                let rule = setting_rule(&args.key).ok_or_else(|| {
                    ToolOutcome::failed(format!(
                        "设置项「{}」不在可改范围内。可改的只有：{}",
                        args.key,
                        SETTING_RULES
                            .iter()
                            .map(|r| r.key)
                            .collect::<Vec<_>>()
                            .join("、")
                    ))
                })?;
                rule.validate(&args.value).map_err(|why| {
                    ToolOutcome::failed(format!("{} 的取值不合法：{why}", rule.label))
                })?;
                let current = crate::commands::settings::get_setting(self.db, rule.key)
                    .await
                    .ok()
                    .flatten();
                self.record(AssistantAction::ProposeSetting {
                    key: rule.key.to_string(),
                    label: rule.label.to_string(),
                    current,
                    value: args.value.clone(),
                });
                Ok(ToolOutcome::ok(format!(
                    "已提出把「{}」改为 {}，等用户确认。还没有生效。",
                    rule.label, args.value
                )))
            }

            "create_course" => {
                let args: CreateCourseArgs = parse_arguments(call)?;
                let name = args.name.trim().to_string();
                if name.is_empty() {
                    return Err(ToolOutcome::failed("课程名不能为空"));
                }
                let root = crate::commands::settings::get_setting(self.db, "default_storage_root")
                    .await
                    .ok()
                    .flatten()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        ToolOutcome::failed(
                            "还没设置「默认存放位置」，没法决定新课程放哪。请用户先去设置里选一个目录",
                        )
                    })?;
                self.record(AssistantAction::ProposeCreateCourse {
                    name: name.clone(),
                    root_path: root,
                });
                Ok(ToolOutcome::ok(format!(
                    "已提出新建课程《{name}》，等用户确认。还没有创建。"
                )))
            }

            "rename_course" => {
                let args: RenameCourseArgs = parse_arguments(call)?;
                let new_name = args.new_name.trim().to_string();
                if new_name.is_empty() {
                    return Err(ToolOutcome::failed("新名字不能为空"));
                }
                let course_id = args
                    .course_id
                    .or_else(|| self.context.course_id.clone())
                    .ok_or_else(|| {
                        ToolOutcome::failed("没有指定课程，当前也没有打开的课程。先调 list_courses")
                    })?;
                let courses = crate::commands::courses::list_courses(self.db)
                    .await
                    .map_err(ToolOutcome::failed)?;
                let course = courses
                    .into_iter()
                    .find(|c| c.id == course_id)
                    .ok_or_else(|| {
                        ToolOutcome::failed(format!(
                            "找不到 id 为 {course_id} 的课程。先用 list_courses 查真实 id"
                        ))
                    })?;
                self.record(AssistantAction::ProposeRenameCourse {
                    course_id: course.id,
                    current_name: course.name.clone(),
                    new_name: new_name.clone(),
                });
                Ok(ToolOutcome::ok(format!(
                    "已提出把课程《{}》改名为《{new_name}》，等用户确认。还没有生效。",
                    course.name
                )))
            }

            "set_theme" => {
                let args: ThemeArgs = parse_arguments(call)?;
                let pref = args.pref.trim().to_lowercase();
                if !["dark", "light", "auto"].contains(&pref.as_str()) {
                    return Err(ToolOutcome::failed(format!(
                        "「{pref}」不是有效主题，只能是 dark / light / auto"
                    )));
                }
                self.record(AssistantAction::SetTheme { pref: pref.clone() });
                Ok(ToolOutcome::ok(format!("已切换到 {pref} 主题。")))
            }

            "search_bilibili" => {
                let args: BilibiliSearchArgs = parse_arguments(call)?;
                let limit = args.limit.unwrap_or(8).clamp(1, 20);
                let found = crate::pipeline::download::search_bilibili(&args.query, limit)
                    .await
                    .map_err(ToolOutcome::failed)?;
                if found.is_empty() {
                    return Ok(ToolOutcome::ok("没搜到结果。"));
                }
                let listed = found
                    .iter()
                    .map(|item| {
                        // UP 主和时长都要给：挑课程视频时「谁讲的、多长」往往比标题更决定选哪个，
                        // 而模型只能转述我们给它的东西——上一版只给了标题和链接，
                        // 于是候选列表里永远没有时长。
                        let mut line = format!("- {}", item.title);
                        if let Some(up) = &item.uploader {
                            line.push_str(&format!("（UP：{up}）"));
                        }
                        if let Some(secs) = item.duration_secs {
                            line.push_str(&format!(
                                "　时长 {}",
                                crate::pipeline::rag::mmss(secs as i64 * 1000,)
                            ));
                        }
                        line.push_str(&format!("\n  {}", item.url));
                        line
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(ToolOutcome::ok(format!(
                    "搜到这些，把它们列给用户挑，不要替他决定：\n{listed}"
                )))
            }

            "import_video" => {
                let args: ImportArgs = parse_arguments(call)?;
                let url = args.url.trim().to_string();
                if !url.starts_with("http") {
                    return Err(ToolOutcome::failed(format!("「{url}」不是一个链接")));
                }
                self.record(AssistantAction::ProposeImport {
                    title: args.title.unwrap_or_else(|| url.clone()),
                    url,
                    course_id: args.course_id.or_else(|| self.context.course_id.clone()),
                });
                Ok(ToolOutcome::ok("已提出导入，等用户确认。还没有开始下载。"))
            }

            other => Err(ToolOutcome::failed(format!(
                "没有名为 {other} 的工具。只能用列表里给出的那些"
            ))),
        }
    }

    async fn search(&self, args: &SearchArgs) -> Result<ToolOutcome, ToolOutcome> {
        let scope = args.scope.as_deref().unwrap_or("course");
        let hits = match scope {
            "video" => {
                let video_id = self.resolve_video_id(None)?;
                crate::pipeline::rag::keyword_search(self.db, &video_id, &args.query, 8).await
            }
            _ => {
                let courses = crate::commands::courses::list_courses(self.db)
                    .await
                    .map_err(ToolOutcome::failed)?;
                let wanted: Vec<&Course> = if scope == "all" {
                    courses.iter().collect()
                } else {
                    let course_id = self.context.course_id.clone();
                    courses
                        .iter()
                        .filter(|c| Some(&c.id) == course_id.as_ref())
                        .collect()
                };
                let mut videos = Vec::new();
                for course in wanted {
                    for video in crate::commands::videos::list_videos(self.db, &course.id)
                        .await
                        .map_err(ToolOutcome::failed)?
                    {
                        videos.push((video.id, video.title));
                    }
                }
                crate::pipeline::rag::keyword_search_scope(self.db, &videos, &args.query, 8).await
            }
        }
        .map_err(ToolOutcome::failed)?;

        if hits.is_empty() {
            return Ok(ToolOutcome::ok(
                "一条都没搜到。可以换个说法再搜一次；如果还是没有，就如实说课程里没讲到。",
            ));
        }
        let listed = hits
            .iter()
            .map(|c| {
                let source = c.video_title.as_deref().unwrap_or("当前视频");
                let where_ = if c.slide_page.is_some() {
                    format!("课件第 {} 页", c.slide_page.unwrap_or(0))
                } else {
                    "字幕".to_string()
                };
                format!(
                    "- 《{source}》{} {}（{where_}）：{}",
                    crate::pipeline::rag::mmss(c.start_ms),
                    c.video_id
                        .as_deref()
                        .map(|id| format!("video_id={id}"))
                        .unwrap_or_default(),
                    c.text
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Ok(ToolOutcome::ok(listed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn seed() -> (Db, String, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let db = Db::connect_and_migrate(&dir.path().join("t.db"))
            .await
            .unwrap();
        let course = crate::commands::courses::create_course(
            &db,
            "线性代数".into(),
            dir.path().to_string_lossy().into(),
        )
        .await
        .unwrap();
        let path = dir.path().join("a.mp4");
        std::fs::write(&path, b"x").unwrap();
        let video = crate::commands::videos::add_local_video(&db, &course.id, path, None)
            .await
            .unwrap();
        (db, course.id, video.id, dir)
    }

    fn call(name: &str, args: &str) -> ToolCall {
        ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: args.into(),
        }
    }

    #[tokio::test]
    async fn renaming_only_proposes_and_changes_nothing() {
        let (db, _course, video_id, _d) = seed().await;
        let before = crate::commands::videos::get_video(&db, &video_id)
            .await
            .unwrap()
            .title;

        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call(
                "rename_video",
                &format!(r#"{{"video_id":"{video_id}","new_title":"第一讲 行列式"}}"#),
            ))
            .await;

        // 库里必须一个字都没变。
        let after = crate::commands::videos::get_video(&db, &video_id)
            .await
            .unwrap()
            .title;
        assert_eq!(before, after, "改名工具不该真的改名");
        // 而且要明确告诉模型还没生效，否则它会转头跟用户说「已经改好了」。
        assert!(out.content.contains("确认") && out.content.contains("还没有生效"));

        match tools.take_actions().as_slice() {
            [AssistantAction::ProposeRename { new_title, .. }] => {
                assert_eq!(new_title, "第一讲 行列式")
            }
            other => panic!("应当只产出一条改名提案，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn deleting_only_proposes_and_the_video_stays_listed() {
        let (db, course_id, video_id, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call(
                "delete_video",
                &format!(r#"{{"video_id":"{video_id}"}}"#),
            ))
            .await;

        let still_there = crate::commands::videos::list_videos(&db, &course_id)
            .await
            .unwrap();
        assert_eq!(still_there.len(), 1, "删除工具不该真的删");
        assert!(out.content.contains("还没有删"));
        assert!(matches!(
            tools.take_actions().as_slice(),
            [AssistantAction::ProposeDelete { .. }]
        ));
    }

    #[tokio::test]
    async fn a_made_up_video_id_is_refused_rather_than_acted_on() {
        // 模型编 id 是常事。拿着一个不存在的 id 往下走，就是改错/删错对象。
        let (db, _course, _video, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call(
                "rename_video",
                r#"{"video_id":"vid_不存在","new_title":"x"}"#,
            ))
            .await;
        assert!(out.content.contains("找不到"));
        assert!(tools.take_actions().is_empty(), "不该留下任何提案");
    }

    #[tokio::test]
    async fn a_setting_outside_the_whitelist_is_refused_with_the_allowed_list() {
        let (db, _c, _v, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call(
                "update_setting",
                r#"{"key":"llm_key_openai","value":"sk-偷来的"}"#,
            ))
            .await;
        assert!(out.content.contains("不在可改范围"));
        assert!(tools.take_actions().is_empty());
    }

    #[tokio::test]
    async fn an_unknown_tool_name_is_reported_back_to_the_model() {
        let (db, _c, _v, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools.run(&call("rm_rf", "{}")).await;
        assert!(out.content.contains("没有名为"));
    }

    #[tokio::test]
    async fn creating_a_course_without_a_storage_root_says_so_instead_of_guessing() {
        // 助手没法替用户挑目录。没配存放位置时必须直说，不能瞎编一个路径去建目录。
        let (db, _c, _v, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call("create_course", r#"{"name":"概率论"}"#))
            .await;
        assert!(out.content.contains("默认存放位置"));
        assert!(tools.take_actions().is_empty());
    }

    #[tokio::test]
    async fn creating_a_course_only_proposes_and_shows_where_it_would_go() {
        let (db, _c, _v, dir) = seed().await;
        crate::commands::settings::set_setting(
            &db,
            "default_storage_root",
            &dir.path().to_string_lossy(),
        )
        .await
        .unwrap();
        let before = crate::commands::courses::list_courses(&db)
            .await
            .unwrap()
            .len();

        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools
            .run(&call("create_course", r#"{"name":"概率论"}"#))
            .await;

        assert_eq!(
            crate::commands::courses::list_courses(&db)
                .await
                .unwrap()
                .len(),
            before,
            "新建课程工具不该真的建"
        );
        assert!(out.content.contains("还没有创建"));
        match tools.take_actions().as_slice() {
            [AssistantAction::ProposeCreateCourse { name, root_path }] => {
                assert_eq!(name, "概率论");
                // 目录要摆出来：多数人记不清默认位置在哪。
                assert!(!root_path.is_empty());
            }
            other => panic!("应当只产出一条新建提案，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn renaming_a_course_only_proposes_and_keeps_the_old_name() {
        let (db, course_id, _v, _d) = seed().await;
        let tools = AssistantTools::new(
            &db,
            AssistantContext {
                course_id: Some(course_id.clone()),
                ..Default::default()
            },
        );
        let out = tools
            .run(&call("rename_course", r#"{"new_name":"线性代数（新）"}"#))
            .await;

        let courses = crate::commands::courses::list_courses(&db).await.unwrap();
        assert_eq!(courses[0].name, "线性代数", "改名工具不该真的改");
        assert!(out.content.contains("还没有生效"));
        match tools.take_actions().as_slice() {
            [AssistantAction::ProposeRenameCourse {
                current_name,
                new_name,
                ..
            }] => {
                assert_eq!(current_name, "线性代数");
                assert_eq!(new_name, "线性代数（新）");
            }
            other => panic!("应当只产出一条课程改名提案，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn switching_theme_applies_directly_without_a_confirmation_card() {
        // 主题无破坏性、一眼可见、一句话就能改回来。给它加一次点击，
        // 只是让「把界面调暗」这种最该一步到位的事变成两步。
        let (db, _c, _v, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        tools.run(&call("set_theme", r#"{"pref":"dark"}"#)).await;
        match tools.take_actions().as_slice() {
            [AssistantAction::SetTheme { pref }] => assert_eq!(pref, "dark"),
            other => panic!("应当是一条主题动作，实际 {other:?}"),
        }
    }

    #[tokio::test]
    async fn an_invalid_theme_is_refused() {
        let (db, _c, _v, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        let out = tools.run(&call("set_theme", r#"{"pref":"深色"}"#)).await;
        assert!(out.content.contains("不是有效主题"));
        assert!(tools.take_actions().is_empty());
    }

    #[tokio::test]
    async fn opening_a_video_is_executed_directly_because_it_breaks_nothing() {
        let (db, _course, video_id, _d) = seed().await;
        let tools = AssistantTools::new(&db, AssistantContext::default());
        tools
            .run(&call(
                "open_video",
                &format!(r#"{{"video_id":"{video_id}","at_ms":90000}}"#),
            ))
            .await;
        match tools.take_actions().as_slice() {
            [AssistantAction::OpenVideo { at_ms, .. }] => assert_eq!(*at_ms, Some(90_000)),
            other => panic!("应当是一条导航动作，实际 {other:?}"),
        }
    }

    #[test]
    fn only_whitelisted_settings_are_changeable() {
        // 白名单而不是黑名单：黑名单漏一个新加的敏感键就出事，
        // 白名单漏了最多是助手说「这项我改不了」。
        assert!(setting_rule("subtitle_autocorrect").is_some());
        assert!(setting_rule("ocr_backend").is_some());
        // 不在名单里的一律不认。
        assert!(setting_rule("default_storage_root").is_none());
        assert!(setting_rule("llm_task_routing").is_none());
    }

    #[test]
    fn no_credential_key_can_ever_be_reached() {
        // 助手要能读 Key，Key 就会进它的上下文，上下文会被发给模型服务商。
        // 这条不是保守，是逻辑上不可能——所以白名单里一个密钥键都不能有。
        for rule in SETTING_RULES {
            assert!(
                !crate::commands::settings::is_secret_key(rule.key),
                "白名单里混进了凭证键：{}",
                rule.key
            );
        }
        for key in [
            "llm_key_abc",
            "secret_whatever",
            "dashscope_api_key",
            "aliyun_ocr_access_key_secret",
        ] {
            assert!(setting_rule(key).is_none(), "{key} 不该可达");
        }
    }

    #[test]
    fn setting_values_are_validated_before_being_proposed() {
        let boolean = setting_rule("subtitle_autocorrect").unwrap();
        assert!(boolean.validate("true").is_ok());
        assert!(boolean.validate("是").is_err());

        let number = setting_rule("asr_correction_concurrency").unwrap();
        assert!(number.validate("8").is_ok());
        assert!(number.validate("0").is_err(), "下界要挡住");
        assert!(number.validate("99999").is_err(), "上界要挡住");
        assert!(number.validate("很多").is_err());

        let enumerated = setting_rule("ocr_backend").unwrap();
        assert!(enumerated.validate("aliyun").is_ok());
        assert!(enumerated.validate("google").is_err());
    }

    #[test]
    fn the_tool_list_matches_what_dispatch_actually_handles() {
        // 报出去却没实现，模型会反复调一个永远失败的工具；
        // 实现了却没报出去，那段代码永远走不到。
        let names: Vec<String> = tool_specs().into_iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            [
                "list_courses",
                "list_videos",
                "search_content",
                "open_video",
                "seek_to",
                "rename_video",
                "delete_video",
                "update_setting",
                "create_course",
                "rename_course",
                "set_theme",
                "search_bilibili",
                "import_video",
            ]
        );
    }

    #[test]
    fn destructive_tools_say_out_loud_that_they_only_propose() {
        // 提示词里必须写明「只是提案」，否则模型会在回答里跟用户说「已经删好了」，
        // 而实际上东西还在——用户以为做完了，这比没做更糟。
        let specs = tool_specs();
        for name in [
            "rename_video",
            "delete_video",
            "update_setting",
            "import_video",
        ] {
            let spec = specs.iter().find(|s| s.name == name).unwrap();
            assert!(
                spec.description.contains("确认"),
                "{name} 的说明里没讲清楚这只是提案"
            );
        }
    }
}
