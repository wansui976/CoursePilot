/** 「/」快捷指令：提问类带 prompt（填进输入框），动作类带 action（直接执行）。 */
export interface SlashCommand {
  id: string;
  /** 输入「/」后跟着打的那个词，按它匹配。 */
  keyword: string;
  /** 英文、拼音首字母等别名，同样能匹配。 */
  aliases: string[];
  label: string;
  description: string;
  prompt?: string;
  action?: () => void;
}

/** 输入框里正在打的是不是一个快捷指令，是的话返回「/」后面那段。 */
export function slashQuery(input: string): string | null {
  const match = input.match(/^\/(\S*)$/);
  return match ? match[1] : null;
}

export function matchSlashCommands(commands: SlashCommand[], query: string): SlashCommand[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  return commands.filter(
    (command) =>
      command.keyword.startsWith(q) ||
      command.label.toLowerCase().includes(q) ||
      command.aliases.some((alias) => alias.startsWith(q)),
  );
}

type SlashCommandSpec = Omit<SlashCommand, "label" | "description">;

/**
 * 面板里实际可用的指令。提问类只在有视频时出现（问的都是「这个视频」），
 * 「复制对话」要等至少有一轮完整问答。
 */
export function buildSlashCommands(
  t: (key: string) => string,
  {
    hasVideo,
    hasFinishedTurns,
    onNewConversation,
    onCopyConversation,
  }: {
    hasVideo: boolean;
    hasFinishedTurns: boolean;
    onNewConversation: () => void;
    onCopyConversation: () => void;
  },
): SlashCommand[] {
  const specs: SlashCommandSpec[] = [
    ...(hasVideo
      ? [
          { id: "summary", keyword: "总结", aliases: ["summary", "zj"], prompt: t("assistant.slash.summaryPrompt") },
          { id: "keypoints", keyword: "重点", aliases: ["key", "zd"], prompt: t("assistant.slash.keypointsPrompt") },
          { id: "quiz", keyword: "出题", aliases: ["quiz", "ct"], prompt: t("assistant.slash.quizPrompt") },
          { id: "explain", keyword: "解释", aliases: ["explain", "js"], prompt: t("assistant.slash.explainPrompt") },
          { id: "source", keyword: "出处", aliases: ["source", "cc"], prompt: t("assistant.slash.sourcePrompt") },
          { id: "note", keyword: "笔记", aliases: ["note", "bj"], prompt: t("assistant.slash.notePrompt") },
        ]
      : []),
    { id: "progress", keyword: "进度", aliases: ["progress", "jd"], prompt: t("assistant.slash.progressPrompt") },
    { id: "new", keyword: "新对话", aliases: ["new", "xdh"], action: onNewConversation },
    ...(hasFinishedTurns
      ? [{ id: "copy", keyword: "复制对话", aliases: ["copy", "fz"], action: onCopyConversation }]
      : []),
  ];
  return specs.map((command) => ({
    ...command,
    label: t(`assistant.slash.${command.id}`),
    description: t(`assistant.slash.${command.id}Hint`),
  }));
}
