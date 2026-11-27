// 从 narration.json 生成两种画幅的 SRT 和配音稿。
//   node script/build-subs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { lines } = JSON.parse(fs.readFileSync(path.join(here, 'narration.json'), 'utf8'));

const ts = (s) => {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};
const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

// 竖屏一行最多 14 个字宽（英文算半个），在标点后面断开。
const width = (s) => [...s].reduce((w, c) => w + (/[\x00-\x7f]/.test(c) ? 0.5 : 1), 0);
function wrapPortrait(text, max = 14) {
  const out = [];
  for (const para of text.split('\n')) {
    let rest = para;
    while (width(rest) > max) {
      const chars = [...rest];
      let cut = -1;
      let w = 0;
      for (let i = 0; i < chars.length; i++) {
        w += /[\x00-\x7f]/.test(chars[i]) ? 0.5 : 1;
        if (w > max) break;
        if (/[，、；：？！。]/.test(chars[i]) && i > 3) cut = i + 1;
      }
      if (cut < 0) {
        w = 0;
        for (cut = 0; cut < chars.length && (w += /[\x00-\x7f]/.test(chars[cut]) ? 0.5 : 1) <= max; cut++);
      }
      out.push(chars.slice(0, cut).join('').trim());
      rest = chars.slice(cut).join('').trim();
    }
    if (rest) out.push(rest);
  }
  return out.join('\n');
}

const srt = (fmt) =>
  lines.map((l, i) => `${i + 1}\n${ts(l.start)} --> ${ts(l.end)}\n${fmt(l.sub)}\n`).join('\n');

fs.writeFileSync(path.join(here, 'subtitles-16x9.srt'), srt((s) => s));
fs.writeFileSync(path.join(here, 'subtitles-9x16.srt'), srt((s) => wrapPortrait(s)));

const md = [
  '# 配音稿',
  '',
  '每句单独生成一条音频，按「开始」放进时间线；音频长度不要超过「最长」，短一点没关系。',
  '「读法」一栏是给配音工具的文本（数字、英文已经写成要读的样子）。',
  '字幕文件：`subtitles-16x9.srt`（横屏）、`subtitles-9x16.srt`（竖屏，按一行 14 字断好了）。',
  '',
  '| # | 开始 | 最长 | 读法 |',
  '|---|---|---|---|',
  ...lines.map((l, i) => `| ${i + 1} | ${clock(l.start)} | ${(l.end - l.start).toFixed(1)} 秒 | ${l.tts} |`),
  '',
  `全片旁白 ${lines.length} 句，约 ${lines.reduce((n, l) => n + [...l.tts].length, 0)} 字。语速大约每秒 4.5 字，语气：克制、笃定，像老师在黑板前讲话；最后一句「不亦说乎」放慢、带一点笑意。`,
  '',
].join('\n');
fs.writeFileSync(path.join(here, 'voiceover.md'), md);
console.log('ok');
