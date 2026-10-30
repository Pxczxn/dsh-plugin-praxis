import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runNode, SCRIPTS_DIR, tempDir } from '../test-support/helpers.mjs';

const pluginRoot = fileURLToPath(new URL('..', import.meta.url));

function readJson(relative) {
  return JSON.parse(readFileSync(join(pluginRoot, relative), 'utf8'));
}

test('插件清单、MCP 与 hooks 配置指向真实文件', () => {
  const manifest = readJson('.cursor-plugin/plugin.json');
  assert.equal(manifest.name, 'praxis');
  assert.equal(manifest.hooks, 'hooks/hooks.json');

  const mcp = readJson('mcp.json');
  const server = mcp.mcpServers.praxis;
  assert.equal(server.command, 'node');
  assert.equal(server.args[0], '${CURSOR_PLUGIN_ROOT}/server/index.js');

  const hooks = readJson('hooks/hooks.json');
  const events = Object.keys(hooks.hooks);
  for (const event of [
    'sessionStart',
    'sessionEnd',
    'beforeSubmitPrompt',
    'postToolUse',
    'postToolUseFailure',
    'afterFileEdit',
    'stop',
  ]) {
    assert.ok(events.includes(event), `缺少 hook 事件：${event}`);
  }
  for (const entries of Object.values(hooks.hooks)) {
    for (const entry of entries) {
      const match = String(entry.command).match(/hooks\/[\w.-]+\.mjs/);
      assert.ok(match, `hook 命令没有指向 hooks 脚本：${entry.command}`);
      assert.ok(existsSync(join(pluginRoot, match[0])), `hook 脚本不存在：${match[0]}`);
    }
  }

  for (const relative of [
    'rules/praxis.mdc',
    'skills/praxis/SKILL.md',
    'scripts/install.ps1',
    'scripts/install.sh',
    'scripts/uninstall.ps1',
    'scripts/uninstall.sh',
  ]) {
    assert.ok(existsSync(join(pluginRoot, relative)), `缺少文件：${relative}`);
  }

  const rule = readFileSync(join(pluginRoot, 'rules/praxis.mdc'), 'utf8');
  assert.match(rule, /^---\r?\n[\s\S]*alwaysApply: true[\s\S]*---/);
  const skill = readFileSync(join(pluginRoot, 'skills/praxis/SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\n[\s\S]*name: praxis[\s\S]*---/);
});

test('安装脚本：复制到 --dest，卸载后目录消失，--dry-run 不落盘', async () => {
  const linkScript = join(SCRIPTS_DIR, 'link.mjs');
  const dest = join(tempDir('praxis-install-'), 'praxis');

  const install = await runNode(linkScript, {
    args: ['install', '--dest', dest, '--skip-sync'],
  });
  assert.equal(install.code, 0, install.stderr);
  assert.ok(existsSync(join(dest, '.cursor-plugin', 'plugin.json')));
  assert.ok(existsSync(join(dest, 'server', 'core', 'store.js')));
  assert.ok(existsSync(join(dest, 'hooks', 'hooks.json')));
  assert.equal(existsSync(join(dest, 'test')), false, '测试目录不会被安装');
  assert.equal(existsSync(join(dest, 'test-support')), false, '测试辅助目录不会被安装');

  const uninstall = await runNode(linkScript, { args: ['uninstall', '--dest', dest] });
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(existsSync(dest), false);

  const dryDest = join(tempDir('praxis-dry-'), 'praxis');
  const dryRun = await runNode(linkScript, {
    args: ['install', '--dest', dryDest, '--dry-run'],
  });
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.equal(existsSync(dryDest), false);
});
