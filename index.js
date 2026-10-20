// Praxis 插件入口：只做宿主接线，规则与存储都在 src/。
import { createStore } from './src/store.js';
import { createEngine } from './src/engine.js';
import {
  LESSON_DESCRIPTION,
  LESSON_NAME,
  LESSON_PARAMETERS,
  TASK_DESCRIPTION,
  TASK_NAME,
  TASK_PARAMETERS,
  createHandlers,
} from './src/tools.js';
import { attachObserver } from './src/observer.js';
import { attachLifecycle } from './src/lifecycle.js';
import { contextOf, resolveService } from './src/context.js';

export const name = 'dsh-plugin-praxis';
export const inject = ['tools'];

const output = {
  schema: { type: 'object', additionalProperties: true },
  render(_args, value) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
  },
};

function warn(ctx, message) {
  const logger = resolveService(ctx, 'logger');
  if (logger && typeof logger.warn === 'function') logger.warn(message);
  else console.warn(`[praxis] ${message}`);
}

export function apply(ctx) {
  const store = createStore();
  const engine = createEngine(store);
  const handlers = createHandlers({
    engine,
    context: (exec) => contextOf(exec, ctx, store),
  });

  const disposers = [
    ctx.tools.register({
      name: TASK_NAME,
      description: TASK_DESCRIPTION,
      parameters: TASK_PARAMETERS,
      output,
      execute: (args, exec) => handlers.task(args, exec),
    }),
    ctx.tools.register({
      name: LESSON_NAME,
      description: LESSON_DESCRIPTION,
      parameters: LESSON_PARAMETERS,
      output,
      execute: (args, exec) => handlers.lesson(args, exec),
    }),
  ];

  const degraded = [];
  for (const [label, attach] of [
    ['observer', attachObserver],
    ['lifecycle', attachLifecycle],
  ]) {
    try {
      const dispose = attach(ctx, store);
      if (typeof dispose === 'function') {
        disposers.push(dispose);
        if (dispose.degraded) degraded.push(`${label}:${dispose.degraded}`);
      } else if (dispose && typeof dispose === 'object' && dispose.degraded) {
        degraded.push(`${label}:${dispose.degraded}`);
      }
    } catch (error) {
      degraded.push(label);
      warn(ctx, `${label} hook unavailable: ${error?.message ?? error}`);
    }
  }
  if (degraded.length > 0) {
    warn(ctx, `degraded to manual tool mode: ${degraded.join(', ')}`);
  }

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 已经释放过
      }
    }
  };
}

export default { name, inject, apply };
