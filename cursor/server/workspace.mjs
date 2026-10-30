// 项目键：与 DSH 版一致，用 git 仓库根目录标识项目，查不到就返回 null，
// 不用 "unspecified" 之类的假项目名污染经验库。
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const CACHE_TTL_MS = 60_000;
const cache = new Map();

export function projectKeyOf(workspaceRoot) {
  if (!workspaceRoot) return null;
  let key;
  try {
    key = resolve(String(workspaceRoot));
  } catch {
    return null;
  }
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const output = execFileSync('git', ['-C', key, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    if (output) value = output;
  } catch {
    value = null;
  }
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** 测试用：清空项目键缓存。 */
export function resetProjectCache() {
  cache.clear();
}
