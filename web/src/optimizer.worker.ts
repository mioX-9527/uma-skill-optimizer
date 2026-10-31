import { COURSES, type UniqueScaling } from '../../src/data.js';
import { optimize, type OptimizerResult } from '../../src/optimizer.js';
import type { Aptitude, GroundCondition, Motivation, RunnerConfig, Season, Stats, Tactic, Weather } from '../../src/engine/index.js';

interface WorkerInput {
  readonly seq: number;
  readonly courseId: string;
  readonly budget: number;
  readonly stats: Stats;
  readonly tactic: Tactic;
  readonly distanceAptitude: Aptitude;
  readonly surfaceAptitude: Aptitude;
  readonly motivation: Motivation;
  readonly groundCondition: GroundCondition;
  readonly weather: Weather;
  readonly season: Season;
  /** 现场读到的双圈实付价:{单圈 id: 点数} */
  readonly circleUp?: Record<string, number>;
  /** 买金就送下位的覆盖关系(此前漏传,桌面读取的覆盖关系在网页开发版里不生效 —— 已补) */
  readonly supersedes?: readonly { readonly gold: string; readonly lower: string }[];
  /** 背景技能(已学/本体固有)id 列表 */
  readonly baseSkills?: readonly string[];
  /** 随绿技能数增强的固有档位数值覆盖 */
  readonly greenScaling?: Readonly<Record<string, UniqueScaling>>;
  readonly skills: readonly {
    id: string; pt: number; requires?: string;
    evolvesTo?: string; evolveAlternatives?: readonly string[];
  }[];
}

const ctx = self as unknown as {
  addEventListener: (t: 'message', cb: (e: MessageEvent) => void) => void;
  postMessage: (m: unknown) => void;
};

ctx.addEventListener('message', (e: MessageEvent) => {
  const input = e.data as WorkerInput;
  const course = COURSES.find(c => c.id === input.courseId);
  if (!course) {
    ctx.postMessage({ seq: input.seq, ok: false, error: `找不到赛道 ${input.courseId}` });
    return;
  }
  const runner: RunnerConfig = {
    stats: input.stats,
    greenBonus: {},
    tactic: input.tactic,
    distanceAptitude: input.distanceAptitude,
    surfaceAptitude: input.surfaceAptitude,
    motivation: input.motivation,
    groundCondition: input.groundCondition,
    weather: input.weather,
    season: input.season,
    courseFix: 'auto',
    skills: [],
  };
  try {
    const result: OptimizerResult = optimize({
      course,
      runner,
      candidates: input.skills,
      budget: input.budget,
      ...(input.circleUp !== undefined ? { circleUpOverride: input.circleUp } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.baseSkills !== undefined && input.baseSkills.length > 0 ? { baseSkills: input.baseSkills } : {}),
      ...(input.greenScaling !== undefined && Object.keys(input.greenScaling).length > 0
        ? { greenScaling: input.greenScaling }
        : {}),
    });
    ctx.postMessage({ seq: input.seq, ok: true, result });
  } catch (err) {
    ctx.postMessage({ seq: input.seq, ok: false, error: (err as Error).message });
  }
});
