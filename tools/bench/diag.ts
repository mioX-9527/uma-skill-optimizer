import { COURSES, SKILLS } from '../../src/data.js';
import { simulate } from '../../src/engine/index.js';
import type { RunnerConfig, SkillConfig } from '../../src/engine/index.js';

const runner: RunnerConfig = {
  stats: { speed: 1200, stamina: 1000, power: 1100, guts: 700, wisdom: 900 },
  greenBonus: {}, tactic: 'senko', distanceAptitude: 'A', surfaceAptitude: 'A',
  motivation: 'normal', courseFix: 'auto', skills: [],
};

const G = SKILLS.find(s => s.id === '201662')! as SkillConfig;
const W = SKILLS.find(s => s.id === '201661')! as SkillConfig;

console.log('COURSES[0] =', COURSES[0]!.id, COURSES[0]!.name, COURSES[0]!.distance + 'm');
for (const c of [COURSES[0]!, ...(COURSES.find(x => x.id === '10601') ? [COURSES.find(x => x.id === '10601')!] : [])]) {
  const b = simulate(c, runner);
  const og = simulate(c, { ...runner, skills: [G] });
  const ow = simulate(c, { ...runner, skills: [W] });
  const st = simulate(c, { ...runner, skills: [W, G] });
  console.log(`\n${c.id} ${c.name} ${c.distance}m`);
  console.log('  空手  ', b.finishTimeSec.toFixed(5), ' 末脚速度', b.spurtTargetSpeed.toFixed(3));
  console.log('  只金  ', og.finishTimeSec.toFixed(5), og.activations.map(a => a.skillId + '@' + a.atSec.toFixed(1)).join(','));
  console.log('  只白  ', ow.finishTimeSec.toFixed(5), ow.activations.map(a => a.skillId + '@' + a.atSec.toFixed(1)).join(','));
  console.log('  白+金 ', st.finishTimeSec.toFixed(5), st.activations.map(a => a.skillId + '@' + a.atSec.toFixed(1)).join(','));
}
