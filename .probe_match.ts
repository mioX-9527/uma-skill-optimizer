import { COURSES, SKILLS } from './src/data.js';
import { optimize } from './src/optimizer.js';
const captured: [string, number][] = [["向着，更远的地方……(继承)",140],["∴win Q.E.D.(继承)(1)",180],["顺时针○",81],["京都赛场○",81],["函馆赛场○",63],["隆尚赛场○",63],["标准距离○",81],["春季优俊少女○",81],["秋季优俊少女○",58],["弧线大师",225],["弯道能手○",108],["圆弧艺术家",255],["弯道恢复○",102],["临机应变",108],["最后冲刺",136],["抢先",84],["稳步紧追",180],["迅速果断",180],["超越架势",126],["一鼓作气",180],["紧追不舍",144],["内侧体验",304],["弯里横",160],["大胃储备",96],["中距离直线○",90],["中距离弯道○",60],["闪电步伐",126],["轻盈步伐",144],["长距离弯道○",90],["赶超能手",144],["追击",144],["居中弯道○",91],["稍作休息",162],["优俊少女爱好者",128],["尾巴跃龙门",250],["翘尾巴",70],["先走一步！",304],["游戏到此为止！",160],["不遗余力",144],["我行我素",119],["浑然忘我",306],["不顾一切",162],["锁定",144],["十万火急",112],["点火",144],["探求心(1)",108],["永不言弃",342],["坚定之心",180],["品行方正",144],["巅峰之梦",320],["背负信念",180]];
const cands = captured.map(([name, pt]) => {
  const s = SKILLS.find(k => k.name === name)!;
  return { id: s.id, pt, ...(name === '迅速果断' ? { evolvesTo: '102101111' } : {}) };
});
const course = COURSES.find(c => c.name.includes('中山') && c.distance === 2500)!;
console.log('目标(用户截图):13 项 / 2532pt / 19.60 马身 / 内侧体验在、向着被挤出');
for (const speed of [1200, 1400, 1600]) for (const stamina of [600, 700, 800, 900, 1000]) {
  const runner: any = { stats: { speed, stamina, power: 1100, guts: 700, wisdom: 900 }, greenBonus: {}, tactic: 'sashi', distanceAptitude: 'A', surfaceAptitude: 'A', motivation: 'normal', groundCondition: 0, weather: 1, season: 1, courseFix: 'auto', skills: [] };
  const r = optimize({ course, runner, budget: 2533, candidates: cands });
  const hasInner = r.chosen.some(c => c.name === '内侧体验');
  const gap = Math.abs(r.totalBody - 19.60);
  if (gap < 3 && hasInner) {
    const xd = r.rejected.find(x => x.name.startsWith('向着'));
    console.log(`速${speed}/耐${stamina}: ${r.chosen.length}项 ${r.totalPt}pt ${r.totalBody.toFixed(2)}马身 | 内侧体验边际 ${r.chosen.find(c=>c.name==='内侧体验')!.finalMarginalBody.toFixed(2)} | 向着: ${xd ? xd.reason + ' 边际' + xd.lastMarginalBody.toFixed(2) + ' solo' + xd.soloBody.toFixed(2) : '已买'}`);
  }
}
