import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// 默认 waitFor/findBy* 轮询窗口只有 1s：单文件跑够用，全量多 worker 并行时
// jsdom 渲染变慢，焦点/渲染类断言会误报超时。放宽到 5s 只改等待窗口，
// 断言内容不变，真实死锁仍会被拦住。
configure({ asyncUtilTimeout: 5000 });
