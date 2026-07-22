import { describe, expect, it } from "vitest";
import { CLOZE_BLANK, buildCloze } from "./cloze";

describe("buildCloze", () => {
  it("blanks the selected term in its sentence and keeps it as the answer", () => {
    const { front, back } = buildCloze("光合作用发生在叶绿体中", "叶绿体");
    expect(front).toBe(`光合作用发生在${CLOZE_BLANK}中`);
    expect(back).toBe("叶绿体");
  });

  it("only blanks the first occurrence", () => {
    const { front } = buildCloze("重复 重复 结尾", "重复");
    expect(front).toBe(`${CLOZE_BLANK} 重复 结尾`);
  });
});
