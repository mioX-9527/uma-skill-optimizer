import { useEffect, useMemo, useRef, useState } from 'react';
import type { Aptitude, Motivation, Tactic } from '../../src/engine/index.js';
import { SKILLS } from '../../src/data.js';
import {
  courseOf, courseOptions, defaultPt, describeEffects, exportPlan, importPlan,
  PRECISION_LABEL, RARITY_LABEL, runOptimize, searchSkills,
  type OptimizerResult, type PlanSkill, type PlanState,
} from './api.js';

const STAT_LABELS: readonly { key: keyof PlanState['stats']; label: string }[] = [
  { key: 'speed', label: '速度' },
  { key: 'stamina', label: '耐力' },
  { key: 'power', label: '力量' },
  { key: 'guts', label: '根性' },
  { key: 'wisdom', label: '智力' },
];
const TACTIC_OPTIONS: readonly { v: Tactic; label: string }[] = [
  { v: 'nige', label: '逃' }, { v: 'senko', label: '先' }, { v: 'sashi', label: '差' }, { v: 'oikomi', label: '追' },
];
const APTITUDE_OPTIONS: readonly Aptitude[] = ['S', 'A', 'B', 'C', 'D', 'E', 'F', 'G'];
const MOTIVATION_OPTIONS: readonly { v: Motivation; label: string }[] = [
  { v: 'best', label: '绝好调' }, { v: 'good', label: '好调' }, { v: 'normal', label: '普通' }, { v: 'bad', label: '不调' }, { v: 'worst', label: '绝不调' },
];
const REASON_LABEL: Record<string, string> = {
  unaffordable: '超预算', 'no-gain': '组合内无正收益', outbid: '被更优组合挤出',
};

const STORAGE_KEY = 'uma-skill-optimizer-plan-v1';

function loadInitialPlan(): PlanState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return importPlan(raw);
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return importPlan(JSON.stringify(EXAMPLE));
}

const EXAMPLE = {
  course: '东京 草 2400m',
  budget: 1000,
  runner: {
    stats: { speed: 1200, stamina: 1000, power: 1100, guts: 700, wisdom: 900 },
    tactic: 'senko', distanceAptitude: 'A', surfaceAptitude: 'A', motivation: 'normal',
  },
  skills: [
    { name: '中距离直线◎', pt: 180 }, { name: '迅疾如风', pt: 180 }, { id: '901121', pt: 120 },
    { name: '弯道恢复○', pt: 90 }, { name: '直线恢复', pt: 90 }, { name: '一鼓作气', pt: 90 },
    { name: '抢先', pt: 90 }, { name: '弯里横', pt: 90 }, { name: '随势而动', pt: 90 }, { name: '放学后的乐趣', pt: 90 },
  ],
};

export default function App() {
  const [plan, setPlan] = useState<PlanState>(loadInitialPlan);
  const [courseQuery, setCourseQuery] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const course = courseOf(plan.courseId);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, exportPlan(plan)); } catch { /* 忽略 */ }
  }, [plan]);

  const courseOpts = useMemo(() => courseOptions(courseQuery).slice(0, 60), [courseQuery]);
  const results = useMemo(() => searchSkills(query), [query]);

  const patch = (p: Partial<PlanState>) => setPlan(prev => ({ ...prev, ...p }));

  const addSkill = (entry: (typeof results)[number]) => {
    if (plan.skills.some(s => s.id === entry.id)) return;
    const skill: PlanSkill = { id: entry.id, name: entry.name, pt: defaultPt(entry), rarity: entry.rarity, precision: entry.precision };
    patch({ skills: [...plan.skills, skill] });
    setQuery('');
    setResult(null);
  };

  const setPt = (id: string, pt: number) => {
    patch({ skills: plan.skills.map(s => (s.id === id ? { ...s, pt } : s)) });
    setResult(null);
  };
  const removeSkill = (id: string) => {
    patch({ skills: plan.skills.filter(s => s.id !== id) });
    setResult(null);
  };

  const compute = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await runOptimize({
        courseId: plan.courseId,
        budget: plan.budget,
        stats: plan.stats,
        tactic: plan.tactic,
        distanceAptitude: plan.distanceAptitude,
        surfaceAptitude: plan.surfaceAptitude,
        motivation: plan.motivation,
        skills: plan.skills.map(s => ({ id: s.id, pt: s.pt })),
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const download = () => {
    const blob = new Blob([exportPlan(plan)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'skill-plan.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openFile = () => fileRef.current?.click();
  const onFile: React.ChangeEventHandler<HTMLInputElement> = async e => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      setPlan(importPlan(await f.text()));
      setResult(null);
      setError(null);
    } catch (err) {
      setError(`导入失败:${(err as Error).message}`);
    }
  };

  const totalDefaultPt = plan.skills.reduce((a, s) => a + s.pt, 0);

  return (
    <div className="layout">
      <header>
        <h1>赛马娘技能PT规划器</h1>
        <p className="sub">按实际 PT 预算,基于赛道模拟求马身收益最大的技能购买组合 · <a href="https://github.com/mioX-9527/uma-race-sim" target="_blank" rel="noreferrer">引擎: uma-race-sim</a></p>
      </header>

      <div className="columns">
        {/* ── 左列:配置 ── */}
        <section className="panel">
          <h2>配置</h2>

          <label className="field">
            <span>赛道</span>
            <input
              placeholder="筛选赛道(如:东京2400)"
              value={courseQuery}
              onChange={e => setCourseQuery(e.target.value)}
            />
            <select
              value={plan.courseId}
              onChange={e => { patch({ courseId: e.target.value }); setResult(null); }}
              size={5}
            >
              {!courseOpts.some(o => o.id === plan.courseId) && (
                <option value={plan.courseId}>{course.name} ({course.id})</option>
              )}
              {courseOpts.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>

          <label className="field row">
            <span>PT 预算</span>
            <input
              type="number" min={0} value={plan.budget}
              onChange={e => { patch({ budget: Math.max(0, Number(e.target.value) || 0) }); setResult(null); }}
            />
          </label>

          <div className="field">
            <span>五维面板(含因子/绿技能前提值)</span>
            <div className="stats">
              {STAT_LABELS.map(({ key, label }) => (
                <label key={key}>
                  {label}
                  <input
                    type="number" min={0} max={2000} value={plan.stats[key]}
                    onChange={e => {
                      patch({ stats: { ...plan.stats, [key]: Math.max(0, Number(e.target.value) || 0) } });
                      setResult(null);
                    }}
                  />
                </label>
              ))}
            </div>
          </div>

          <div className="field row">
            <span>跑法</span>
            <div className="radio">
              {TACTIC_OPTIONS.map(o => (
                <label key={o.v}>
                  <input type="radio" name="tactic" checked={plan.tactic === o.v}
                    onChange={() => { patch({ tactic: o.v }); setResult(null); }} />
                  {o.label}
                </label>
              ))}
            </div>
          </div>

          <div className="field row">
            <span>适性(距离/场地)</span>
            <select value={plan.distanceAptitude} onChange={e => { patch({ distanceAptitude: e.target.value as Aptitude }); setResult(null); }}>
              {APTITUDE_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={plan.surfaceAptitude} onChange={e => { patch({ surfaceAptitude: e.target.value as Aptitude }); setResult(null); }}>
              {APTITUDE_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>

          <div className="field row">
            <span>干劲</span>
            <select value={plan.motivation} onChange={e => { patch({ motivation: e.target.value as Motivation }); setResult(null); }}>
              {MOTIVATION_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </div>
        </section>

        {/* ── 右列:技能 ── */}
        <section className="panel">
          <h2>候选技能 <span className="hint">(pt 填游戏内实际显示价;当前合计 {totalDefaultPt}pt)</span></h2>

          <div className="search">
            <input
              placeholder="搜索技能名(中/日/繁),点选添加"
              value={query}
              onChange={e => setQuery(e.target.value)}
            />
            {results.length > 0 && (
              <ul className="search-results">
                {results.map(s => (
                  <li key={s.id} onClick={() => addSkill(s)}>
                    <b>{s.name}</b>
                    <span className={`tag rarity-${s.rarity === 'normal' ? 'n' : 'r'}`}>{RARITY_LABEL[s.rarity] ?? s.rarity}</span>
                    {PRECISION_LABEL[s.precision] && <span className="tag warn">{PRECISION_LABEL[s.precision]}</span>}
                    <span className="dim">{describeEffects(s)}</span>
                    <span className="dim">默认 {defaultPt(s)}pt</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ul className="skill-list">
            {plan.skills.map(s => (
              <li key={s.id}>
                <b>{s.name}</b>
                <span className={`tag rarity-${s.rarity === 'normal' ? 'n' : 'r'}`}>{RARITY_LABEL[s.rarity] ?? s.rarity}</span>
                {PRECISION_LABEL[s.precision] && <span className="tag warn">{PRECISION_LABEL[s.precision]}</span>}
                <span className="grow dim">{describeEffects(SKILLS.find(k => k.id === s.id)!)}</span>
                <label className="pt-edit">
                  pt
                  <input type="number" min={0} value={s.pt} onChange={e => setPt(s.id, Math.max(0, Number(e.target.value) || 0))} />
                </label>
                <button className="x" onClick={() => removeSkill(s.id)} title="移除">×</button>
              </li>
            ))}
            {plan.skills.length === 0 && <li className="dim">从上方搜索添加候选技能…</li>}
          </ul>

          <div className="actions">
            <button className="primary" onClick={compute} disabled={running || plan.skills.length === 0}>
              {running ? '计算中…(几秒到几十秒)' : '开始计算'}
            </button>
            <button onClick={openFile}>导入 JSON</button>
            <button onClick={download}>导出 JSON</button>
            <button onClick={() => { setPlan(importPlan(JSON.stringify(EXAMPLE))); setResult(null); }}>载入示例</button>
            <input ref={fileRef} type="file" accept=".json" hidden onChange={onFile} />
          </div>
          {error && <p className="error">{error}</p>}
        </section>
      </div>

      {/* ── 结果 ── */}
      {result && (
        <section className="panel result">
          <h2>推荐结果</h2>
          <p className="summary">
            {course.name}:无技能 <b>{result.baselineSec.toFixed(3)}s</b> → 有技能 <b>{result.finalSec.toFixed(3)}s</b>
            &nbsp;·&nbsp; 购买 <b>{result.chosen.length}</b> 项,合计 <b>{result.totalPt}pt</b>(剩 {result.remainingPt}pt)
            &nbsp;·&nbsp; 总收益 <b className="good">{result.totalBody.toFixed(2)} 马身</b>
          </p>
          <p className="dim">
            单项收益之和 {result.sumSoloBody.toFixed(2)} 马身;与总收益的差 = 技能间交互(重叠/联动),单项列仅供对照
          </p>

          <table>
            <thead>
              <tr><th>#</th><th>技能</th><th>PT</th><th>单独马身</th><th>集内边际</th><th>边际(秒)</th></tr>
            </thead>
            <tbody>
              {result.chosen.map((c, i) => (
                <tr key={c.id}>
                  <td>{i + 1}</td>
                  <td>{c.name}</td>
                  <td className="num">{c.pt}</td>
                  <td className="num">{c.soloBody.toFixed(2)}</td>
                  <td className="num good">{c.finalMarginalBody.toFixed(2)}</td>
                  <td className="num">{c.finalMarginalSec.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.rejected.length > 0 && (
            <>
              <h3>未购买(按剩余边际收益排序)</h3>
              <table>
                <thead>
                  <tr><th>技能</th><th>PT</th><th>单独马身</th><th>原因</th><th>差PT</th></tr>
                </thead>
                <tbody>
                  {result.rejected.map(r => (
                    <tr key={r.id}>
                      <td>{r.name}</td>
                      <td className="num">{r.pt}</td>
                      <td className="num">{r.soloBody.toFixed(2)}</td>
                      <td>{REASON_LABEL[r.reason]}</td>
                      <td className="num">{r.reason === 'outbid' && r.missingPt > 0 ? r.missingPt : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {result.notes.map((n, i) => <p key={i} className="warn-text">[注意] {n}</p>)}
          <p className="dim">(模拟次数:{result.simsUsed};导出 JSON 可在 CLI 中复跑同组合)</p>
        </section>
      )}
    </div>
  );
}
