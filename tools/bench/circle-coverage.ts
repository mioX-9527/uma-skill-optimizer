import { CIRCLE_BASE, SKILL_CHAINS, SKILLS } from '../../src/data.js';
const isCN = (s: { cnReleased?: boolean }) => s.cnReleased !== false;
const dou = SKILLS.filter(s => isCN(s) && s.name.endsWith('◎'));
let pairs = 0;
const missing: string[] = [];
for (const up of dou) {
  const baseName = up.name.slice(0, -1) + '○';
  const o = SKILLS.find(s => isCN(s) && s.name === baseName);
  if (!o) continue;
  pairs++;
  const viaCircle = CIRCLE_BASE.get(up.id) !== undefined;
  const viaChain = SKILL_CHAINS.get(up.id)?.prereqId === o.id;
  if (!viaCircle && !viaChain) missing.push(up.name);
}
console.log('双圈对总数(国服,有○对应):', pairs);
console.log('两表都覆盖不到的:', missing.length === 0 ? '(无,全覆盖)' : missing);
