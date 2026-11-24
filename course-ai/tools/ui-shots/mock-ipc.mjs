/**
 * 浏览器里没有 Tauri 后端：注入一个假的 window.__TAURI_INTERNALS__，按命令名返回
 * 一套「看起来像真在用」的示例数据（三门课、九集、首帧封面、讲稿/章节/摘要/笔记、
 * 课程知识、到期卡片、半年学习记录……），让每个页面都能以有内容的状态截图。
 *
 * 这个函数经 Playwright 的 addInitScript 序列化后在页面里执行：必须完全自包含，
 * 不能引用模块作用域里的任何东西。未处理的命令记在 window.__unknownCmds。
 */
export function installMockIpc({ theme, safeArea }) {
  // 模拟真机安全区：iOS 上页面读 env()（浏览器里恒为 0），直接写 --native-inset-*；
  // Android 上页面会经 system_bar_insets 重取一遍，下面的 handler 返回同一组值。
  if (safeArea) {
    const applySafeArea = () => {
      for (const [side, value] of Object.entries(safeArea)) {
        document.documentElement.style.setProperty(`--native-inset-${side}`, `${value}px`);
      }
    };
    // WebKit 跑 init script 时 <html> 还没建出来（Chromium 已经有了），等它插进文档再写。
    if (document.documentElement) applySafeArea();
    else {
      new MutationObserver((_, observer) => {
        if (!document.documentElement) return;
        observer.disconnect();
        applySafeArea();
      }).observe(document, { childList: true });
    }
  }
  const now = Date.now();
  const DAY = 86_400_000;
  const dayKey = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  // —— 课程与视频 ——
  const courses = [
    { id: "c1", name: "机器学习导论", root_path: "/Courses/ML", cover_image: null, created_at: now, updated_at: now, video_count: 9, sort_order: 0, color: null },
    { id: "c2", name: "线性代数的本质", root_path: "/Courses/LA", cover_image: null, created_at: now, updated_at: now, video_count: 6, sort_order: 1, color: "teal" },
    { id: "c3", name: "操作系统：三个简单部分", root_path: "/Courses/OS", cover_image: null, created_at: now, updated_at: now, video_count: 12, sort_order: 2, color: "orange" },
  ];
  const extraCourses = [
    { id: "c4", name: "宏观经济学", root_path: "/Courses/Macro", cover_image: null, created_at: now, updated_at: now, video_count: 12, sort_order: 3, color: "purple" },
    { id: "c5", name: "日语 N3 语法", root_path: "/Courses/JP", cover_image: null, created_at: now, updated_at: now, video_count: 48, sort_order: 4, color: "pink" },
    { id: "c6", name: "数据结构与算法", root_path: "/Courses/DSA", cover_image: null, created_at: now, updated_at: now, video_count: 40, sort_order: 5, color: "blue" },
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
  // 文件夹场景：第 1–4 讲在「第1章 基础」，5–7 讲在「第2章 神经网络」（其下再分一层），8、9 讲留在根目录。
  const folders = [
    { id: "f1", course_id: "c1", parent_id: null, name: "第1章 基础", color: "blue", order_index: 0, created_at: now, updated_at: now },
    { id: "f2", course_id: "c1", parent_id: null, name: "第2章 神经网络", color: "teal", order_index: 5, created_at: now, updated_at: now },
    { id: "f3", course_id: "c1", parent_id: "f2", name: "2.1 反向传播", color: null, order_index: 8, created_at: now, updated_at: now },
  ];
  const chapterOf = ["f1", "f1", "f1", "f1", "f2", "f2", "f3", null, null];
  videos.forEach((video, i) => (video.folder_id = chapterOf[i]));
  const deletedModels = new Set();
  const withFolders = () => {
    try {
      return localStorage.getItem("__shot-folders") === "1";
    } catch {
      return false;
    }
  };
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
    // 新手引导默认记为看过，免得气泡挡住其他截图；只有 tour 场景打开它。
    if (localStorage.getItem("__shot-tours") === "1") localStorage.removeItem("course-ai-tours-seen");
    else localStorage.setItem("course-ai-tours-seen", JSON.stringify(["library", "course", "courseFeatures", "workbench"]));
  } catch {
    // 隐私模式等存储不可用：只是少了进度条，不影响截图。
  }

  const pencilNotes = [
    { id: "p1", quote: "负梯度", note: "梯度指向增长最快的方向，所以取负号往下走。", created_at: now },
    { id: "p2", quote: "在谷底两侧来回震荡", note: "步长越过谷底，在两侧来回跳；小结：步长要和坡度匹配。", created_at: now },
    { id: "p3", quote: "学习率衰减", note: "常见几种：step、cosine、warmup——第 5 讲会讲。", created_at: now },
  ];

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
  const noteImages = new Map();
  // 长笔记：八个小节，第一节贴了一张截图（左上角夹回形针），用来看分页记号和侧边索引标签。
  const longNotes = [
    "# 梯度下降笔记",
    ...["一、核心思想", "二、学习率", "三、小批量", "四、动量", "五、Adam", "六、正则化", "七、早停", "八、总结"].map(
      (title, i) =>
        `## ${title}\n\n` +
        (i === 0 ? "![课上截图](note-image:frame1)\n\n" : "") +
        "沿**负梯度**方向迭代更新参数，直到损失不再明显下降。每一步走多远由学习率决定。[00:15]\n\n" +
        "- 太大：在谷底两侧来回震荡，甚至发散 [00:30]\n- 太小：收敛很慢\n- 实践：常用**学习率衰减** [00:45]\n\n" +
        "> 一句话：蒙着眼下山，每一步朝最陡处迈一小步。",
    ),
  ].join("\n\n");
  const notes = "# 梯度下降笔记\n\n## 核心思想\n\n沿**负梯度**方向迭代更新参数，直到损失不再明显下降。[00:15]\n\n## 学习率\n\n- 太大：在谷底两侧来回震荡，甚至发散 [00:30]\n- 太小：收敛很慢\n- 实践：常用**学习率衰减** [00:45]\n\n> 一句话：蒙着眼下山，每一步朝最陡处迈一小步。";

  // —— 课程知识 ——
  const occ = (vid, title, min, excerpt) => ({ video_id: vid, video_title: title, start_ms: min * 60_000, end_ms: min * 60_000 + 40_000, excerpt });
  // 复习资料：整门课笔记按知识逻辑重排的分章内容（出处 [N017 12:30] 渲染成可点的标签）。
  const src = (video_id, video_title, start_ms) => ({ video_id, video_title, start_ms });
  const reviewBook = {
    title: "机器学习导论 · 期末复习",
    generated_at: now - DAY,
    outline_stale: false,
    videos_with_notes: 6,
    videos_without_notes: ["08 注意力机制", "09 课程总结"],
    chapters: [
      {
        idx: 0, title: "梯度下降：让损失一步步变小", intro: "从损失函数的几何意义出发，弄清梯度下降每一步在做什么、步子该迈多大。",
        sources: { N003: src("v3", "03 梯度下降的直觉", 180_000), N004: src("v3", "03 梯度下降的直觉", 420_000), N005: src("v3", "03 梯度下降的直觉", 660_000), N019: src("v7", "07 反向传播推导", 120_000) },
        content_md: [
          "## 学习目标",
          "- 能用「下山」解释梯度下降的更新方向 [N003 03:12]",
          "- 能判断学习率过大、过小时损失曲线的样子 [N004 07:40]",
          "- 能说清批量、随机、小批量三种梯度下降的取舍 [N005 11:05]",
          "",
          "## 梯度与更新规则",
          "**定义**：梯度指向函数值增长最快的方向，所以参数沿**负梯度**更新：\\(\\theta \\leftarrow \\theta - \\eta \\nabla L(\\theta)\\) [N003 03:12]",
          "",
          "- 梯度的**方向**决定往哪走，**大小**说明这里有多陡 [N003 04:30]",
          "- 反向传播不是新的优化方法，只是高效地算出这个梯度 [N019 02:10]",
          "",
          "## 学习率：步子迈多大",
          "- 太大：在谷底两侧来回**震荡**，甚至发散 [N004 07:40]",
          "- 太小：收敛极慢，训练几轮几乎不动 [N004 08:15]",
          "- 实践中先用较大学习率、后期逐步衰减 [N004 09:02]",
          "",
          "## 易混辨析",
          "| 概念 | 区别 | 怎么判 |",
          "| --- | --- | --- |",
          "| 批量梯度下降 | 每步用全部样本 | 曲线平滑但每步很慢 |",
          "| 随机梯度下降 | 每步一个样本 | 曲线抖动大，跳出局部极小 [N005 12:20] |",
          "",
          "## 本章速查",
          "| 考点 | 怎么判 | 怎么答 |",
          "| --- | --- | --- |",
          "| 更新方向 | 问「往哪走」 | 沿负梯度 [N003 03:12] |",
          "| 学习率过大 | 损失上下跳 | 震荡或发散，调小学习率 [N004 07:40] |",
        ].join("\n"),
        error: null, stale: false, generated_at: now - DAY,
      },
      {
        idx: 1, title: "过拟合与正则化", intro: "模型越复杂越容易记住噪声，正则化给参数加惩罚把它拉回来。",
        sources: { N011: src("v5", "05 过拟合、正则化与偏差方差", 90_000), N012: src("v5", "05 过拟合、正则化与偏差方差", 360_000) },
        content_md: [
          "## 学习目标",
          "- 能区分欠拟合与过拟合 [N011 01:30]",
          "- 能说清 L1 与 L2 正则的效果差异 [N012 06:00]",
          "",
          "## 偏差与方差",
          "模型越复杂，**偏差越小，方差越大**；目标是在两者之间找平衡点 [N011 02:45]",
        ].join("\n"),
        error: null, stale: true, generated_at: now - DAY,
      },
      {
        idx: 2, title: "神经网络与反向传播", intro: "",
        sources: {}, content_md: null,
        error: "模型输出达到单次输出上限被截断，结果不完整。可在 设置 → 大模型 → 高级 里调大「单次输出上限」。",
        stale: false, generated_at: null,
      },
    ],
  };

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
  const mindmap = "# 梯度下降\n## 核心思想\n### 沿负梯度迭代 [03:00]\n### 损失越来越小 [04:20]\n## 学习率\n### 过大：震荡、发散 [07:10]\n### 过小：收敛慢 [08:05]\n### 衰减策略 [09:30]\n## 变体\n### 随机梯度下降 [11:00]\n### 小批量 [12:15]\n### 动量 [14:40]";
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
    // 手机上后端只列 sherpa 模型；__shot-lowmem 时 Qwen3-ASR 标成「内存不够」。
    // 本地识别只有 SenseVoice / Qwen3-ASR（Whisper 已不再支持）。删掉的模型在这一会话里记成未安装。
    cmd_list_whisper_models: () => {
      const lowMem = localStorage.getItem("__shot-lowmem") === "1";
      return [
        [{ id: "sensevoice", display_name: "SenseVoice（中文推荐 · 快）", size_bytes: 240_000_000, url: "", fits_memory: true }, !deletedModels.has("sensevoice")],
        [{ id: "qwen3-asr", display_name: "Qwen3-ASR 0.6B（更准 · 支持 GPU 加速）", size_bytes: 1_020_000_000, url: "", fits_memory: !lowMem }, !lowMem && !deletedModels.has("qwen3-asr")],
      ];
    },
    cmd_delete_asr_model: ({ id }) => {
      deletedModels.add(id);
    },
    cmd_get_models_dir: () => ({
      path: "/Users/demo/Library/Application Support/dev.courseai.app",
      is_default: true,
      default_path: "/Users/demo/Library/Application Support/dev.courseai.app",
      size_bytes: (deletedModels.has("sensevoice") ? 0 : 240_000_000) + (deletedModels.has("qwen3-asr") ? 0 : 1_020_000_000),
      legacy_bytes: 0,
    }),
    // 「导入整个文件夹」选中的是 B 站客户端的缓存目录。
    cmd_scan_folder: () => [
      ...[
        "P1 绪论：什么是机器学习", "P2 线性回归与最小二乘", "P3 梯度下降的直觉", "P4 逻辑回归与分类",
        "P5 正则化与偏差方差", "P6 神经网络入门",
      ].map((name, i) => ({ path: `/Users/demo/Movies/bilibili/${3_000_001 + i}`, name: `吴恩达机器学习 ${name}`, bilibili_cache: true })),
      { path: "/Users/demo/Movies/bilibili/课堂录屏 第7周.mp4", name: "课堂录屏 第7周.mp4" },
    ],
    // 助手：回放一条完整回答。__shot-guided 时回一段引导模式的回答（带结构块）。
    cmd_assistant_ask: ({ requestId, query }) => {
      const guided = localStorage.getItem("__shot-guided") === "1";
      const answer = guided
        ? query.includes("远")
          ? '对，步子迈得太远就会越过谷底，到了另一侧又往回迈——于是来回震荡。\n\n```socratic\n{"done":true,"summary":["步长 = 学习率 × 梯度，学习率大步子就大","步子太大会越过谷底，在两侧来回跳","所以损失曲线震荡甚至发散"],"answer":"学习率过大时更新步长过大，参数在最优点两侧来回跳，损失震荡或发散。"}\n```'
          : '先别急着记结论。想一想：每一步更新时，参数挪动的距离由什么决定？学习率很大的时候，这一步会迈多远？可以回看 [07:10] 老师画的那张图。\n\n```socratic\n{"step":1,"total":3,"options":["迈得很远","迈得很近","和学习率无关"],"hints":["更新公式：新参数 = 旧参数 − 学习率 × 梯度","把损失曲线想成一个山谷，步子太大会怎样？"],"answer":"步长和学习率成正比，学习率大，一步就迈得很远。","done":false}\n```'
        : "**梯度下降**每一步沿负梯度方向走一小步，学习率决定步子有多大。[03:00]\n\n老师讲了两种情况：\n\n1. 学习率太小：收敛很慢，要走很多步。\n2. 学习率太大：越过谷底，在两侧来回震荡，甚至发散 [07:10]。\n\n课上建议先从 0.01 试起，看损失曲线再调。";
      const actions = guided ? [] : [{ kind: "seek_to", at_ms: 430_000 }];
      setTimeout(() => {
        window.__emit(`assistant-stream:${requestId}`, { type: "started" });
        window.__emit(`assistant-stream:${requestId}`, {
          type: "done",
          reply: { answer, canceled: false, hit_turn_limit: false, actions, turns: 2, tools_used: ["search_content", "get_transcript_around"], usage: { prompt_tokens: 5200, completion_tokens: 180, reasoning_tokens: 0, cached_tokens: 4800 }, history: [] },
        });
      }, 50);
      return null;
    },
    // 拍题找讲解：识字给一段题目文字，检索给两段最相关 + 一段可能相关。
    cmd_ocr_image: () => "设损失函数 L(w)=(w-3)²，学习率 η=1.2，从 w=0 开始做梯度下降，参数会怎样变化？",
    cmd_find_explanations: () => ({
      hits: [
        { video_id: videos[2].id, video_title: videos[2].title, start_ms: 430_000, end_ms: 520_000, snippet: "学习率太大时，每一步都越过谷底，在两侧来回震荡，甚至发散。", slide_image: null, slide_page: null, matched_by: "text", strong: true },
        { video_id: videos[2].id, video_title: videos[2].title, start_ms: 180_000, end_ms: 230_000, snippet: "更新公式：w ← w − η·∇L(w)，步长由学习率和梯度共同决定。", slide_image: null, slide_page: null, matched_by: "text", strong: true },
        { video_id: videos[1].id, video_title: videos[1].title, start_ms: 600_000, end_ms: 640_000, snippet: "最小二乘的损失是一个开口向上的抛物面。", slide_image: null, slide_page: null, matched_by: "text", strong: false },
      ],
      concepts: [
        { concept_id: "k1", name: "学习率", video_id: videos[2].id, start_ms: 420_000 },
        { concept_id: "k2", name: "梯度下降", video_id: videos[2].id, start_ms: 60_000 },
      ],
    }),
    // 精华版：一段闲聊、一段课务、一段重复讲解（各档力度都有东西可看）。
    cmd_get_highlights: () => [
      { start_ms: 95_000, end_ms: 150_000, kind: "chitchat", level: 1, reason: "聊上周的球赛" },
      { start_ms: 600_000, end_ms: 660_000, kind: "repeat", level: 2, reason: "把公式又念了一遍" },
      { start_ms: 900_000, end_ms: 960_000, kind: "admin", level: 1, reason: "布置作业" },
    ],
    // 费曼复述：讲到两点、漏一点、讲错一处。
    cmd_feynman_attempts: () => [],
    cmd_feynman_mastered: () => [],
    cmd_feynman_mastery_summary: () => [3, 8],
    cmd_feynman_evaluate: ({ explanation }) => ({
      id: "f1",
      topic_key: "range:x:0",
      explanation,
      created_at: now,
      result: {
        covered: [
          { point: "沿负梯度方向一步步更新参数", quote: "每一步都沿着负梯度的方向走一小步" },
          { point: "步长由学习率决定", quote: "走多远由学习率决定" },
        ],
        missed: [{ point: "学习率过大会在谷底两侧震荡", video_id: videos[2].id, ref_ms: 430_000 }],
        wrong: [{ quote: "学习率越大收敛越快", correction: "过大反而会震荡甚至发散，太小才是收敛慢", video_id: videos[2].id, ref_ms: 450_000 }],
        comment: "更新方向和步长讲清楚了，再补上学习率过大会怎样。",
      },
    }),
    // __shot-slow-ai：生成一直不返回，用来拍「后台任务」进行中的样子。
    cmd_generate_ai: () => {
      try {
        if (localStorage.getItem("__shot-slow-ai") === "1") return new Promise(() => {});
      } catch {
        // 存储不可用：按立即完成处理
      }
      return null;
    },
    // __shot-empty：模拟第一次打开、一门课都没有（tour 场景用）。
    // 进度条上的学习痕迹：几张有出处的卡，其中一张答错过。
    cmd_card_marks: () => [
      { card_id: "k1", source_ms: 190_000, lapses: 0 },
      { card_id: "k2", source_ms: 420_000, lapses: 1 },
      { card_id: "k3", source_ms: 640_000, lapses: 0 },
      { card_id: "k4", source_ms: 1_120_000, lapses: 2 },
    ],
    cmd_mistake_cards: () => [
      { card_id: "k2", video_id: "v3", course_id: "c1", front: "学习率太大时，损失曲线会出现什么现象？", back: "在谷底两侧来回震荡，甚至发散。", source_ms: 420_000, lapses: 2, streak: 1 },
      { card_id: "k4", video_id: "v3", course_id: "c1", front: "小批量梯度下降相比全量有什么好处？", back: "每步更便宜，噪声还有助于跳出鞍点。", source_ms: 1_120_000, lapses: 1, streak: 0 },
    ],
    cmd_card_history: () => {
      const day = 86_400_000;
      const t0 = Date.now() - 21 * day;
      return {
        card_id: "k1", front: "Q", created_at: t0,
        reviews: [
          { ts: t0, rating: 3, stability: 2.3 },
          { ts: t0 + 3 * day, rating: 3, stability: 7.1 },
          { ts: t0 + 9 * day, rating: 2, stability: 9.4 },
          { ts: t0 + 13 * day, rating: 3, stability: 21.5 },
        ],
        due_at: t0 + 34 * day, factor: 19 / 81, decay: -0.5,
      };
    },
    // 收集册的四种卡面：点亮、褪色、待点亮，k4 没有卡（剪影）。
    cmd_concept_mastery: () => [
      { concept_id: "k1", cards: 3, reviewed: 3, retention: 0.94 },
      { concept_id: "k2", cards: 2, reviewed: 2, retention: 0.62 },
      { concept_id: "k3", cards: 1, reviewed: 0, retention: null },
    ],
    cmd_list_courses: () => {
      try {
        if (localStorage.getItem("__shot-empty") === "1") return [];
      } catch {
        // 存储不可用：按有课处理
      }
      // __shot-many-courses：再加几门空课，课程多于 4 门时主页叠成牌堆。
      let list = courses;
      try {
        if (localStorage.getItem("__shot-many-courses") === "1") list = courses.concat(extraCourses);
      } catch {
        // 存储不可用：按三门课处理
      }
      return list.map((course) => ({
        ...course,
        folder_count: course.id === "c1" && withFolders() ? folders.length : 0,
      }));
    },
    cmd_reorder_courses: ({ orderedIds }) => {
      const byId = new Map(courses.map((course) => [course.id, course]));
      courses.splice(0, courses.length, ...orderedIds.map((id) => byId.get(id)));
      courses.forEach((course, index) => (course.sort_order = index));
    },
    cmd_set_course_color: ({ id, color }) => {
      const course = courses.find((c) => c.id === id);
      if (course) course.color = color;
    },
    // __shot-folders：机器学习导论分成两章（文件夹场景用），其余场景保持平铺。
    cmd_list_folders: ({ courseId }) => (courseId === "c1" && withFolders() ? folders : []),
    cmd_create_folder: ({ courseId, parentId, name }) => {
      const folder = {
        id: `f${folders.length + 1}`, course_id: courseId, parent_id: parentId, name, color: null,
        order_index: 100 + folders.length, created_at: now, updated_at: now,
      };
      folders.push(folder);
      return folder;
    },
    cmd_rename_folder: ({ id, name }) => {
      const folder = folders.find((f) => f.id === id);
      if (folder) folder.name = name;
    },
    cmd_set_folder_color: ({ id, color }) => {
      const folder = folders.find((f) => f.id === id);
      if (folder) folder.color = color;
    },
    cmd_delete_folder: ({ id }) => {
      const index = folders.findIndex((f) => f.id === id);
      if (index >= 0) folders.splice(index, 1);
    },
    cmd_move_items: ({ folderId, items }) => {
      for (const item of items) {
        const list = item.kind === "folder" ? folders : videos;
        const row = list.find((x) => x.id === item.id);
        if (row && item.kind === "folder") row.parent_id = folderId;
        if (row && item.kind === "video") row.folder_id = folderId;
      }
    },
    cmd_reorder_container: ({ items }) => {
      items.forEach((item, index) => {
        const row = (item.kind === "folder" ? folders : videos).find((x) => x.id === item.id);
        if (row) row.order_index = index;
      });
      videos.sort((a, b) => a.order_index - b.order_index);
    },
    // 搜索：标题子串 + 一条写死的笔记命中 + 两条文稿命中（演示「也搜文稿」打开后的样子）。
    cmd_search_course: ({ courseId, folderId, query }) => {
      if (courseId !== "c1") return { hits: [], transcripts_included: true };
      const scope = (video) => !folderId || !withFolders() || video.folder_id === folderId;
      const q = query.toLowerCase();
      const hits = videos.filter(scope).flatMap((video) => {
        const titleMatch = video.title.toLowerCase().includes(q);
        const note = video.id === "v2" && "梯度".includes(q) ? "…最小二乘也可以用梯度下降来解，学习率选得太大会发散…" : null;
        const lines =
          video.id === "v3" && q === "梯度"
            ? [
                { start_ms: 63_000, snippet: "梯度就是函数在当前点增长最快的方向" },
                { start_ms: 245_000, snippet: "所以我们沿着负梯度方向走一小步" },
              ]
            : [];
        if (!titleMatch && !note && !lines.length) return [];
        return [{
          video_id: video.id, title: video.title, folder_id: withFolders() ? video.folder_id : null,
          title_match: titleMatch, note_snippet: note, transcript_hits: lines,
          transcript_count: lines.length ? 7 : 0,
        }];
      });
      hits.sort((a, b) => Number(b.title_match) - Number(a.title_match));
      return { hits, transcripts_included: true };
    },
    // __shot-shuffled：课程里的视频顺序被打乱（拍「按讲次排序」按钮）。
    cmd_list_videos: ({ courseId }) => {
      if (courseId !== "c1") return [];
      // __shot-remote / __shot-drive：「03 梯度下降的直觉」这台设备上没有文件（从别的设备同步来 / 网盘在线看）。
      const remote = localStorage.getItem("__shot-remote") === "1" || localStorage.getItem("__shot-drive") === "1";
      const list = videos
        .map((video) => (withFolders() ? video : { ...video, folder_id: null }))
        .map((video) =>
          remote && video.id === "v3"
            ? { ...video, file_path: "", source_type: "url", source_uri: "http://192.168.1.5:5244/dav/%E8%AF%BE/03.mp4" }
            : video,
        );
      if (localStorage.getItem("__shot-shuffled") !== "1") return list;
      return [7, 2, 0, 5, 1, 8, 3, 6, 4].map((i, order_index) => ({ ...list[i], order_index }));
    },
    cmd_video_cover: ({ videoId }) => cover(videoId),
    // —— 窗外的天气：__shot-weather 指定天气（默认小雨）——
    cmd_weather_now: () => ({
      condition: localStorage.getItem("__shot-weather") || "drizzle",
      is_day: true,
      temperature_c: 9.6,
      sunrise_ms: null,
      sunset_ms: null,
      fetched_at: now,
    }),
    cmd_weather_find_place: () => [
      { name: "上海", region: "中国", latitude: 31.22, longitude: 121.46 },
      { name: "上海市", region: "吉林，中国", latitude: 43.5, longitude: 125.2 },
    ],
    // —— 铅笔批注：设 __shot-pencil 时笔记页边有三条 ——
    cmd_note_annotations: () => (localStorage.getItem("__shot-pencil") === "1" ? pencilNotes : []),
    cmd_annotate_notes: () => pencilNotes,
    cmd_erase_note_annotation: () => null,
    // —— 黑板封面：AI 判断的学科 / 关键术语 / 新学科的图 ——
    // 设 __shot-ai-covers 时，第二门课给关键术语（通用黑板），第三门课给一幅 AI 画的图。
    cmd_course_covers: () => [],
    cmd_classify_course_cover: ({ courseId }) => {
      const ai = localStorage.getItem("__shot-ai-covers") === "1";
      const base = { course_id: courseId, terms: [], art: null, source: "ai", updated_at: now };
      if (ai && courseId === "c2") return { ...base, kind: "generic", terms: ["虹鳟", "生食标准", "寄生虫"] };
      if (ai && courseId === "c3")
        return {
          ...base,
          kind: "custom",
          terms: ["三文鱼"],
          art: [
            { t: "path", d: "M168 96 C 190 66 240 66 262 96 C 240 126 190 126 168 96 Z" },
            { t: "path", d: "M262 96 L 288 76 L 284 96 L 288 116 Z" },
            { t: "circle", cx: 186, cy: 90, r: 3 },
            { t: "path", d: "M200 80 C 206 90 206 102 200 112 M218 78 C 224 90 224 102 218 114 M236 80 C 242 90 242 102 236 112" },
            { t: "line", x1: 160, y1: 146, x2: 290, y2: 146 },
            { t: "text", x: 164, y: 140, s: 13, v: "Salmo salar" },
          ],
        };
      const kinds = { c1: "ml", c2: "linear", c3: "systems", c4: "economics", c5: "language", c6: "datastruct" };
      return { ...base, kind: kinds[courseId] ?? "generic" };
    },
    cmd_set_course_cover_kind: ({ courseId, kind }) => ({ course_id: courseId, kind, terms: [], art: null, source: "user", updated_at: now }),
    cmd_media_url: ({ videoId }) => mediaUrl(videoId),
    // —— 多设备同步 / 局域网直连播放 / 从网盘导入 ——
    cmd_remote_sync_status: () => ({
      enabled: true,
      url: "https://dav.jianguoyun.com/dav/",
      folder: "CoursePilot",
      user: "me@example.com",
      hasPassword: true,
      deviceId: "d-mac",
      deviceName: "Mac（MacBook-Pro）",
      pending: 0,
      devices: [
        { deviceId: "d-win", name: "Windows（DESKTOP-7Q2）", platform: "windows", seenAt: now - 25 * 60_000 },
        { deviceId: "d-phone", name: "安卓", platform: "android", seenAt: now - 3 * DAY },
      ],
      state: { running: false, lastSuccessAt: now - 4 * 60_000, lastError: null, lastReport: null },
      uploadMedia: true,
      media: { uploading: { videoId: "v5", title: "05 过拟合、正则化与偏差方差.mp4", sent: 180 * 1024 * 1024, total: 420 * 1024 * 1024 }, lastError: null },
    }),
    cmd_semantic_status: () => ({
      backend: "local",
      localSupported: true,
      localModel: "bge-m3",
      cloudProfile: null,
      cloudModel: null,
      models: [
        { id: "bge-small-zh", name: "BGE Small 中文", description: "轻量、速度快，适合旧电脑", size: 24 * 1024 * 1024, installed: true, sizeOnDisk: 23 * 1024 * 1024 },
        { id: "bge-m3", name: "BGE-M3（多语言）", description: "中英混排和长句的效果更好", size: 570 * 1024 * 1024, installed: true, sizeOnDisk: 562 * 1024 * 1024 },
        { id: "qwen3-embedding-0.6b", name: "Qwen3 Embedding 0.6B", description: "中文语义更准，占用也更大", size: 1200 * 1024 * 1024, installed: false, sizeOnDisk: 0 },
      ],
      active: true,
      indexed: 63,
      total: 78,
      progress: { running: true, pending: 15, done: 4, currentTitle: "04 逻辑回归与分类.mp4", lastError: null },
    }),
    cmd_lan_share_status: () => ({ supported: true, enabled: true, running: true, port: 47321, addresses: ["192.168.1.5"], error: null }),
    cmd_lan_stream_url: () => null,
    cmd_remote_stream_problem: () => null,
    cmd_remote_sync_media_size: () => 734 * 1024 * 1024,
    cmd_webdav_stream_url: ({ videoId }) => (localStorage.getItem("__shot-drive") === "1" ? mediaUrl(videoId) : null),
    cmd_webdav_sources: () => [
      { id: "sync", kind: "webdav", name: "", url: "https://dav.jianguoyun.com/dav/", user: "me@example.com", hasPassword: true, isSync: true },
      { id: "nas", kind: "webdav", name: "家里的 OpenList", url: "http://192.168.1.5:5244/dav/", user: "admin", hasPassword: true, isSync: false },
      { id: "q", kind: "quark", name: "", url: "quark://", user: "", hasPassword: true, isSync: false },
    ],
    cmd_webdav_browse: ({ path }) => {
      const dir = (name, p) => ({ name, path: p, isDir: true, size: null, isVideo: false, url: "" });
      const file = (name, size, isVideo = true) => ({ name, path: `${path}${name}`, isDir: false, size: size * 1024 * 1024, isVideo, url: `http://192.168.1.5:5244/dav/${encodeURI(path + name)}` });
      if (!path) return [dir("百度网盘", "百度网盘/"), dir("夸克", "夸克/"), dir("阿里云盘", "阿里云盘/")];
      if (path === "百度网盘/") return [dir("2027 申论系统班", "百度网盘/2027 申论系统班/"), dir("行测资料分析", "百度网盘/行测资料分析/")];
      return [
        dir("讲义", `${path}讲义/`),
        file("第01讲 概括题的作答逻辑.mp4", 412),
        file("第02讲 归纳概括的要点提取.mp4", 389),
        file("第03讲 综合分析：解释型题目.mp4", 455),
        file("第04讲 综合分析：评价型题目.mp4", 431),
        file("第10讲 大作文的结构与论证.mp4", 528),
        file("课程说明.pdf", 2, false),
      ];
    },
    cmd_list_processing_videos: () => [videos[6]],
    cmd_ai_usage_summary: () => {
      const row = (key, name, cost, calls = 6, prompt = 182_000, cached = 141_000, out = 9_800) => ({
        key, name, calls, promptTokens: prompt, cachedTokens: cached, completionTokens: out, costUsd: cost, unpricedCalls: 0,
      });
      return {
        sinceMs: now - 30 * 86_400_000,
        total: row("", null, 0.86, 214, 3_960_000, 3_020_000, 241_000),
        byLabel: [row("correction", null, 0.31, 96), row("notes", null, 0.18, 22), row("quiz", null, 0.14, 24), row("chapters", null, 0.09, 22), row("summary", null, 0.07, 22), row("mindmap", null, 0.05, 22), row("assistant", null, 0.02, 6)],
        byCourse: [row("c1", "机器学习导论", 0.71, 170), row("c2", "线性代数的本质", 0.13, 38), row("", null, 0.02, 6)],
        byModel: [row("deepseek-flash", null, 0.86, 214)],
        monthCostUsd: 0.86,
        budgetUsd: 5,
      };
    },
    cmd_deepseek_balance: () => ({
      profileName: "DeepSeek",
      isAvailable: true,
      balances: [{ currency: "CNY", total: "86.40", granted: "10.00", toppedUp: "76.40" }],
    }),
    cmd_video_ai_usage: () => ({ key: "", name: null, calls: 31, promptTokens: 612_000, cachedTokens: 488_000, completionTokens: 41_000, costUsd: 0.093, unpricedCalls: 0 }),
    cmd_list_recent_processed_videos: () =>
      [videos[2], videos[1], videos[0]].map((video, i) => ({
        ...video,
        finished_at: now - [6, 95, 60 * 26][i] * 60_000,
      })),
    // 下载占位只在专门场景里打开，避免改动其他截图的基准。
    cmd_list_downloads: () => {
      try {
        if (localStorage.getItem("__shot-downloads") !== "1") return [];
      } catch {
        return [];
      }
      return [
        {
          id: "d1", batchId: "b1", courseId: "c1", url: "https://www.bilibili.com/video/BV1xx411c7mD",
          title: "10 强化学习入门.mp4", status: "downloading", downloaded: 42, total: 100,
          speed: 3.1 * 1024 ** 2, eta: 32, message: null, error: null, videoId: null, attempt: 1,
        },
        {
          id: "d2", batchId: "b1", courseId: "c1", url: "https://www.bilibili.com/video/BV1yy411c7mE",
          title: "11 生成模型与变分推断.mp4", status: "queued", downloaded: 0, total: null,
          speed: null, eta: null, message: null, error: null, videoId: null, attempt: 1,
        },
      ];
    },
    cmd_list_jobs: ({ videoId }) =>
      videoId === "v7"
        ? [{ id: "j1", video_id: "v7", stage: "asr", status: "running", progress: 0.46, message: localStorage.getItem("__shot-local-asr") === "1" ? "本地识别中（sensevoice，zh）" : "语音识别中", created_at: now, updated_at: now }]
        : [],
    cmd_list_transcripts: () => transcript,
    cmd_get_chapters: () => chapters,
    cmd_get_summary: () => summary,
    // __shot-long-notes：把笔记重复十遍，看分页记号。
    cmd_get_notes: () => (localStorage.getItem("__shot-long-notes") === "1" ? longNotes : notes),
    cmd_list_note_versions: () => [
      { id: "h:3", source: "history", edited_at: now - 25 * 60_000, captured_at: now - 20 * 60_000, content: notes.replace("> 一句话", "> 草稿：一句话") },
      { id: "h:2", source: "history", edited_at: now - 3 * 3_600_000, captured_at: now - 2 * 3_600_000, content: "# 梯度下降笔记\n\n## 核心思想\n\n沿负梯度方向迭代更新参数。[00:15]" },
      { id: "b:courseai-startup-20261013.db", source: "backup", edited_at: now - 2 * 86_400_000, captured_at: now - 86_400_000, content: "# 梯度下降\n\n- 学习率：步子迈多大\n- 小批量：用部分样本估计梯度" },
    ],
    cmd_save_note_image: ({ dataBase64 }) => {
      const id = `img${noteImages.size + 1}`;
      noteImages.set(id, Uint8Array.from(atob(dataBase64), (c) => c.charCodeAt(0)));
      return { id, src: `note-image:${id}` };
    },
    cmd_read_note_image: ({ id }) =>
      id === "frame1" ? cover("v3") : (noteImages.get(id) ?? Promise.reject(`not found: note image ${id}`)),
    // 截取画面：拿封面当作那一帧。
    cmd_capture_frame: ({ videoId, atMs }) => ({ id: 1, video_id: videoId, image_path: `/shots/${atMs}.jpg`, at_ms: atMs, created_at: now }),
    cmd_read_slide_image: ({ videoId }) => cover(videoId),
    cmd_capture_frame_image: ({ videoId }) => cover(videoId),
    // __shot-quiz：两套题（最初的一套 + 理解应用），覆盖单选、多选、判断、改错、简答。
    cmd_get_quiz: () =>
      localStorage.getItem("__shot-quiz") === "1"
        ? JSON.stringify([
            { type: "judge", stem: "梯度下降每一步都沿负梯度方向更新参数。", answer: true, explanation: "讲稿：沿着负梯度的方向走一小步。", ref_ms: 180000 },
            {
              type: "single", set_id: "s2", style: "apply", set_at: now - 3_600_000,
              stem: "训练一个房价模型时，损失曲线前几轮大幅上下跳动、始终降不下去。最可能的原因和处理是：",
              options: ["数据量太少，应该先多收集数据", "学习率过大，在谷底两侧来回越过，应调小学习率", "模型太简单，应该加深网络", "迭代轮数不够，应该多训练几轮"],
              answer: "学习率过大，在谷底两侧来回越过，应调小学习率",
              option_notes: ["错：数据少会过拟合，但不会让损失上下跳动", "对：步长太大会越过最低点，在两侧来回震荡", "错：模型简单是欠拟合，损失会降得慢而不是来回跳", "错：震荡时多训练也降不下去，问题在步长"],
              explanation: "依据：07:10 老师讲学习率过大会在谷底两侧震荡。", ref_ms: 430000,
            },
            {
              type: "multi", set_id: "s2", style: "apply", set_at: now - 3_600_000,
              stem: "下面哪些做法能缓解上题的震荡？",
              options: ["把学习率调小", "使用学习率衰减", "增大批量大小", "把学习率调大"],
              answer: ["把学习率调小", "使用学习率衰减", "增大批量大小"],
              option_notes: ["对：直接缩小步长", "对：先大步后小步，后期稳定", "对：梯度估计更稳，抖动更小", "错：步长更大只会震荡得更厉害"],
              explanation: "依据：08:20 学习率与批量的讨论。", ref_ms: 500000,
            },
            {
              type: "correct", set_id: "s2", style: "apply", set_at: now - 3_600_000,
              stem: "学习率越大，梯度下降收敛得越快。",
              answer: "学习率过大反而会震荡甚至发散；学习率太小才是收敛慢。",
              key_points: ["指出「越大越快」是错的", "说出过大会震荡或发散"],
              explanation: "依据：07:10。", ref_ms: 430000,
            },
            {
              type: "short", set_id: "s2", style: "apply", set_at: now - 3_600_000,
              stem: "为什么特征尺度差别很大时，梯度下降会走「之」字形？",
              answer: "各方向曲率差别大，等高线呈细长椭圆，梯度方向偏向陡的一侧，来回折返。",
              key_points: ["等高线细长", "梯度方向不指向最低点"], ref_ms: 610000,
            },
          ])
        : null,
    cmd_get_quiz_course_rules: () => "多出需要计算的题；题干用中文",
    cmd_grade_quiz_answer: () => ({ verdict: "partial", feedback: "错处找对了：不是越大越快。但还要说出过大会怎样。", missed: ["学习率过大会震荡甚至发散"] }),
    cmd_get_mindmap: () => mindmap,
    cmd_stale_ai_artifacts: () => [],
    cmd_get_slides: () => [],
    cmd_get_screenshots: () => [],
    cmd_list_clips: () => [],
    cmd_video_skips: () => [],
    // 场景可在 __shot-settings 里放一组设置值（如本地识别选了哪个模型）。
    cmd_get_setting: ({ key }) => {
      try {
        return JSON.parse(localStorage.getItem("__shot-settings") || "{}")[key] ?? null;
      } catch {
        return null;
      }
    },
    cmd_has_secret: () => false,
    cmd_has_api_key: () => false,
    cmd_get_llm_profiles: () => [
      { id: "p1", name: "DeepSeek", kind: "openai", base_url: "https://api.deepseek.com", model: "deepseek-flash" },
    ],
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
    cmd_get_review_book: ({ courseId }) =>
      courseId === "c1"
        ? reviewBook
        : { title: null, generated_at: null, chapters: [], outline_stale: false, videos_with_notes: 2, videos_without_notes: [] },
    cmd_review_book_running: () => false,
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
    cmd_client_store_load: () => [],
    cmd_client_store_put: () => null,
    cmd_video_progress: () =>
      videos.filter((v) => progress[v.id]).map((v) => ({ video_id: v.id, position_ms: Math.round(v.duration_ms * progress[v.id]), duration_ms: v.duration_ms, course_id: v.course_id, updated_at: now - 86_400_000 - (v.id === "v3" ? 0 : 3_600_000) })),
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
  // 事件：listen 时记下回调，window.__emit 按事件名回放（助手流式回答等靠它）。
  const callbacks = new Map();
  const listeners = new Map();
  window.__emit = (event, payload) => {
    for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
    transformCallback: (callback) => {
      const id = ++callbackId;
      callbacks.set(id, callback);
      return id;
    },
    unregisterCallback: () => {},
    convertFileSrc: (path) => path,
    invoke: async (cmd, args) => {
      if (cmd === "plugin:mobile-files|system_bar_insets") return safeArea ?? { top: 0, right: 0, bottom: 0, left: 0 };
      if (cmd === "plugin:event|listen") {
        const list = listeners.get(args.event) ?? [];
        list.push(args.handler);
        listeners.set(args.event, list);
        return args.handler;
      }
      if (cmd === "plugin:dialog|open") return localStorage.getItem("__shot-folder");
      // 数据线导入：两个拷完的视频、一个还在拷；Android 带「导入」文件夹的路径。
      if (cmd === "plugin:mobile-files|list_cable_files") {
        const android = /Android/i.test(navigator.userAgent);
        const base = android ? "/storage/emulated/0/Android/media/dev.courseai.app/导入" : "/var/mobile/Documents";
        const MB = 1024 * 1024;
        return {
          files: [
            { name: "10 强化学习入门.mp4", path: `${base}/10 强化学习入门.mp4`, size: 412 * MB },
            { name: "11 生成模型.mp4", path: `${base}/11 生成模型.mp4`, size: 1.6 * 1024 * MB },
            { name: "12 期末复习.mp4", path: `${base}/12 期末复习.mp4`, size: 96 * MB, settling: true },
          ],
          scanned: 4,
          folder: android ? "Android/media/dev.courseai.app/导入" : null,
        };
      }
      if (cmd === "plugin:app|version") return "0.4.1";
      if (cmd.startsWith("plugin:")) return null;
      const handler = handlers[cmd];
      if (handler) return handler(args ?? {});
      unknown.add(cmd);
      window.__unknownCmds = [...unknown];
      // 列表类命令给空数组，其余给 null：前端多数据点都能优雅退化。
      return /list|due|logs|usage|concepts|weak|by_course|video_ids|daily|progress|totals/.test(cmd) ? [] : null;
    },
  };
}
