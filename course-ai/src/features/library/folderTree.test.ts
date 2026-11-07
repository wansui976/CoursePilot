import { describe, expect, it } from "vitest";
import type { Folder } from "@/lib/types";
import {
  childFolders,
  childVideos,
  containerOrder,
  crumbKey,
  folderKey,
  folderPath,
  nextFolderName,
  parseKey,
  subtreeFolderIds,
  videoCountIn,
  videoKey,
} from "./folderTree";

function folder(id: string, parent: string | null, order: number, name = id): Folder {
  return {
    id,
    course_id: "c",
    parent_id: parent,
    name,
    color: null,
    order_index: order,
    created_at: 1,
    updated_at: 1,
  };
}

// 模拟电路 / 第1章 / 1.1、第2章
const folders = [folder("ch2", null, 4), folder("ch1", null, 0), folder("s11", "ch1", 1)];
const videos = [
  { id: "v1", folder_id: "s11", order_index: 2 },
  { id: "v2", folder_id: "ch1", order_index: 3 },
  { id: "v3", folder_id: null, order_index: 5 },
  { id: "v4", order_index: 6 },
];

describe("folderTree", () => {
  it("lists one level, folders by order", () => {
    expect(childFolders(folders, null).map((f) => f.id)).toEqual(["ch1", "ch2"]);
    expect(childFolders(folders, "ch1").map((f) => f.id)).toEqual(["s11"]);
    expect(childVideos(videos, null).map((v) => v.id)).toEqual(["v3", "v4"]);
    expect(childVideos(videos, "ch1").map((v) => v.id)).toEqual(["v2"]);
  });

  it("builds the path from the root and survives a missing parent", () => {
    expect(folderPath(folders, "s11").map((f) => f.id)).toEqual(["ch1", "s11"]);
    expect(folderPath(folders, null)).toEqual([]);
    expect(folderPath(folders, "gone")).toEqual([]);
  });

  it("counts videos in a folder and everything under it", () => {
    expect([...subtreeFolderIds(folders, "ch1")].sort()).toEqual(["ch1", "s11"]);
    expect(videoCountIn(folders, videos, "ch1")).toBe(2);
    expect(videoCountIn(folders, videos, "ch2")).toBe(0);
  });

  it("picks a default name that does not clash on the same level", () => {
    expect(nextFolderName([], "新建文件夹")).toBe("新建文件夹");
    const taken = [folder("a", null, 0, "新建文件夹"), folder("b", null, 1, "新建文件夹 2")];
    expect(nextFolderName(taken, "新建文件夹")).toBe("新建文件夹 3");
  });

  it("round-trips drag keys and lays out a level folders-first", () => {
    expect(parseKey(folderKey("x"))).toEqual({ kind: "folder", id: "x" });
    expect(parseKey(videoKey("y"))).toEqual({ kind: "video", id: "y" });
    expect(parseKey(crumbKey(null))).toEqual({ kind: "crumb", folderId: null });
    expect(parseKey(crumbKey("ch1"))).toEqual({ kind: "crumb", folderId: "ch1" });
    expect(parseKey("zz")).toBeNull();
    expect(containerOrder(["f"], ["v"])).toEqual([
      { kind: "folder", id: "f" },
      { kind: "video", id: "v" },
    ]);
  });
});
