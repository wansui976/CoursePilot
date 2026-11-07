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
    cmd_list_whisper_models: () => {
      const mobile = /iPhone|iPad|Android/.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
      const lowMem = localStorage.getItem("__shot-lowmem") === "1";
      const sherpa = [
        [{ id: "sensevoice", display_name: "SenseVoice（中文推荐 · 快）", size_bytes: 240_000_000, url: "", fits_memory: true }, true],
        [{ id: "qwen3-asr", display_name: "Qwen3-ASR 0.6B（中文高精度）", size_bytes: 988_000_000, url: "", fits_memory: !lowMem }, !lowMem],
      ];
      if (mobile) return sherpa;
      return [
        ...sherpa,
        [{ id: "large-v3-turbo", display_name: "Whisper large-v3-turbo", size_bytes: 1_620_000_000, url: "" }, false],
        [{ id: "small", display_name: "Whisper small", size_bytes: 488_000_000, url: "" }, false],
      ];
    },
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
        : "梯度下降每一步沿负梯度方向走一小步，学习率决定步子大小。[03:00]";
      setTimeout(() => {
        window.__emit(`assistant-stream:${requestId}`, { type: "started" });
        window.__emit(`assistant-stream:${requestId}`, {
          type: "done",
          reply: { answer, canceled: false, hit_turn_limit: false, actions: [], turns: 1, tools_used: ["search_content"], usage: null, history: [] },
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
    cmd_list_courses: () => {
      try {
        if (localStorage.getItem("__shot-empty") === "1") return [];
      } catch {
        // 存储不可用：按有课处理
      }
      return courses;
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
    cmd_list_videos: ({ courseId }) =>
      courseId === "c1"
        ? videos.map((video) => (withFolders() ? video : { ...video, folder_id: null }))
        : [],
    cmd_video_cover: ({ videoId }) => cover(videoId),
    cmd_media_url: ({ videoId }) => mediaUrl(videoId),
    cmd_list_processing_videos: () => [videos[6]],
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
    cmd_get_notes: () => notes,
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
    cmd_read_note_image: ({ id }) => noteImages.get(id) ?? Promise.reject(`not found: note image ${id}`),
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
