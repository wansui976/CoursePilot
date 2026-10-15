/**
 * 浏览器里没有 Tauri 后端：注入一个假的 window.__TAURI_INTERNALS__，按命令名返回
 * 一套「看起来像真在用」的示例数据（三门课、九集、首帧封面、讲稿/章节/摘要/笔记、
 * 课程知识、到期卡片、半年学习记录……），让每个页面都能以有内容的状态截图。
 *
 * 这个函数经 Playwright 的 addInitScript 序列化后在页面里执行：必须完全自包含，
 * 不能引用模块作用域里的任何东西。未处理的命令记在 window.__unknownCmds。
 */
export function installMockIpc({ theme }) {
  const now = Date.now();
  const DAY = 86_400_000;
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // —— 课程与视频 ——
  const courses = [
    { id: "c1", name: "机器学习导论", root_path: "/Courses/ML", cover_image: null, created_at: now, updated_at: now, video_count: 9 },
    { id: "c2", name: "线性代数的本质", root_path: "/Courses/LA", cover_image: null, created_at: now, updated_at: now, video_count: 6 },
    { id: "c3", name: "操作系统：三个简单部分", root_path: "/Courses/OS", cover_image: null, created_at: now, updated_at: now, video_count: 12 },
  ];
  const titles = [
    "01 什么是机器学习", "02 线性回归与最小二乘", "03 梯度下降的直觉", "04 逻辑回归与分类",
    "05 过拟合、正则化与偏差方差", "06 神经网络入门", "07 反向传播推导", "08 卷积神经网络", "09 注意力机制与 Transformer",
  ];
  const statuses = ["done", "done", "done", "done", "done", "done", "processing", "done", "pending"];
  const videos = titles.map((title, i) => ({
    id: `v${i + 1}`, course_id: "c1", title: `${title}.mp4`, source_type: "local", source_uri: null,
    file_path: `/Courses/ML/${title}.mp4`, duration_ms: (18 + i * 4) * 60_000 + 23_000, width: 1920, height: 1080,
    order_index: i, data_dir: "", processed_status: statuses[i], created_at: now, has_transcript: statuses[i] === "done",
  }));
  // 看片进度：前两集看完，第三集 42%，第五集 15%；上次看到第三集。
  const progress = { v1: 1, v2: 1, v3: 0.42, v5: 0.15 };
  try {
    localStorage.setItem("course-ai-theme", theme);
    for (const v of videos) {
      const dur = v.duration_ms / 1000;
      localStorage.setItem(`video-dur:${v.id}`, String(dur));
      if (progress[v.id]) localStorage.setItem(`video-pos:${v.id}`, String(dur * progress[v.id]));
    }
    localStorage.setItem("course-ai-last-video:c1", "v3");
  } catch {
    // 隐私模式等存储不可用：只是少了进度条，不影响截图。
  }

  // —— 封面：每集画一张「课件首页」风格的渐变图（JPEG 字节，与后端返回一致）——
  const palette = [["#1e3a8a", "#3b82f6"], ["#312e81", "#8b5cf6"], ["#134e4a", "#14b8a6"], ["#7c2d12", "#f97316"], ["#1f2937", "#64748b"], ["#831843", "#ec4899"], ["#14532d", "#22c55e"], ["#0c4a6e", "#0ea5e9"], ["#422006", "#eab308"]];
  async function cover(videoId) {
    const i = Math.max(0, Number(String(videoId).replace(/\D/g, "")) - 1) % titles.length;
    const [a, b] = palette[i % palette.length];
    const canvas = new OffscreenCanvas(640, 360);
    const g = canvas.getContext("2d");
    const grad = g.createLinearGradient(0, 0, 640, 360);
    grad.addColorStop(0, a);
    grad.addColorStop(1, b);
    g.fillStyle = grad;
    g.fillRect(0, 0, 640, 360);
    g.fillStyle = "rgba(255,255,255,0.08)";
    for (let k = 0; k < 6; k++) {
      g.beginPath();
      g.arc(520 - k * 30, 80 + k * 40, 120 - k * 10, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = "rgba(255,255,255,0.92)";
    g.font = "600 34px -apple-system, 'PingFang SC', sans-serif";
    g.fillText(titles[i].replace(/^\d+ /, ""), 40, 200);
    g.fillStyle = "rgba(255,255,255,0.6)";
    g.font = "20px -apple-system, 'PingFang SC', sans-serif";
    g.fillText(`第 ${i + 1} 讲 · 机器学习导论`, 40, 240);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.85 });
    return new Uint8Array(await blob.arrayBuffer());
  }

  // —— 工作台资料 ——
  const lines = [
    "我们先回忆一下上节课的损失函数。",
    "梯度指向函数值增长最快的方向，所以要沿着负梯度走。",
    "学习率太大，参数会在谷底两侧来回震荡；太小，收敛又会非常慢。",
    "这就是为什么实践中常用学习率衰减。",
    "接下来看随机梯度下降：每次只用一个小批量估计梯度。",
  ];
  // 覆盖整集（第 3 集 26:23，每句 15 秒）：续播落在中后段时也有字幕可显示。
  const transcript = Array.from({ length: 106 }, (_, k) => ({
    id: k, video_id: "v3", segment_idx: k, start_ms: k * 15_000, end_ms: k * 15_000 + 14_000, text: lines[k % lines.length],
  }));
  const chapters = [
    { id: 1, video_id: "v3", title: "回顾：损失函数的几何意义", summary: "把损失看成地形，参数是地形上的一点。", start_ms: 0, end_ms: 180_000, order_index: 0 },
    { id: 2, video_id: "v3", title: "梯度与最速下降方向", summary: "梯度的方向与大小各自代表什么。", start_ms: 180_000, end_ms: 420_000, order_index: 1 },
    { id: 3, video_id: "v3", title: "学习率：步子迈多大", summary: "震荡、发散与收敛过慢三种情形。", start_ms: 420_000, end_ms: 660_000, order_index: 2 },
    { id: 4, video_id: "v3", title: "随机与小批量梯度下降", summary: "用噪声换速度，以及为什么噪声有时是好事。", start_ms: 660_000, end_ms: 900_000, order_index: 3 },
  ];
  const summary = "## 本讲要点\n\n梯度下降把**最小化损失**变成一个反复迭代的过程：每一步沿负梯度方向移动一小段距离。\n\n- **梯度**：函数在当前点增长最快的方向\n- **学习率**：每一步走多远，过大震荡、过小缓慢\n- **小批量**：用部分样本估计梯度，换取速度与泛化\n\n> 直觉：蒙着眼下山，每一步都朝脚下最陡的方向迈一小步。";
  const notes = "# 梯度下降笔记\n\n## 核心思想\n\n沿**负梯度**方向迭代更新参数，直到损失不再明显下降。[00:15]\n\n## 学习率\n\n- 太大：在谷底两侧来回震荡，甚至发散 [00:30]\n- 太小：收敛很慢\n- 实践：常用**学习率衰减** [00:45]\n\n> 一句话：蒙着眼下山，每一步朝最陡处迈一小步。";

  // —— 课程知识 ——
  const occ = (vid, title, min, excerpt) => ({ video_id: vid, video_title: title, start_ms: min * 60_000, end_ms: min * 60_000 + 40_000, excerpt });
  const knowledge = {
    overview: "这门课从**线性模型**出发，经由**梯度下降**这一贯穿全课的优化手段，走到**神经网络**与**注意力机制**。前半程打地基，后半程看这些地基如何被组合成现代深度学习。",
    generated_at: now - 2 * DAY, covered_videos: 6, total_videos: 9, stale: false,
    groups: [
      { title: "优化基础", summary: "如何让损失函数变小。", concepts: [
        { id: "k1", name: "梯度下降", summary: "沿负梯度方向迭代更新参数。", explanation: "把损失看成地形，梯度告诉你哪边最陡；每一步朝下坡走一小段。", occurrences: [occ("v3", "03 梯度下降的直觉.mp4", 3, "梯度指向函数值增长最快的方向，所以要沿着负梯度走。"), occ("v7", "07 反向传播推导.mp4", 12, "反向传播只是高效地算出了这个梯度。")] },
        { id: "k2", name: "学习率衰减", summary: "训练后期逐步减小步长。", explanation: null, occurrences: [occ("v3", "03 梯度下降的直觉.mp4", 8, "这就是为什么实践中常用学习率衰减。")] },
      ] },
      { title: "模型与泛化", summary: "模型复杂度与泛化能力的取舍。", concepts: [
        { id: "k3", name: "偏差-方差权衡", summary: "欠拟合与过拟合的两端。", explanation: null, occurrences: [occ("v5", "05 过拟合、正则化与偏差方差.mp4", 6, "模型越复杂，偏差越小，但方差会变大。")] },
        { id: "k4", name: "正则化", summary: "给参数加惩罚以抑制过拟合。", explanation: null, occurrences: [occ("v5", "05 过拟合、正则化与偏差方差.mp4", 15, "L2 正则让权重倾向于变小。")] },
      ] },
    ],
  };
  const preview = [60_000, 6 * 3_600_000, 2 * DAY, 5 * DAY];
  const dueCards = [
    { id: "d1", video_id: "v3", course_id: "c1", front: "学习率过大时，梯度下降会出现什么现象？", back: "参数会在谷底两侧来回**震荡**，甚至发散，损失不降反升。", source_ms: 30_000, question_type: null, options: null, correct_options: null, preview_ms: preview },
    { id: "d2", video_id: "v5", course_id: "c1", front: "偏差-方差权衡中，模型复杂度上升会怎样？", back: "偏差下降、方差上升。", source_ms: 360_000, question_type: null, options: null, correct_options: null, preview_ms: preview },
  ];

  // —— 学习统计：确定性的节奏（工作日多、周末少、偶有断档），今天学了 34 分钟 ——
  const daily = [];
  for (let i = 200; i >= 0; i--) {
    const ts = now - i * DAY;
    const weekday = new Date(ts).getDay();
    const r = Math.abs((Math.sin(i * 12.9898) * 43758.5453) % 1);
    if (i > 0 && r < (weekday === 0 || weekday === 6 ? 0.55 : 0.25)) continue;
    const minutes = i === 0 ? 34 : Math.round(10 + r * 80);
    daily.push({ day: dayKey(ts), watched_ms: minutes * 60_000, reviews: Math.round(r * 30), good_reviews: Math.round(r * 22) });
  }

  // —— 播放源：按时长生成一段静音 WAV（blob URL）。没有 ffmpeg 也能让 <video> 拿到真实
  // 时长与进度，进度条、弹幕热度曲线、双语字幕都能按正常播放态渲染。——
  const mediaUrls = new Map();
  function silentWav(seconds) {
    const rate = 3000;
    const samples = Math.round(seconds * rate);
    const bytes = new Uint8Array(44 + samples);
    const view = new DataView(bytes.buffer);
    const ascii = (offset, text) => [...text].forEach((ch, k) => view.setUint8(offset + k, ch.charCodeAt(0)));
    ascii(0, "RIFF"); view.setUint32(4, 36 + samples, true); ascii(8, "WAVE");
    ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
    ascii(36, "data"); view.setUint32(40, samples, true);
    bytes.fill(128, 44); // 8-bit PCM 的静音是 128
    return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
  }
  function mediaUrl(videoId) {
    if (!mediaUrls.has(videoId)) {
      const video = videos.find((v) => v.id === videoId);
      mediaUrls.set(videoId, silentWav((video?.duration_ms ?? 600_000) / 1000));
    }
    return mediaUrls.get(videoId);
  }

  // —— 弹幕：三个讨论高峰（讲到学习率、震荡演示、小批量），其余零星 ——
  const danmakuTexts = ["原来如此", "这里讲得好清楚", "学习率太大就震荡了", "前方高能", "mark 一下", "老师的比喻绝了", "终于懂了梯度"];
  const danmaku = [];
  for (let k = 0; k < 420; k++) {
    const r = Math.abs((Math.sin(k * 78.233) * 43758.5453) % 1);
    const peak = [190_000, 470_000, 700_000][k % 3];
    const start = k % 4 === 0 ? Math.round(r * 1_500_000) : Math.round(peak + (r - 0.5) * 90_000);
    danmaku.push({ mode: k % 11 === 0 ? "top" : "scroll", start_ms: start, text: danmakuTexts[k % danmakuTexts.length], color: k % 9 === 0 ? "#fde047" : null, font_size: null });
  }

  const translationsEn = [
    "Let's first recall last lecture's loss function.",
    "The gradient points where the function grows fastest, so we move along the negative gradient.",
    "Too large a learning rate makes parameters oscillate across the valley; too small and convergence crawls.",
    "That is why learning-rate decay is common in practice.",
    "Next, stochastic gradient descent: estimate the gradient from a mini-batch each step.",
  ];
  const mindmap = "# 梯度下降\n## 核心思想\n### 沿负梯度迭代\n### 损失越来越小\n## 学习率\n### 过大：震荡、发散\n### 过小：收敛慢\n### 衰减策略\n## 变体\n### 随机梯度下降\n### 小批量\n### 动量";
  window.__shareImages = [];

  const handlers = {
    cmd_get_danmaku: () => danmaku,
    cmd_get_translations: ({ lang }) =>
      lang === "en" ? transcript.map((row) => ({ segment_idx: row.segment_idx, text: translationsEn[row.segment_idx % translationsEn.length] })) : [],
    cmd_list_subscriptions: ({ courseId }) =>
      courseId === "c1"
        ? [
            { id: "s1", course_id: "c1", url: "https://space.bilibili.com/123/channel/collectiondetail?sid=1", title: "吴恩达机器学习 2024 合集", auto_process: true, last_checked_at: now - 2 * 3_600_000, last_error: null, created_at: now - 20 * DAY },
            { id: "s2", course_id: "c1", url: "https://www.youtube.com/playlist?list=PL-demo", title: "Stanford CS229 Lectures", auto_process: false, last_checked_at: now - 26 * 3_600_000, last_error: "网络超时，下次检查时重试", created_at: now - 5 * DAY },
          ]
        : [],
    cmd_check_subscription: () => 2,
    cmd_save_share_image: ({ fileName, pngBase64 }) => {
      window.__shareImages.push({ fileName, pngBase64 });
      return `/Users/demo/Desktop/${fileName}.png`;
    },
    cmd_list_whisper_models: () => [
      [{ id: "large-v3-turbo", display_name: "large-v3-turbo（推荐）", size_bytes: 1_620_000_000, url: "" }, true],
      [{ id: "medium", display_name: "medium", size_bytes: 1_530_000_000, url: "" }, false],
      [{ id: "small", display_name: "small", size_bytes: 488_000_000, url: "" }, false],
    ],
    cmd_list_courses: () => courses,
    cmd_list_videos: ({ courseId }) => (courseId === "c1" ? videos : []),
    cmd_video_cover: ({ videoId }) => cover(videoId),
    cmd_media_url: ({ videoId }) => mediaUrl(videoId),
    cmd_list_processing_videos: () => [videos[6]],
    cmd_list_jobs: ({ videoId }) =>
      videoId === "v7"
        ? [{ id: "j1", video_id: "v7", stage: "asr", status: "running", progress: 0.46, message: "语音识别中", created_at: now, updated_at: now }]
        : [],
    cmd_list_transcripts: () => transcript,
    cmd_get_chapters: () => chapters,
    cmd_get_summary: () => summary,
    cmd_get_notes: () => notes,
    cmd_list_note_versions: () => [
      { id: "h:3", source: "history", edited_at: now - 25 * 60_000, captured_at: now - 20 * 60_000, content: notes.replace("> 一句话", "> 草稿：一句话") },
      { id: "h:2", source: "history", edited_at: now - 3 * 3_600_000, captured_at: now - 2 * 3_600_000, content: "# 梯度下降笔记\n\n## 核心思想\n\n沿负梯度方向迭代更新参数。[00:15]" },
      { id: "b:courseai-startup-20261013.db", source: "backup", edited_at: now - 2 * 86_400_000, captured_at: now - 86_400_000, content: "# 梯度下降\n\n- 学习率：步子迈多大\n- 小批量：用部分样本估计梯度" },
    ],
    cmd_get_quiz: () => null,
    cmd_get_mindmap: () => mindmap,
    cmd_stale_ai_artifacts: () => [],
    cmd_get_slides: () => [],
    cmd_get_screenshots: () => [],
    cmd_list_clips: () => [],
    cmd_video_skips: () => [],
    cmd_get_setting: () => null,
    cmd_has_secret: () => false,
    cmd_has_api_key: () => false,
    cmd_get_llm_profiles: () => [],
    cmd_sync_status: () => ({ enabled: false, state: "idle" }),
    cmd_list_trash: () => [
      { ...videos[3], id: "t1", title: "旧版 04 逻辑回归.mp4", deleted_at: now - 2 * DAY, expires_at: now + 28 * DAY, course_name: "机器学习导论" },
      { ...videos[5], id: "t2", title: "录屏测试.mp4", deleted_at: now - 12 * DAY, expires_at: now + 18 * DAY, course_name: "机器学习导论" },
    ],
    cmd_get_dev_logs: () => [
      { id: 1, at_ms: now - 60_000, kind: "llm", video_id: "v3", request: "summary", response: "ok", status: "ok" },
      { id: 2, at_ms: now - 30_000, kind: "asr", video_id: "v7", request: "transcribe", response: "timeout", status: "error" },
    ],
    cmd_get_course_knowledge: ({ courseId }) => (courseId === "c1" ? knowledge : null),
    cmd_list_course_concepts: ({ courseId }) => (courseId === "c1" ? knowledge.groups.flatMap((g) => g.concepts) : []),
    cmd_concept_due_counts: () => [{ concept_id: "k1", due: 2 }, { concept_id: "k3", due: 1 }],
    cmd_due_cards: () => dueCards,
    cmd_daily_totals: () => daily,
    cmd_course_totals: () => [
      { course_id: "c1", watched_ms: 5.3 * 3_600_000, last_ts: now - 3_600_000 },
      { course_id: "c2", watched_ms: 1.4 * 3_600_000, last_ts: now - 2 * DAY },
      { course_id: "c3", watched_ms: 0.5 * 3_600_000, last_ts: now - 9 * DAY },
    ],
    cmd_continue_learning: () => [
      { course_id: "c1", course_name: "机器学习导论", video_id: "v3", video_title: "03 梯度下降的直觉.mp4", last_ts: now - 3_600_000 },
    ],
    cmd_course_video_ids: () => videos.map((v) => [v.course_id, v.id]),
    cmd_video_progress: () =>
      videos.filter((v) => progress[v.id]).map((v) => ({ video_id: v.id, position_ms: Math.round(v.duration_ms * progress[v.id]), duration_ms: v.duration_ms })),
    cmd_count_due: () => 12,
    cmd_next_due_at: () => now + 3 * 3_600_000,
    cmd_due_by_course: () => [["c1", 9], ["c2", 3]],
    cmd_weak_concepts: () => [
      { concept_id: "k1", name: "学习率衰减", course_id: "c1", course_name: "机器学习导论", reviews: 8, fails: 4, again_rate: 0.5 },
      { concept_id: "k2", name: "偏差-方差权衡", course_id: "c1", course_name: "机器学习导论", reviews: 6, fails: 2, again_rate: 0.33 },
      { concept_id: "k3", name: "特征向量", course_id: "c2", course_name: "线性代数的本质", reviews: 5, fails: 2, again_rate: 0.4 },
    ],
  };

  const unknown = new Set();
  let callbackId = 0;
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: () => ++callbackId,
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (cmd, args) => {
      if (cmd.startsWith("plugin:")) return cmd.endsWith("|listen") ? ++callbackId : null;
      const handler = handlers[cmd];
      if (handler) return handler(args ?? {});
      unknown.add(cmd);
      window.__unknownCmds = [...unknown];
      // 列表类命令给空数组，其余给 null：前端多数据点都能优雅退化。
      return /list|due|logs|usage|concepts|weak|by_course|video_ids|daily|progress|totals/.test(cmd) ? [] : null;
    },
  };
}
