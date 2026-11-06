import type { QuizStyle } from "@/lib/types";

/** 出题风格，按在界面上排列的顺序。键与后端 `pipeline::quiz::QuizStyle::id` 一致。 */
export const QUIZ_STYLES: QuizStyle[] = ["recall", "apply", "correct", "contrast"];
