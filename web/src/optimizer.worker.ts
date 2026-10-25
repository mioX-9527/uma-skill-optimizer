import { COURSES } from '../../src/data.js';
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
  readonly skills: readonly { id: string; pt: number }[];
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
    });
    ctx.postMessage({ seq: input.seq, ok: true, result });
  } catch (err) {
    ctx.postMessage({ seq: input.seq, ok: false, error: (err as Error).message });
  }
});
