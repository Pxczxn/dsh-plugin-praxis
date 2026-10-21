// Tool classification, sanitized call/result summaries, and write-impact grading.
// CONTRACT §4. Everything here is pure and synchronous: the observer decides
// whether a call is trusted, this module only describes it.
//
// Bounds are deliberate. `callSummary` / `resultSummary` are persisted in
// state.json and shown back to the model, so secrets are redacted before any
// clipping and stdout is never stored whole.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIMITS, clip } from './evidence.js';

// The exact set from CONTRACT §4. Kept literal so the contract test and the
// runtime agree; host-specific aliases live in HOST_WRITE_ALIASES below.
export const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit', 'apply_patch', 'str_replace_editor']);

// DSH 0.2.1 ships `ops_replace` (and a few file writers under other MCP-style
// names) as unambiguous writes. They are graded `confirmed` like write/edit:
// mis-grading them as `possible` would silently disable revision invalidation
// on the real host. Reported to the Lead for folding into WRITE_TOOLS.
const HOST_WRITE_ALIASES = new Set([
  'ops_replace',
  'ops_write',
  'ops_edit',
  'ops_patch',
  'write_file',
  'create_file',
  'apply_diff',
  'str_replace',
]);

// The plugin's own tools write only praxis state; they never touch the
// implementation, so they must not create pending "possible" changes that
// would block close(done) forever.
const LEDGER_TOOL_NAMES = new Set(['praxis_task', 'praxis_lesson']);

// Planning tools (todo lists, plan documents held in memory) never touch the
// implementation either. Treating them as "possible writes" filled
// pendingChangeIds with noise and pushed close(done) out of reach.
const PLANNING_TOOL_NAMES = new Set([
  'todo_write',
  'todo_read',
  'todo',
  'todos',
  'update_plan',
  'plan',
  'think',
]);

// Context-management and presentation tools act on the conversation, not on
// the project. They cannot change the implementation, so a completion gate
// must never wait on them.
const META_TOOL_NAMES = new Set([
  'compress',
  'decompress',
  'search_context',
  'acp_status',
  'acp_cache',
  'ask_user_question',
  'present',
]);

const READ_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'read_text_file',
  'cat',
  'ls',
  'dir',
  'list',
  'list_dir',
  'list_files',
  'grep',
  'rg',
  'glob',
  'find',
  'search',
  'inspect',
  'view',
  'show',
  'status',
  'diff',
  'log',
  'head',
  'tail',
  'stat',
  'file',
  'tree',
  'pwd',
  'env',
  'which',
  'wc',
  'ops_inspect_local_file',
  'ops_grep',
  'ops_glob',
  'ops_read',
  'ops_list',
]);

const SHELL_TOOL_NAMES = new Set([
  'bash',
  'sh',
  'zsh',
  'fish',
  'shell',
  'exec',
  'run',
  'command',
  'cmd',
  'powershell',
  'pwsh',
  'terminal',
  'term',
  'ops_bash',
  'bash_exec',
  'shell_exec',
  'run_command',
]);

// Read-only verbs used to recognize compound names such as `read_text_file`,
// `get_file` or `list_dir`. Compound *write* names are intentionally not
// guessed: an unknown tool must stay `possible`, never downgraded.
const READ_VERBS = new Set([
  'read',
  'get',
  'list',
  'ls',
  'cat',
  'grep',
  'rg',
  'glob',
  'search',
  'find',
  'view',
  'inspect',
  'show',
  'status',
  'diff',
  'log',
  'head',
  'tail',
  'stat',
  'tree',
  'peek',
  'scan',
  'which',
  'pwd',
  'wc',
]);
const WRITE_VERBS = new Set([
  'write',
  'edit',
  'patch',
  'replace',
  'create',
  'delete',
  'remove',
  'move',
  'rename',
  'copy',
  'mkdir',
  'touch',
  'append',
  'truncate',
  'apply',
  'insert',
]);

const CONTENT_KEYS = new Set([
  'content',
  'contents',
  'new_string',
  'old_string',
  'new_str',
  'old_str',
  'newText',
  'oldText',
  'new_text',
  'old_text',
  'text',
  'body',
  'diff',
  'patch',
  'edits',
  'replacement',
  'new_source',
  'file_text',
]);

const COMMAND_KEYS = ['command', 'cmd', 'script', 'shell_command', 'line'];
const TARGET_KEYS = ['file_path', 'filePath', 'path', 'paths', 'files', 'directory', 'cwd', 'destination', 'target', 'source'];
const QUERY_KEYS = ['query', 'pattern', 'glob', 'url', 'expression'];

// Keys whose values are credentials. Ordered longest-first so `authorization`
// is used before the `auth` prefix in the alternation.
const SECRET_KEYS =
  'authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|private[_-]?key|session[_-]?id|set-cookie|credentials?|password|passwd|bearer|secret|token|auth|cookie';
const SECRET_PAIR = new RegExp(
  `(["']?\\b(?:${SECRET_KEYS})\\b["']?\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;}]+)`,
  'gi',
);
const SECRET_FLAG = new RegExp(`(--?(?:${SECRET_KEYS})[A-Za-z-]*)(=|\\s+)("[^"]*"|'[^']*'|[^\\s"']+)`, 'gi');
const BEARER_PAIR = /\b(bearer)\s+([A-Za-z0-9._~+/=-]{4,})/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/gi;

/** Strip namespace prefixes so `mcp__fs__write` and `ops_bash` classify. */
function baseName(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) return '';
  let base = raw;
  if (base.includes('__')) base = base.split('__').pop() ?? base;
  base = base.split(/[.:/\\]/).pop() ?? base;
  return base.trim();
}

function textOf(value) {
  return typeof value === 'string' ? value : '';
}

function asObject(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
      } catch {
        // not JSON; treat it as a raw command below
      }
    }
  }
  return null;
}

function shellCommand(args) {
  const object = asObject(args);
  if (object) {
    for (const key of [...COMMAND_KEYS, 'arguments', 'args']) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string')) {
        return value.join(' ');
      }
    }
    return '';
  }
  return typeof args === 'string' ? args : '';
}

function isWriteTool(base) {
  return WRITE_TOOLS.has(base) || HOST_WRITE_ALIASES.has(base);
}

function isReadTool(base) {
  if (READ_TOOL_NAMES.has(base)) return true;
  const tokens = base.split('_').filter(Boolean);
  if (tokens.length < 2) return false;
  return READ_VERBS.has(tokens[0]) && !tokens.some((token) => WRITE_VERBS.has(token));
}

function isShellTool(base) {
  return SHELL_TOOL_NAMES.has(base);
}

/** Drop quoted text so `echo "npm test"` cannot look like a test command. */
function stripQuoted(command) {
  return String(command ?? '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, ' ');
}

function splitSimpleCommands(command) {
  return String(command ?? '')
    .split(/&&|\|\||[;|\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeSegment(segment) {
  let text = segment.trim();
  // Leading environment assignments: FOO=bar cmd
  for (;;) {
    const next = text.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s"']+)\s+/, '');
    if (next === text) break;
    text = next;
  }
  // Harmless wrappers: sudo -E env VAR=1 timeout 30 cmd
  text = text.replace(/^(?:sudo|env|time|command|nohup|builtin|nice|timeout)\b(?:\s+-\S+|\s+\d+)*\s+/i, '');
  return text.trim();
}

function headToken(segment) {
  const match = /^["']?([^\s"']+)["']?/.exec(segment);
  if (!match) return '';
  const token = match[1].split(/[\\/]/).pop() ?? match[1];
  return token.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

/**
 * `>`/`>>` without a later `=` is a write redirection, except when the target
 * is the null device: `2>/dev/null` and `>/dev/null` do not touch the project.
 */
// Scratch paths outside the project: writing a fixture into the OS temp
// directory is part of building a check, not a change to the implementation.
// Anything relative (out.txt) or inside the repo still counts as a write.
const TEMP_TARGET =
  /^(?:[/\\]tmp[/\\]|[/\\]var[/\\]tmp[/\\]|[/\\]dev[/\\]shm[/\\]|\$TMPDIR|\$\{TMPDIR\}|%TEMP%|[a-z]:[\\/](?:.*[\\/])?temp[\\/])/i;

function hasWriteRedirect(segment) {
  const pattern = /(?:\d?>>?)(?!=)\s*([^\s;|&<>]*)?/g;
  let match;
  while ((match = pattern.exec(segment)) !== null) {
    const target = (match[1] ?? '').replace(/^["']|["']$/g, '');
    if (!target) continue;
    if (target.toLowerCase() === 'nul') continue;
    if (/^\/dev\/null$/i.test(target)) continue;
    if (TEMP_TARGET.test(target)) continue;
    return true;
  }
  return false;
}

const TEST_PATTERNS = [
  /^node\s+--test\b/,
  /^node\s+--experimental-test\b/,
  /^node\s+-r\s+.*\s+--test\b/,
  /^npm\s+(?:run\s+)?test(?::|\s|$)/,
  /^npm\s+t(?:\s|$)/,
  /^npx\s+(?:--no-install\s+)?(?:vitest|jest|mocha|tap|ava|playwright\s+test)\b/,
  /^pnpm\s+(?:run\s+)?test(?::|\s|$)/,
  /^pnpm\s+t(?:\s|$)/,
  /^yarn\s+(?:run\s+)?test(?::|\s|$)/,
  /^yarn\s+t(?:\s|$)/,
  /^pytest\b/,
  /^python3?\s+-m\s+pytest\b/,
  /^python3?\s+-m\s+unittest\b/,
  /^(?:vitest|jest|mocha|tap|ava|phpunit|rspec|bats|ctest|nox|tox)\b/,
  /^go\s+test\b/,
  /^cargo\s+test\b/,
  /^dotnet\s+test\b/,
  /^(?:mvn|mvnw)\s+(?:.*\s)?(?:test|verify)\b/,
  /^(?:gradle|gradlew)\s+(?:.*\s)?test\b/,
  /^npm\s+run\s+test(?::|\s|$)/,
];

const LINT_PATTERNS = [
  // node --check 只解析语法、不执行代码，作用等同 lint；不认它会让 `npm run check`
  // 展开脚本后整条落到 unknown，把纯检查误记成待复核写入。
  /^node\s+--check\b/,
  /^(?:npx\s+)?eslint\b/,
  /^(?:tslint|stylelint|jshint|biome)\b/,
  /^prettier\s+(?:--check|-c|--list-different)\b/,
  /^(?:ruff|flake8|pylint|pydocstyle|mypy|pyright|isort|black)\b/,
  /^(?:golangci-lint|staticcheck)\b/,
  /^go\s+vet\b/,
  /^cargo\s+(?:clippy|fmt\s+--check)\b/,
  /^(?:npx\s+)?(?:tsc|vue-tsc)\b/,
  /^(?:npm|pnpm|yarn)\s+run\s+(?:lint|typecheck|check|format:check|types)(?::|\s|$)/,
  /^dotnet\s+format\b/,
];

const WRITE_FLAG_PATTERNS = [/\s--fix\b/, /\s--write\b/, /\s-w\b/];

const BUILD_PATTERNS = [
  /^(?:npm|pnpm|yarn)\s+run\s+build(?::|\s|$)/,
  /^(?:npm|pnpm|yarn)\s+build\b/,
  /^(?:make|cmake|ninja|msbuild)\b/,
  /^(?:cargo\s+build|go\s+build|rustc|javac)\b/,
  /^dotnet\s+(?:build|publish|pack)\b/,
  /^(?:mvn|mvnw)\s+(?:.*\s)?(?:compile|package|install|deploy)\b/,
  /^(?:gradle|gradlew)\s+(?:.*\s)?(?:build|assemble|jar|installDist)\b/,
  /^python3?\s+-m\s+build\b/,
  /^python3?\s+setup\.py\s+(?:build|install|sdist|bdist)\b/,
  /^(?:webpack|rollup|esbuild|parcel)\b/,
  /^vite\s+build\b/,
  /^(?:next|nuxt|ng)\s+build\b/,
  /^docker\s+(?:build|compose\s+build)\b/,
];

const PURE_READ_COMMANDS = new Set([
  'ls',
  'll',
  'la',
  'dir',
  'pwd',
  'cat',
  'bat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'file',
  'stat',
  'which',
  'whereis',
  'whoami',
  'who',
  'date',
  'cal',
  'env',
  'printenv',
  'echo',
  'printf',
  'true',
  'false',
  'type',
  'tree',
  'du',
  'df',
  'uname',
  'hostname',
  'id',
  'groups',
  'ps',
  'top',
  'free',
  'uptime',
  'sleep',
  'exit',
  'cd',
  'clear',
  'history',
  'man',
  'help',
  'export',
  'set',
  'unset',
  'alias',
  'jq',
  'yq',
  'cut',
  'sort',
  'uniq',
  'tr',
  'diff',
  'cmp',
  'comm',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'awk',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  // 校验和与编码转换只读取输入、把结果写到 stdout；写文件仍由重定向检测拦下。
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'md5sum',
  'shasum',
  'b2sum',
  'cksum',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'base64',
  'nl',
  'fold',
  'paste',
  'column',
  'expand',
  'unexpand',
  'rev',
  'tac',
  'seq',
  // PowerShell 的纯读过滤器：只从管道读、把结果写到 stdout。不收录
  // for-each-object / where-object（会执行任意脚本块）和 tee-object（写文件），
  // 那类命令保持保守判定，不用放宽去换误报。
  'select-string',
  'measure-object',
  'sort-object',
  'select-object',
  'out-string',
  'out-null',
  'group-object',
  'convertto-json',
  'convertfrom-json',
  'format-table',
  'format-list',
]);

const WRITE_COMMANDS = new Set([
  'mkdir',
  'touch',
  'cp',
  'mv',
  'rm',
  'rmdir',
  'ln',
  'chmod',
  'chown',
  'chgrp',
  'tee',
  'truncate',
  'dd',
  'install',
  'patch',
  'rsync',
  'scp',
  'shred',
  'mktemp',
  'gofmt',
]);

function isTestCommand(segment) {
  return TEST_PATTERNS.some((pattern) => pattern.test(segment));
}

function isLintCommand(segment) {
  return LINT_PATTERNS.some((pattern) => pattern.test(segment));
}

function isBuildCommand(segment) {
  return BUILD_PATTERNS.some((pattern) => pattern.test(segment));
}

function isReadOnlyCommand(segment, head) {
  if (PURE_READ_COMMANDS.has(head)) return true;

  if (head === 'git') {
    if (/^git\s*$/.test(segment)) return true;
    if (/^git\s+branch\s+(?:-d|-D|-m|-M|--delete|--move)\b/.test(segment)) return false;
    return /^git\s+(?:status|diff|log|show|branch|rev-parse|remote|config|ls-files|describe|blame|reflog|shortlog|whatchanged|ls-remote|cat-file|show-ref|for-each-ref|grep)\b/.test(
      segment,
    );
  }
  if (head === 'node') return /^node\s+(?:--version|-v|--help|-h)\b/.test(segment);
  if (head === 'npm') {
    if (/^npm\s+audit\s+fix\b/.test(segment)) return false;
    return /^npm\s+(?:ls|list|view|info|outdated|audit|why|explain|root|prefix|bin|--version|-v|help|config\s+get)\b/.test(
      segment,
    );
  }
  if (head === 'pip' || head === 'pip3') {
    return /^(?:pip3?)\s+(?:list|show|freeze|--version|-V)\b/.test(segment);
  }
  if (head === 'cargo') return /^cargo\s+(?:--version|-V|metadata|tree|search|pkgid)\b/.test(segment);
  if (head === 'go') return /^go\s+(?:version|env|list|doc)\b/.test(segment);
  if (head === 'find' || head === 'fd' || head === 'fdfind') {
    return !/\s-(?:delete|exec|execdir|ok|okdir|fprint)\b/.test(segment);
  }
  if (head === 'curl') return false; // handled by the write check below
  if (head === 'wget') return false;
  if (head === 'docker') {
    return /^docker\s+(?:ps|images|logs|inspect|version|info|stats|history|diff|top|port)\b/.test(segment);
  }
  if (head === 'kubectl') {
    return /^kubectl\s+(?:get|describe|logs|version|explain|api-resources)\b/.test(segment);
  }
  return false;
}

function isWriteCommand(segment, head) {
  if (WRITE_COMMANDS.has(head)) {
    if (head === 'gofmt') return /\s-w\b/.test(segment);
    return true;
  }
  if (head === 'sed') return /(?:^|\s)(?:-i|--in-place)\b/.test(segment);
  if (head === 'git') {
    return /^git\s+(?:checkout|reset|stash|apply|commit|add|rm|mv|merge|rebase|cherry-pick|clean|switch|restore|pull|fetch|push|init|clone|am|format-patch|gc|prune|submodule)\b/.test(
      segment,
    );
  }
  if (head === 'npm' || head === 'pnpm' || head === 'yarn') {
    return /(?:^|\s)(?:install|i|ci|add|remove|uninstall|update|up|link|dedupe|prune|patch|create|pack)\b/.test(segment);
  }
  if (head === 'pip' || head === 'pip3') {
    return /(?:^|\s)(?:install|uninstall|download|wheel)\b/.test(segment);
  }
  if (head === 'python' || head === 'python3') {
    return /(?:-m\s+(?:pip|build|venv|ensurepip)|setup\.py)/.test(segment);
  }
  if (head === 'go') return /^go\s+(?:get|install|mod|generate|fmt)\b/.test(segment);
  if (head === 'cargo') return /^cargo\s+(?:add|install|update|fix|fmt|publish|remove)\b/.test(segment);
  if (head === 'docker') {
    return /^docker\s+(?:build|run|pull|push|compose|start|stop|rm|exec|cp|create|volume|network)\b/.test(segment);
  }
  if (head === 'curl') {
    return /(?:^|\s)(?:-o|--output|-O|--remote-name|-T|--upload-file)\b/.test(segment);
  }
  if (head === 'wget') {
    return !/(?:^|\s)(?:-O\s*-|--output-document=-)\b/.test(segment);
  }
  if (head === 'prettier' || head === 'ruff' || head === 'eslint') {
    return WRITE_FLAG_PATTERNS.some((pattern) => pattern.test(segment));
  }
  return false;
}

// ---------- npm run <script> 展开 ----------
//
// `npm run bench` 的脚本名本身不说明它做什么：它可能是 `node --test`，也可能
// 是任意一段能写文件的 JS。只有真读到 package.json 且脚本体全部落在已认识的
// 检查命令上时才放宽；读不到、脚本不存在、脚本体里有写命令，一律保持保守。

const PACKAGE_CACHE_MS = 60_000;
const packageCache = new Map();
const RUN_SCRIPT = /^(?:npm|pnpm|yarn)\s+run\s+([\w:@./-]+)\s*$/;
const MAX_SCRIPT_DEPTH = 2;

function readPackageJson(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  const cached = packageCache.get(cwd);
  if (cached && Date.now() - cached.at < PACKAGE_CACHE_MS) return cached.value;
  let value = null;
  try {
    const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    if (parsed && typeof parsed === 'object') value = parsed;
  } catch {
    value = null;
  }
  packageCache.set(cwd, { at: Date.now(), value });
  return value;
}

/** 清空 package.json 缓存。 */
export function resetPackageCache() {
  packageCache.clear();
}

function scriptBodyOf(normalized, options) {
  const match = RUN_SCRIPT.exec(normalized);
  if (!match) return null;
  const pkg = readPackageJson(options?.cwd);
  const body = pkg?.scripts?.[match[1]];
  if (typeof body !== 'string') return null;
  const trimmed = body.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Grade one simple command segment. Returns one of:
 * 'read-only' | 'test' | 'lint' | 'build' | 'possible-write' | 'unknown'.
 */
function commandImpact(segment, options = {}) {
  const normalized = normalizeSegment(segment);
  if (!normalized) return 'read-only';
  if (hasWriteRedirect(normalized)) return 'possible-write';

  const head = headToken(normalized);
  if (!head) return 'unknown';

  // 脚本名不等于行为：展开脚本体之后再判。
  const depth = Number.isFinite(options.depth) ? options.depth : 0;
  if (depth < MAX_SCRIPT_DEPTH) {
    const body = scriptBodyOf(normalized, options);
    if (body !== null) {
      const impacts = shellImpact(body, { ...options, depth: depth + 1 });
      if (
        impacts.every(
          (impact) =>
            impact === 'read-only' || impact === 'test' || impact === 'lint' || impact === 'build',
        )
      ) {
        if (impacts.includes('test')) return 'test';
        if (impacts.includes('lint')) return 'lint';
        // 构建脚本展开后是 build（tsc -p . / vite build / next build）。脚本名可解析
        // 时反而降级成 unknown，会让 `npm run build` 永远拿不到 build 身份。
        if (impacts.includes('build')) return 'build';
        return 'read-only';
      }
      return 'unknown';
    }
  }

  if (isTestCommand(normalized)) return 'test';
  if (isLintCommand(normalized)) {
    // `eslint --fix` / `prettier --write` rewrite files: not a read-only check.
    return WRITE_FLAG_PATTERNS.some((pattern) => pattern.test(normalized)) ? 'possible-write' : 'lint';
  }
  if (isBuildCommand(normalized)) return 'build';
  if (isReadOnlyCommand(normalized, head)) return 'read-only';
  if (isWriteCommand(normalized, head)) return 'possible-write';
  return 'unknown';
}

function shellImpact(command, options = {}) {
  const segments = splitSimpleCommands(stripQuoted(command));
  if (segments.length === 0) return ['unknown'];
  return segments.map((segment) => commandImpact(segment, options));
}

/** @returns {'read'|'write'|'test'|'build'|'lint'|'other'} */
export function classifyTool(name, args, options = {}) {
  const base = baseName(name);
  if (!base) return 'other';
  if (isWriteTool(base)) return 'write';
  if (isReadTool(base)) return 'read';
  if (isShellTool(base)) {
    const command = shellCommand(args);
    if (!command.trim()) return 'other';
    const impacts = shellImpact(command, options);
    // 一次调用里既有检查又有写入时，检查结果产生在写入之前，证明不了写入之后
    // 的实现；整条命令降为 other，逼调用方重跑一条干净的检查命令，而不是让
    // 这条「先测试、后改源码」的调用既当证据又当嫌疑对象。
    if (impacts.includes('possible-write')) return 'other';
    if (impacts.includes('test')) return 'test';
    if (impacts.includes('lint')) return 'lint';
    if (impacts.includes('build')) return 'build';
    if (impacts.every((impact) => impact === 'read-only')) return 'read';
    return 'other';
  }
  return 'other';
}

function redact(text) {
  let output = String(text ?? '');
  if (!output) return '';
  output = output.replace(BEARER_PAIR, '$1 ***');
  output = output.replace(URL_CREDENTIALS, '$1***@');
  output = output.replace(SECRET_FLAG, (_match, flag, separator) => `${flag}${separator}***`);
  output = output.replace(SECRET_PAIR, (_match, head, value) => {
    if (value.startsWith('"')) return `${head}"***"`;
    if (value.startsWith("'")) return `${head}'***'`;
    return `${head}***`;
  });
  return output;
}

function tailClip(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `…${text.slice(text.length - (max - 1))}`;
}

const SUMMARY_STRING_LIMIT = 160;
const SUMMARY_MAX_DEPTH = 2;
const SUMMARY_MAX_ITEMS = 3;
const SUMMARY_MAX_KEYS = 6;

/**
 * 嵌套参数的紧凑表示：保留结构与关键文本，避免整段压成 `[object]`。
 * 深于 SUMMARY_MAX_DEPTH 的层级只留类型占位，防止摘要被一个巨大对象撑爆。
 */
function compactValue(value, depth = 0) {
  if (value === null) return null;
  if (typeof value === 'string') return clip(value, SUMMARY_STRING_LIMIT);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= SUMMARY_MAX_DEPTH) return `[${value.length} items]`;
    const head = value.slice(0, SUMMARY_MAX_ITEMS).map((item) => compactValue(item, depth + 1));
    if (value.length > SUMMARY_MAX_ITEMS) head.push(`+${value.length - SUMMARY_MAX_ITEMS} more`);
    return head;
  }
  if (typeof value === 'object') {
    if (depth >= SUMMARY_MAX_DEPTH) return '{…}';
    const nested = {};
    for (const [key, item] of Object.entries(value).slice(0, SUMMARY_MAX_KEYS)) {
      nested[key] =
        CONTENT_KEYS.has(key) && typeof item === 'string' && item.length > 40
          ? `[${item.length} chars]`
          : compactValue(item, depth + 1);
    }
    return nested;
  }
  return String(value);
}

/**
 * Sanitized, bounded "what was called" line: the command for shell tools, the
 * target path for file tools, and a compact argument digest otherwise.
 */
export function summarizeCall(name, args) {
  const object = asObject(args);
  const parts = [];
  const base = baseName(name);

  if (object) {
    for (const key of COMMAND_KEYS) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) {
        parts.push(value);
        break;
      }
    }
    for (const key of TARGET_KEYS) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) parts.push(value);
      else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string' && item.trim()) parts.push(item);
        }
      }
    }
    for (const key of QUERY_KEYS) {
      const value = object[key];
      if (typeof value === 'string' && value.trim()) parts.push(`${key}=${value}`);
    }
    if (parts.length === 0) {
      const compact = {};
      for (const [key, value] of Object.entries(object)) {
        if (CONTENT_KEYS.has(key)) {
          compact[key] = typeof value === 'string' ? `[${value.length} chars]` : '[omitted]';
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          compact[key] = value;
        } else if (Array.isArray(value) && value.every((item) => typeof item === 'string' || typeof item === 'number')) {
          compact[key] = value;
        } else {
          compact[key] = compactValue(value, 0);
        }
      }
      try {
        parts.push(JSON.stringify(compact));
      } catch {
        parts.push(base || 'call');
      }
    }
  } else if (typeof args === 'string' && args.trim()) {
    parts.push(args);
  }

  const body = parts.filter(Boolean).join(' ');
  const summary = body || base || 'call';
  return clip(redact(summary), LIMITS.target);
}

function collectText(content, push) {
  if (typeof content === 'string') {
    push(content);
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    if (typeof item === 'string') push(item);
    else if (item && typeof item === 'object') push(item.text ?? item.content);
  }
}

function resultText(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) parts.push(value);
  };
  push(result.value);
  if (result.value && typeof result.value === 'object') {
    push(result.value.stdout);
    push(result.value.stderr);
    push(result.value.output);
    push(result.value.text);
    collectText(result.value.content, push);
  }
  push(result.stdout);
  push(result.stderr);
  push(result.output);
  push(result.text);
  collectText(result.content, push);
  return parts.join('\n');
}

function readExitCode(result) {
  if (!result || typeof result !== 'object') return null;
  const raw = result.meta?.exitCode ?? result.value?.exitCode ?? result.exitCode ?? null;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const MAX_RESULT_LINES = 20;

/** @returns {{ outcome: 'success'|'failure'|'unknown', exitCode: number|null, summary: string }} */
export function summarizeResult(result) {
  if (!result || typeof result !== 'object') {
    return { outcome: 'unknown', exitCode: null, summary: '' };
  }
  const outcome =
    typeof result.isError === 'boolean' ? (result.isError ? 'failure' : 'success') : 'unknown';
  const exitCode = readExitCode(result);

  const lines = redact(resultText(result))
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const tail = lines.slice(-MAX_RESULT_LINES).join('\n').trim();
  const summary = clip(tailClip(tail, LIMITS.stdout), LIMITS.summary);
  return { outcome, exitCode, summary };
}

/**
 * @returns {'confirmed'|'possible'|'irrelevant'|'not_applicable'}
 */
export function changeImpact(name, args, options = {}) {
  const base = baseName(name);
  if (!base) return 'possible';
  if (LEDGER_TOOL_NAMES.has(base)) return 'not_applicable';
  if (PLANNING_TOOL_NAMES.has(base)) return 'not_applicable';
  if (META_TOOL_NAMES.has(base)) return 'not_applicable';
  if (isWriteTool(base)) return 'confirmed';
  if (isReadTool(base)) return 'not_applicable';
  if (isShellTool(base)) {
    const command = shellCommand(args);
    if (!command.trim()) return 'possible';
    const impacts = shellImpact(command, options);
    if (impacts.length === 0) return 'possible';
    // 只读查看、测试、lint 与纯构建都不改实现：构建写的是派生产物（dist/target），
    // 源码没动，旧验证仍然有效。含写命令或无法识别的命令才按可能写入保守处理。
    if (
      impacts.every(
        (impact) =>
          impact === 'read-only' || impact === 'test' || impact === 'lint' || impact === 'build',
      )
    ) {
      return 'irrelevant';
    }
    return 'possible';
  }
  return 'possible';
}
