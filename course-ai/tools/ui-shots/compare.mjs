/**
 * 与基准截图逐像素比对：每张图算出变化像素占比，超过阈值的列出来并写一张差异图
 * （变化处标红，其余淡化）。基准图由 `pnpm shots --update-baseline` 生成，放在
 * ui-shots-baseline/（已忽略，不进仓库——几十张大 PNG 不该进 git，本地对比用）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

/** 把这次拍到的图存为基准（只覆盖本次拍到的，其余基准保留）。 */
export function updateBaseline(names, outDir, baselineDir) {
  mkdirSync(baselineDir, { recursive: true });
  for (const name of names) copyFileSync(join(outDir, name), join(baselineDir, name));
  return names.length;
}

/**
 * 逐张对比。返回 { changed: [{name, ratio}], missing: [name], compared }。
 * 尺寸不同直接算作 100% 变化。差异图写到 outDir/diff/。
 */
export function compareWithBaseline(names, outDir, baselineDir, threshold) {
  const diffDir = join(outDir, "diff");
  // 每次比对重新生成差异图，免得上一轮的旧图混进来。
  rmSync(diffDir, { recursive: true, force: true });
  const changed = [];
  const missing = [];
  let compared = 0;
  for (const name of names) {
    const basePath = join(baselineDir, name);
    if (!existsSync(basePath)) {
      missing.push(name);
      continue;
    }
    compared++;
    const actual = PNG.sync.read(readFileSync(join(outDir, name)));
    const expected = PNG.sync.read(readFileSync(basePath));
    if (actual.width !== expected.width || actual.height !== expected.height) {
      changed.push({ name, ratio: 1 });
      continue;
    }
    const diff = new PNG({ width: actual.width, height: actual.height });
    // threshold 是单像素的颜色容差（抗锯齿、字体渲染的细微差别不算变化）。
    const pixels = pixelmatch(expected.data, actual.data, diff.data, actual.width, actual.height, {
      threshold: 0.1,
      alpha: 0.25,
    });
    const ratio = pixels / (actual.width * actual.height);
    if (ratio > threshold) {
      changed.push({ name, ratio });
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(join(diffDir, name), PNG.sync.write(diff));
    }
  }
  return { changed, missing, compared };
}

export function listPngs(dir) {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".png")) : [];
}
