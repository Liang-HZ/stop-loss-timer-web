// packages/core/templates.js
// 内置的跨场景重评规则例子（所有用户都有，原则：
// 「个人重评规则｜免费：内置少量跨场景例子；可以每次手动填写」）。
//
// 这些只是**输入预设**：名字、投入边界、提醒语、时长组合。它们不参与任何判定，
// 也不暗示哪种选择更好；用户可以直接用、改一改再用，或者完全不用。
// 五个例子刻意跨生活领域（消费选择／学习／家务手工／沟通／排查），
// 不把开发者工作流当成默认场景。

import { t } from './copy.js';

const MIN = 60000;

export const BUILTIN_TEMPLATE_SPECS = Object.freeze([
  Object.freeze({ templateId: 'builtin_compare', scene: 'compare', durationsMs: Object.freeze([5 * MIN, 15 * MIN, 30 * MIN]) }),
  Object.freeze({ templateId: 'builtin_stuck', scene: 'stuck', durationsMs: Object.freeze([15 * MIN, 30 * MIN, 45 * MIN]) }),
  Object.freeze({ templateId: 'builtin_detail', scene: 'detail', durationsMs: Object.freeze([10 * MIN, 20 * MIN, 30 * MIN]) }),
  Object.freeze({ templateId: 'builtin_argue', scene: 'argue', durationsMs: Object.freeze([5 * MIN, 10 * MIN, 15 * MIN]) }),
  Object.freeze({ templateId: 'builtin_debug', scene: 'debug', durationsMs: Object.freeze([15 * MIN, 30 * MIN, 60 * MIN]) })
]);

/**
 * 按语言产出内置例子。**不写进 state**：它们是只读的展示项，
 * 存进去会占用户的模板容量，也会在两端合并时变成需要同步的数据。
 * 用户想改，就用 saveTemplate() 另存一份自己的（builtIn 不带过去）。
 */
export function builtInTemplates(locale) {
  return BUILTIN_TEMPLATE_SPECS.map(spec => {
    const tpl = {
      templateId: spec.templateId,
      name: t('template.builtin.' + spec.scene + '.name', locale),
      hypothesis: t('template.builtin.' + spec.scene + '.hypothesis', locale),
      reminderText: t('template.builtin.' + spec.scene + '.reminder', locale),
      scene: spec.scene,
      durationsMs: spec.durationsMs.slice(),
      builtIn: true,
      createdAt: 0,
      updatedAt: 0
    };
    return tpl;
  });
}

export const isBuiltInTemplateId = id => BUILTIN_TEMPLATE_SPECS.some(s => s.templateId === id);
