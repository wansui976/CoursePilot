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
