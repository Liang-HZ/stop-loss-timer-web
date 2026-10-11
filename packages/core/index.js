// packages/core/index.js — 共享领域逻辑的统一出口。
// Web：<script type="module"> import { ... } from '/core/index.js'
// 小程序：const core = require('../core/index.js')（由 scripts/build-core.mjs 生成 CJS）
export * from './model.js';
export * from './capacity.js';
export * from './flow.js';
export * from './migrate.js';
export * from './review.js';
export * from './sync.js';
export * from './copy.js';
export * from './templates.js';
