import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COURSES, SKILLS } from '../src/data.js';

/**
 * 回归测试:CLI 参数层。
 *
 * 背景(2026-10-27):`--max-sims` 这个开关**从来没有生效过** —— `parseArgs` 把
 * `--max-sims 100` 存成键 `max-sims`,而 cli.ts 读的是 `args.maxSims`,永远 undefined。
 * 它活过了当时全部 55 个测试,因为那些用例**全部直接调 optimize()**,
 * 没有任何一条走过 parseArgs → 这就是本文件的由来。
 *
 * 这里必须走**真实进程**(node --import tsx src/cli.ts),不能只测 optimize(),
 * 否则测不到「参数名 ↔ 读取名」这层契约。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.ts');

interface RunOut {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): RunOut {
  const r = spawnSync(process.execPath, ['--import', 'tsx', CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    // 超时兜底:正常单次 < 10s,挂死时别把整个测试套件拖住
    timeout: 120_000,
  });
  if (r.error) throw r.error;
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 从 stdout 里取 `(模拟次数: N)` */
function simsOf(out: RunOut): number {
  const m = /模拟次数: (\d+)/.exec(out.stdout);
  if (!m) throw new Error(`stdout 里没有模拟次数:\n${out.stdout.slice(-800)}`);
  return Number(m[1]);
}

/** 生成一个自包含的 plan(不依赖 app/_debug,那份是 gitignore 的) */
function writePlan(dir: string, opts: { candidates: number; budget: number }): string {
  const course = COURSES.find(c => c.id === '10601') ?? COURSES[0]!;
  const skills: { id: string; pt: number }[] = [];
  for (const s of SKILLS) {
    if (skills.length >= opts.candidates) break;
    if (s.condition.kind !== 'phase' && s.condition.kind !== 'straightFastest') continue;
    if (s.restriction !== undefined) continue;
    if (s.precision === 'unsupported') continue;
    skills.push({ id: s.id, pt: 120 });
  }
  const plan = {
    course: course.id,
    budget: opts.budget,
    runner: {
      stats: { speed: 1200, stamina: 1000, power: 1100, guts: 700, wisdom: 900 },
      tactic: 'senko',
      distanceAptitude: 'A',
      surfaceAptitude: 'A',
      motivation: 'normal',
      groundCondition: 0,
      weather: 1,
      season: 1,
      courseFix: 'auto',
    },
    skills,
  };
  const p = join(dir, 'plan.json');
  writeFileSync(p, JSON.stringify(plan, null, 2), 'utf8');
  return p;
}

const dir = mkdtempSync(join(tmpdir(), 'uma-cli-'));
const CANDIDATES = 14;
const planPath = writePlan(dir, { candidates: CANDIDATES, budget: 900 });

describe('CLI: --max-sims', () => {
  it('开启 --max-sims 后模拟次数真的被压住,并给出降级说明', () => {
    const outPath = join(dir, 'res.json');
    const r = runCli(['--input', planPath, '--max-sims', '40', '--out', outPath]);
    expect(r.status, r.stderr).toBe(0);

    const result = JSON.parse(readFileSync(outPath, 'utf8')) as { simsUsed: number; chosen: unknown[] };
    // 搜索阶段严格受预算约束;**汇报阶段额度用尽后仍要放行**(要给出"已找到的最好组合",
    // 而不是一个结果都拿不到),所以上界 = maxSims + 基线 1 次 + 每个候选的单项收益 1 次
    // + 每个已选项的 leave-one-out 1 次。这个公式就是 P4 降级行为的契约。
    expect(result.simsUsed).toBeLessThanOrEqual(40 + 1 + CANDIDATES + result.chosen.length);
    expect(result.simsUsed).toBeGreaterThanOrEqual(40);
    // 静默降级比抛异常更糟:必须留下可读的说明
    expect(r.stdout).toContain('模拟次数达到上限(40)');
    expect(r.stdout).toContain('--max-sims');
  });

  it('不传 --max-sims 时模拟次数明显更多(证明开关不是空转)', () => {
    const capped = runCli(['--input', planPath, '--max-sims', '40']);
    const full = runCli(['--input', planPath]);
    expect(capped.status, capped.stderr).toBe(0);
    expect(full.status, full.stderr).toBe(0);
    expect(simsOf(full)).toBeGreaterThan(simsOf(capped) + 40);
    // 未撞上限时不该出现降级说明
    expect(full.stdout).not.toContain('模拟次数达到上限');
  });

  it.each([
    ['0', '0'],
    ['abc', 'abc'],
    ['-5', '-5'],
  ])('非法值 %s 直接报错退出,不进入求解', (input, expectEcho) => {
    const r = runCli(['--input', planPath, '--max-sims', input]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--max-sims');
    expect(r.stderr).toContain('≥1');
    expect(r.stderr).toContain(expectEcho);
    // 没开始求解 = 没有模拟次数输出
    expect(r.stdout).not.toContain('模拟次数');
  });

  it('--max-sims 与 --budget 同时给时互不干扰', () => {
    const r = runCli(['--input', planPath, '--budget', '600', '--max-sims', '60']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('预算: 600pt');
    expect(simsOf(r)).toBeGreaterThanOrEqual(60);
  });
});

// 清理临时目录(测试进程结束时)
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});
