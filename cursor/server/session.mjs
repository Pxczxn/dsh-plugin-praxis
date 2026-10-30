// 会话指针：Cursor 的 hook 事件里带 conversation_id，但 MCP server 看不到它。
// hook 把活跃会话与工作区写进 <dataDir>/session.json，MCP server 每次工具调用
// 时读回，任务、观察和项目归属才能落在同一个会话上。
//
// 文件很小，写入走临时文件 + rename；多个 hook 并发时最后一个完整写入生效。
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 会话簿最多保留多少条历史。 */
export const MAX_SESSIONS = 50;

/**
 * Praxis 数据目录。默认与 DSH 版分开，避免两个宿主互相写入对方的会话归属；
 * 设置 CURSOR_PRAXIS_DATA_DIR（或 PRAXIS_DATA_DIR）可以改到共享目录。
 */
export function dataDir() {
  const configured = process.env.CURSOR_PRAXIS_DATA_DIR || process.env.PRAXIS_DATA_DIR;
  if (configured && configured.trim()) return resolve(configured.trim());
  return join(homedir(), '.cursor', 'praxis');
}

export function sessionFilePath() {
  return join(dataDir(), 'session.json');
}

function emptyBook() {
  return { version: 1, active: null, sessions: {} };
}

/** 只读读取；损坏或不存在时返回空簿，不阻断 hook / MCP 调用。 */
export function readSessionBook() {
  try {
    const parsed = JSON.parse(readFileSync(sessionFilePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyBook();
    return {
      version: 1,
      active: parsed.active && typeof parsed.active === 'object' ? parsed.active : null,
      sessions:
        parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)
          ? parsed.sessions
          : {},
    };
  } catch {
    return emptyBook();
  }
}

function pruneSessions(book) {
  const entries = Object.entries(book.sessions);
  if (entries.length <= MAX_SESSIONS) return;
  const activeId = book.active?.sessionId ?? null;
  entries.sort((a, b) =>
    String(b[1]?.lastSeenAt ?? '').localeCompare(String(a[1]?.lastSeenAt ?? '')),
  );
  const kept = entries.slice(0, MAX_SESSIONS);
  if (activeId && !kept.some(([id]) => id === activeId)) {
    const active = entries.find(([id]) => id === activeId);
    if (active) kept.push(active);
  }
  book.sessions = Object.fromEntries(kept);
}

export function writeSessionBook(book) {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneSessions(book);
  const file = sessionFilePath();
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(book, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function freshSession(previous, now) {
  return {
    workspaceRoot: previous?.workspaceRoot ?? null,
    startedAt: previous?.startedAt ?? now,
    lastSeenAt: now,
    endedAt: null,
    lastEvent: null,
    hints: previous?.hints && typeof previous.hints === 'object' ? previous.hints : {},
  };
}

/**
 * 记录一次会话活动。hook 每次触发都调用，active 指针指向最后活动的会话。
 * 返回更新后的会话记录；缺少 sessionId 时返回 null。
 */
export function touchSession({ sessionId, workspaceRoot = null, event = 'touch' } = {}) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return null;
  const book = readSessionBook();
  const now = new Date().toISOString();
  const previous = book.sessions[id];
  const record = freshSession(previous, now);
  const root = workspaceRoot ? resolve(String(workspaceRoot)) : previous?.workspaceRoot ?? null;
  record.workspaceRoot = root;
  record.lastEvent = event;
  book.sessions[id] = record;
  book.active = { sessionId: id, workspaceRoot: root, at: now, event };
  writeSessionBook(book);
  return record;
}

/** 标记会话结束；如果它仍是 active，一并清除指针。 */
export function endSession(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return;
  const book = readSessionBook();
  const now = new Date().toISOString();
  const previous = book.sessions[id];
  if (previous) {
    book.sessions[id] = { ...freshSession(previous, now), ...previous, endedAt: now, lastSeenAt: now };
  }
  if (book.active?.sessionId === id) book.active = null;
  writeSessionBook(book);
}

/**
 * MCP 工具调用使用的会话。优先 active 指针；坏了就退回最近活动且未结束的会话。
 * 都没有时返回 null，由调用方决定兜底会话。
 */
export function activeSession() {
  const book = readSessionBook();
  const activeId = book.active?.sessionId;
  if (activeId) {
    const record = book.sessions[activeId];
    if (!record?.endedAt) {
      return {
        sessionId: activeId,
        workspaceRoot: book.active.workspaceRoot ?? record?.workspaceRoot ?? null,
        at: book.active.at ?? record?.lastSeenAt ?? null,
      };
    }
  }
  const live = Object.entries(book.sessions)
    .filter(([, record]) => record && !record.endedAt)
    .sort((a, b) => String(b[1]?.lastSeenAt ?? '').localeCompare(String(a[1]?.lastSeenAt ?? '')));
  if (live.length === 0) return null;
  const [sessionId, record] = live[0];
  return { sessionId, workspaceRoot: record?.workspaceRoot ?? null, at: record?.lastSeenAt ?? null };
}

/** 读取某个会话上一条提示的签名（用于提醒去重）。 */
export function readHint(sessionId, key) {
  if (!sessionId || !key) return null;
  const record = readSessionBook().sessions[sessionId];
  const value = record?.hints?.[key];
  return typeof value === 'string' ? value : null;
}

/** 记住某个会话的提示签名。 */
export function writeHint(sessionId, key, signature) {
  if (!sessionId || !key) return;
  const book = readSessionBook();
  const record = book.sessions[sessionId];
  if (!record) return;
  record.hints = record.hints && typeof record.hints === 'object' ? record.hints : {};
  record.hints[key] = String(signature ?? '');
  writeSessionBook(book);
}
