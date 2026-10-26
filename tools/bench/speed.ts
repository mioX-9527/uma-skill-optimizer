import { loadPlan } from './probe.js';
import { simulate } from '../../src/engine/index.js';

const { course, runner } = loadPlan('app/_debug/plan_v2.json');
// 预热
for (let i = 0; i < 300; i++) simulate(course, { ...runner, skills: [] });
const N = 3000;
const t0 = Date.now();
for (let i = 0; i < N; i++) simulate(course, { ...runner, skills: [] });
const ms = Date.now() - t0;
console.log(`${N} 次空技能模拟 ${ms}ms → ${(ms / N).toFixed(3)} ms/sim`);
