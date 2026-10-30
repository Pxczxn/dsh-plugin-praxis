// 证据格式分级、相似度与通用工具。纯函数，不依赖 DSH。
import { randomUUID } from 'node:crypto';

export const LIMITS = {
  goal: 2000,
  evidence: 3000,
  lesson: 1500,
  trigger: 700,
  reusableBecause: 1000,
  note: 1000,
  reason: 1000,
  plan: 1000,
  target: 300,
  projectKey: 200,
  tag: 40,
  query: 500,
  scope: 500,
  acceptance: 300,
  summary: 500,
  stdout: 400,
};

export class PraxisError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PraxisError';
    this.code = code;
    this.hint = options.hint ?? null;
    this.changed = options.changed === true;
  }
}

export function clip(value, max = LIMITS.note) {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/\r\n/g, '\n');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const FILE_PATTERN =
  /(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/)?[\w@.+-]+(?:[\\/][\w@.+-]+)*\.[A-Za-z0-9]{1,10}\b/gu;
const LINE_PATTERNS = [
  /\.(?:[A-Za-z0-9]{1,10}):(\d{1,7})\b/gu,
  /\bL(\d{1,7})\b/g,
  /\bline\s+(\d{1,7})\b/gi,
  /第\s*(\d{1,7})\s*行/g,
];
const COMMAND_PATTERN =
  /\b(?:npm|pnpm|yarn|npx|node|python3?|pip3?|pytest|go|cargo|rustc|javac|mvn|gradle|dotnet|deno|bun|make|cmake|docker|git|curl|wget|bash|sh|pwsh|powershell|eslint|prettier|tsc|vitest|jest|mocha|tap|ctest|gradlew|mvnw)\b/i;
const OUTPUT_PATTERN =
  /(^|\n)\s*(?:stdout|stderr|输出|结果|退出码|exit\s*code|exit\s*status|traceback|stack\s*trace)(?![\p{L}\p{N}])|(^|\n)\s*(?:>|```|\$ )/iu;
const QUOTE_PATTERN = /(?:^|\n)\s*>\s+\S|["“][^"”\n]{8,}["”]/u;
const RESULT_PATTERN =
  /\b(?:passed|failed|passing|failing|ok\s+\d+|tests?\s*:?\s*\d+|\d+\s*(?:passed|failed|passing|failing|pass|fail)|exit(?:ed)?\s+(?:code\s+)?\d+)\b|(?:通过|失败)\s*\d*\s*个?/i;

export function evidenceSignals(text) {
  const raw = String(text ?? '');
  const sandbox = raw.replace(/(?:https?|ftp):\/\/[^\s)]+/gi, ' ');
  const files = [...sandbox.matchAll(FILE_PATTERN)].map((m) => m[0]);
  let line = null;
  for (const pattern of LINE_PATTERNS) {
    pattern.lastIndex = 0;
    const m = pattern.exec(sandbox);
    if (m) {
      line = m[1];
      break;
    }
  }
  return {
    file: files.length > 0,
    line: line !== null,
    command: COMMAND_PATTERN.test(raw),
    output: OUTPUT_PATTERN.test(raw),
    quote: QUOTE_PATTERN.test(raw),
    result: RESULT_PATTERN.test(raw),
  };
}

/**
 * 只做格式分级：concrete 表示文本同时给出了具体定位/操作和可核对结果，
 * 不代表该命令真的被执行过。命令名、孤立行号、孤立 passed 都不算。
 */
export function evidenceStrength(text) {
  if (String(text ?? '').trim() === '') return 'none';
  const s = evidenceSignals(text);
  const concrete =
    (s.file && s.line) ||
    (s.command && (s.output || s.result)) ||
    (s.quote && s.result) ||
    (s.file && s.command);
  return concrete ? 'concrete' : 'weak';
}

export function evidenceGaps(text) {
  if (String(text ?? '').trim() === '') return ['证据为空'];
  const s = evidenceSignals(text);
  const gaps = [];
  if (!s.file && !s.command && !s.quote) gaps.push('缺少具体文件定位或实际执行的命令');
  if (!s.line && !s.output && !s.quote) gaps.push('缺少行号、输出摘录或引用');
  if (!s.result) gaps.push('缺少可核对的结果（tests passed/failed、exit code 等）');
  return gaps;
}

function bigrams(text) {
  const normalized = normalize(text).replace(/ /g, '');
  const grams = new Map();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    const gram = normalized.slice(i, i + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

export function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  let union = 0;
  for (const [gram, count] of a) {
    const other = b.get(gram) ?? 0;
    intersection += Math.min(count, other);
    union += Math.max(count, other);
  }
  for (const [gram, count] of b) {
    if (!a.has(gram)) union += count;
  }
  return union === 0 ? 1 : intersection / union;
}

export function relevance(query, text) {
  const tokens = [...new Set(normalize(query).split(' ').filter(Boolean))];
  if (tokens.length === 0) return 0;
  const haystack = normalize(text);
  const covered = tokens.filter((token) => haystack.includes(token)).length;
  const coverage = covered / tokens.length;
  const phrase = similarity(query, text);
  return Math.min(1, 0.7 * coverage + 0.3 * phrase);
}

export function id(prefix = '') {
  const uuid = randomUUID();
  return prefix ? `${prefix}-${uuid}` : uuid;
}

export function nowIso() {
  return new Date().toISOString();
}
