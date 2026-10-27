# 阿里云语音识别（DashScope）可用性测试

- **测试日期**：2026-10-26（America/New_York）
- **接口地域**：华北 2（北京），`https://dashscope.aliyuncs.com/api/v1`
- **被测代码**：`course-ai/src-tauri/src/pipeline/aliyun_asr.rs`、`pipeline/mod.rs`、`pipeline/audio.rs`
- **测试环境**：macOS（Apple Silicon）、Rust 1.96、Python 3.15、ffmpeg 8.0；从美国东部网络访问阿里云
- **凭证**：测试用百炼 API Key 通过本地临时环境变量传入，未写入仓库、日志或本文档；测试后已删除临时文件

## 结论

**这条后端可用，但有一个硬上限，长课会撞上。** 用有效百炼 API Key，`qwen3-asr-flash-filetrans`、`fun-asr`、`paraformer-v2` 三个模型都能接收应用发送的 base64 `data:` URI，MP3 与 M4A（AAC）都被接受，返回的 JSON 能正确映射成应用的逐句文稿。

测试发现了一个会直接影响长课的问题，并已修复：

- **服务端对单个 JSON 字符串的上限是 28,000,000 字符**。应用把整段音频编码成一个 data URI 字符串，超过就返回 HTTP 400；而且是在传了约 28 MB 之后才拒。65 分钟、48 kbps 的 MP3（base64 后 31.2M 字符）实测被拒，上传白花了 551.8 秒。
- 修复分两步：桌面端阿里云 MP3 从 **48 kbps 降到 32 kbps**（同样一段语音在 48k / 32k / 24k 下转写结果完全一致），把约 58 分钟的上限推到约 **87 分钟**；同时在提交前检查原始文件大小，超限直接报错，不再白传。改完后 65 分钟、20.8M 字符的 data URI 实测提交成功（HTTP 200）。
- 2 小时以上的课仍会超限，需要切分或改用本地 Whisper；本次没有实现阿里云侧的分片识别。

另外修复了两个会让「设置看起来生效、实际没生效」的问题：

1. **qwen3 的语言参数名写错**。官方文档里 `qwen3-asr-flash-filetrans` 用单数 `parameters.language`，代码此前把它整个过滤掉，设置里选的语言对默认模型完全无效。现在按模型分别发送 `language` / `language_hints`。
2. **qwen3 没有开启字级时间戳**。`enable_words` 默认 `false`，只返回句级时间戳，长句也不会按标点切开。现在对 qwen3 固定开启，实测一句话从 12.9 秒整段变成按标点切开的 2 段、20 + 42 个字级 token。

同时把纯静音/纯音乐返回的 `SUCCESS_WITH_NO_VALID_FRAGMENT` 映射成了能看懂的中文提示，不再只给用户一串英文错误码。

## 测试矩阵

| # | 项目 | 方法 | 结果 |
| --- | --- | --- | --- |
| 1 | 域名 / TLS / 接口可达 | 用无效 Key POST 提交接口 | ✅ HTTP 401，TLS 握手约 2.4 s，接口存在 |
| 2 | 无效 Key 的鉴权错误 | `Authorization: Bearer sk-invalid-test` | ✅ 401 `InvalidApiKey` / `Invalid API-key provided.` |
| 3 | qwen3 + MP3 data URI | 13 秒中文合成语音，48 kbps / 16 kHz / 单声道 | ✅ SUCCEEDED，转写文本与原文一致 |
| 4 | qwen3 + M4A data URI | 同一段语音转 AAC / M4A，MIME `audio/mp4` | ✅ SUCCEEDED，`audio_info.format=aac` |
| 5 | fun-asr + MP3 / M4A data URI | 同上，`file_urls` 数组 + `language_hints: ["zh"]` | ✅ SUCCEEDED，返回句级 + 字级时间戳，数字自动 ITN |
| 6 | paraformer-v2 + MP3 / M4A data URI | 同上 | ✅ SUCCEEDED，返回句级 + 字级时间戳 |
| 7 | qwen3 同步接口（对照） | OpenAI 兼容 `/compatible-mode/v1/chat/completions`，base64 data URI | ✅ HTTP 200，文本正确，`usage.seconds=12` |
| 8 | 公网 URL 模式 | 阿里云公开样例 WAV 作为 `file_url` | ✅ SUCCEEDED，说明 URL 与 data URI 两条路都通 |
| 9 | qwen3 语言参数 | `parameters.language=zh` + `enable_words=true` | ✅ 返回 2 句、20 + 42 个字级 token，按标点断句 |
| 10 | 不存在的模型 | `model=no-such-asr-model` | ✅ HTTP 400 `InvalidParameter` / `Model not exist.` |
| 11 | 纯静音音频 | 3 分钟静音 MP3，data URI | ✅ 任务 FAILED，`SUCCESS_WITH_NO_VALID_FRAGMENT`（已映射为中文提示） |
| 12 | 65 分钟音频的体积（旧 48k） | 桌面端 48 kbps MP3 | 原始 22.3 MB；base64 后 31,201,116 字符，**超限 3.2M** |
| 13 | 30 MB 级 data URI 上传 | 65 分钟静音 MP3 的 data URI | ❌ HTTP 400：`String value length (28049408) exceeds the maximum allowed (28000000)`；服务端在收到约 28.05 MB 后中止，耗时 551.8 s，约 50.8 KB/s |
| 13b | 65 分钟音频改用 32k | 桌面端 32 kbps MP3 | ✅ 原始 15.6 MB；base64 后 20,800,812 字符，提交 HTTP 200（748.1 s）；任务因静音返回 `SUCCESS_WITH_NO_VALID_FRAGMENT`，说明体积上限已解决 |
| 14 | 应用单元测试 | `cargo test --lib aliyun` | ✅ 29 passed，1 ignored（真网测试） |
| 14b | 真网代码路径测试 | `cargo test --lib live_aliyun -- --ignored`（走生产 `run_aliyun`） | ✅ PASS，文稿正确，`enable_words` 返回字级 token |
| 15 | 前端 ASR 相关测试 | `pnpm vitest run src/lib/asrDefaults.test.ts src/features/settings/SettingsPanel.test.tsx src/lib/androidNativePlugin.test.ts` | ✅ 39 passed |
| 15b | 全量 Rust pipeline 测试 | `cargo test --lib pipeline::` | ✅ 417 passed |
| 16 | 移动端音频导出 | 代码检查 + API 接受 M4A | ✅ iOS / Android 原生桥都导出 `audio.m4a`（`audio/mp4`）；未上真机 |

> 全量前端测试（`pnpm test`）当天另有 1 个失败：`src/globals.test.ts` 报新增的 `tour.css` 里出现了裸 `color: var(--accent)`。这是工作区里未提交的界面改动，和 ASR 无关；ASR 相关的 39 个测试全部通过。

## 延迟记录

以下为从测试网络观测到的耗时，受跨境网络影响，不代表国内用户体验：

| 操作 | 耗时 |
| --- | --- |
| TLS 握手 | 约 2.4 s |
| 提交任务（13 秒音频，约 104 KB 请求体） | 3.6–5.2 s |
| 任务从 PENDING 到 SUCCEEDED | 约 1–3 s |
| 下载并解析结果 JSON | 2.1–4.1 s |
| 提交任务（125 KB 公开样例，data URI） | 3.6–6.8 s |
| 提交 30 MB 级 data URI（被服务端拒绝的那次） | 551.8 s，约 50.8 KB/s |
| 提交 15.6 MB / 20.8M 字符 data URI（32k 65 分钟） | 748.1 s，约 21 KB/s |

## 关键发现

### 28,000,000 字符硬上限（最重要）

服务端的 JSON 解析器有 `StreamReadConstraints.getMaxStringLength()`，上限 **28,000,000 字符**。data URI 是 JSON 里的一个字符串，所以能内联提交的音频体积有硬顶：

```text
base64 字符数 ≈ 原始字节数 × 4/3
28,000,000 字符 ≈ 21,000,000 字节原始音频
48 kbps → 约 58 分钟
32 kbps → 约 87 分钟
24 kbps → 约 116 分钟
```

65 分钟、48 kbps 的 MP3 是 22.3 MB，base64 后 31.2M 字符，越线 3.2M。服务端不会等整段传完：解析到第 28,049,408 个字符就中止并返回：

```json
{"code":"InvalidParameter",
 "message":"String value length (28049408) exceeds the maximum allowed (28000000, from `StreamReadConstraints.getMaxStringLength()`)"}
```

修复后桌面端改发 32 kbps：65 分钟降到 15.6 MB、20.8M 字符；提交前用 `ensure_fits_data_uri` 检查原始字节数，超限直接报「音频太大…请切分或改用本地 Whisper」，不再浪费上传。

### data URI 是被接受的（文档没写）

官方文档只写了 `file_url`「必须公网可访问」，没有承诺支持 base64 data URI。应用把本地音频编码成 `data:audio/mpeg;base64,...` 直接放进 `file_url`，这属于文档外的用法。实测三个模型都接受，并且服务端会把 data URI 落到它自己的 OSS 再转写（结果 JSON 里的 `file_url` 会变成 `ds-restful-api-bj-prod.oss-cn-beijing.aliyuncs.com/restful/data-uri/...`）。

因此当前实现**不需要**先接 OSS，减少了用户配置；代价是整段音频要随请求上传，长课在慢网络下会很慢。

### 模型参数名不一样，写错会被静默忽略

| 模型 | 文件字段 | 语言参数 | 字级时间戳 |
| --- | --- | --- | --- |
| `qwen3-asr-flash-filetrans` | `input.file_url`（单数） | `parameters.language`（单值） | `parameters.enable_words`，默认 false |
| `fun-asr` | `input.file_urls`（数组） | `parameters.language_hints`（数组） | 默认返回 |
| `paraformer-v2` | `input.file_urls`（数组） | `parameters.language_hints`（数组） | 默认返回 |

发错参数名不会报错，只会被当成未知参数忽略——这正是修复前 qwen3 语言设置失效的原因。

### 32 kbps 不影响这段语音的识别结果

同一段 13 秒语音分别转成 48k / 32k / 24k，三个码率下 qwen3 返回的文本逐字一致，都是 2 句、62 个字级 token。32k 是「质量」与「87 分钟上限」之间的折中；更嘈杂的真实课堂音频没有条件做 A/B，仍建议保留更高的码率作为可选设置（本次未做成设置项）。

### 纯静音不是「成功」，但也不是配置错误

静音音频的任务最终状态是 `FAILED`，`code=SUCCESS_WITH_NO_VALID_FRAGMENT`。HTTP 仍是 200，所以不能用 HTTP 状态判断。应用现在会提示「没有从这段音频里检测到语音」，并建议改用自带字幕或本地 Whisper。

### 整段上传的耗时

从测试网络到阿里云的上传速度只有约 21–51 KB/s：1.44 MB 请求体约 30 秒，15.6 MB 要 12 分钟，30 MB 请求要 9 分钟以上（不同时段波动很大）。应用使用 `reqwest` 默认无超时，因此不会立刻失败，但用户会长时间停在「云端识别中」。国内网络通常快得多；如果用户反馈很慢，优先建议切短课程或换本地 Whisper。

## 复现方式

仓库里提供了可重复执行的自检脚本，不需要第三方 Python 包：

```bash
# 默认下载阿里云公开样例，测试三个模型（data URI 模式）
DASHSCOPE_API_KEY=sk-... python3 course-ai/tools/aliyun-asr/check_aliyun_asr.py

# 测自己的音频 / 指定模型 / 测公网 URL 模式
DASHSCOPE_API_KEY=sk-... python3 course-ai/tools/aliyun-asr/check_aliyun_asr.py --audio lesson.mp3 --mime audio/mpeg
DASHSCOPE_API_KEY=sk-... python3 course-ai/tools/aliyun-asr/check_aliyun_asr.py --model fun-asr
DASHSCOPE_API_KEY=sk-... python3 course-ai/tools/aliyun-asr/check_aliyun_asr.py --url-mode
```

脚本只打印 Key 的前 3 位和长度，不会输出完整 Key。退出码 0 表示所有被测模型都返回了非空文稿。

代码级测试（真网那条默认不跑）：

```bash
cd course-ai/src-tauri && cargo test --lib aliyun
DASHSCOPE_API_KEY=... ALIYUN_ASR_AUDIO=/path/to/audio.mp3 \
  cargo test --lib live_aliyun -- --ignored --nocapture
cd course-ai && pnpm vitest run src/lib/asrDefaults.test.ts \
  src/features/settings/SettingsPanel.test.tsx \
  src/lib/androidNativePlugin.test.ts
```

## 本次代码改动

- `aliyun_asr.rs`：qwen3 发送 `parameters.language` 与 `enable_words: true`；fun-asr / paraformer 继续发送 `language_hints` 数组。
- `aliyun_asr.rs`：`SUCCESS_WITH_NO_VALID_FRAGMENT` 转为可读错误；429 增加「请求过于频繁」提示。
- `aliyun_asr.rs`：新增 `MAX_DATA_URI_CHARS` / `ensure_fits_data_uri`，上传前拦截超限音频。
- `audio.rs`：桌面端阿里云 MP3 从 48 kbps 降到 32 kbps，把安全时长从约 58 分钟推到约 87 分钟。
- `aliyun_asr.rs`：新增请求体、错误映射、体积边界单元测试，以及一个默认 ignored 的真网生产路径测试。
- `README.md` / `README_en.md`：补充百炼 API Key 申请、模型选择、28M 字符上限、常见报错和凭证区别。
- `course-ai/tools/aliyun-asr/check_aliyun_asr.py`：可重复执行的端到端自检脚本。

## 未覆盖 / 后续建议

- **没有实现阿里云分片识别**：超过约 87 分钟的课会在本地被拦下。要真正支持 2 小时以上的课，应该像火山引擎那条后端一样按段切分、并行识别、按偏移合并（`volcengine_auc::run_volcengine_file_chunked` 已有现成实现可参考）。
- **真机 iOS / Android 未跑**：API 层已确认接受 M4A；原生桥代码也确认导出 `audio.m4a`。但 Android 的 `exportM4a` 是直接复制源音轨，码率取决于视频本身，1 小时高码率 AAC 仍可能超过 28M 字符；iOS 也没有显式设 `AVEncoderBitRateKey`。建议在两端各导入一个 10 分钟和一个 90 分钟视频，确认体积和内存。
- **新加坡地域未测**：应用固定使用北京域名与北京 Key；如果用户拿的是新加坡 Key，会得到 401。README 已提示 Key 分地域。
- **未做并发/限流压测**：查询接口官方默认 20 QPS、最高 100 QPS；应用 3 秒轮询一次（约 0.33 QPS），单任务远低于限制。
- **32k 只在这段干净的合成语音上对比过**：真实课堂有噪声、口音、麦克风差异，32k 与 48k 的识别差异没有做大样本评测。
- **视频自带字幕优先**：有字幕的视频不会走 ASR，这是预期行为，不在本次测试范围内。

## 参考

- [非实时语音识别用户指南](https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide)
- [Qwen-ASR API 参考](https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference)
- [Paraformer 录音文件识别 RESTful API](https://help.aliyun.com/zh/model-studio/paraformer-recorded-speech-recognition-restful-api)
- [Fun-ASR 非实时语音识别 HTTP API](https://help.aliyun.com/zh/model-studio/fun-asr-recorded-speech-recognition-http-api)
- [获取与配置 API Key](https://help.aliyun.com/zh/model-studio/get-api-key)
