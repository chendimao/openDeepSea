export type RestrictedSkillsCommand =
  | { kind: 'empty' }
  | { kind: 'local'; name: 'clear' | 'exit' | 'pwd' }
  | { kind: 'spawn'; file: string; args: string[] };

const ALLOWED_SKILLS_SUBCOMMANDS = new Set(['find', 'add', 'check', 'update']);
const BLOCKED_OPERATOR_PATTERN = /&&|\|\||>>|[;|<>`]/;
const ENV_PREFIX_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

export function parseRestrictedSkillsCommand(input: string): RestrictedSkillsCommand {
  const command = input.trim();
  if (!command) return { kind: 'empty' };
  if (BLOCKED_OPERATOR_PATTERN.test(command) || command.includes('$(')) {
    throw new Error('仅支持单条 skills 安装命令，不能使用管道、重定向或 shell 运算符');
  }

  const tokens = tokenize(command);
  if (tokens.length === 0) return { kind: 'empty' };
  const first = tokens[0]!;
  if (ENV_PREFIX_PATTERN.test(first)) {
    throw new Error('不支持在命令前注入环境变量');
  }
  if (first === 'clear' || first === 'exit' || first === 'pwd') {
    if (tokens.length > 1) throw new Error(`${first} 不接受额外参数`);
    return { kind: 'local', name: first };
  }
  if (first === 'npx') return parseNpxSkills(tokens);
  if (first === 'skills') return parseSkillsBinary(tokens);
  throw new Error('只允许运行 npx skills 或 skills 的 find/add/check/update 命令');
}

function parseNpxSkills(tokens: string[]): RestrictedSkillsCommand {
  const args = tokens.slice(1);
  const packageIndex = args[0] === '--yes' || args[0] === '-y' ? 1 : 0;
  if (args[packageIndex] !== 'skills') {
    throw new Error('npx 只能运行 skills 包');
  }
  const skillsArgs = args.slice(packageIndex + 1);
  validateSkillsArgs(skillsArgs);
  return { kind: 'spawn', file: 'npx', args };
}

function parseSkillsBinary(tokens: string[]): RestrictedSkillsCommand {
  const args = tokens.slice(1);
  validateSkillsArgs(args);
  return { kind: 'spawn', file: 'skills', args };
}

function validateSkillsArgs(args: string[]): void {
  const subcommand = args[0];
  if (!subcommand || !ALLOWED_SKILLS_SUBCOMMANDS.has(subcommand)) {
    throw new Error('只允许 skills find/add/check/update');
  }
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (escaped) current += '\\';
  if (quote) throw new Error('命令引号未闭合');
  if (current) tokens.push(current);
  return tokens;
}
