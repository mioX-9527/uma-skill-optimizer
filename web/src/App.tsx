import { useEffect, useMemo, useRef, useState } from 'react';
import type { Aptitude, GroundCondition, Motivation, Season, Tactic, Weather } from '../../src/engine/index.js';
import { SKILLS } from '../../src/data.js';
import {
  courseOf, courseOptions, defaultPt, describeEffects, exportPlan, importPlan,
  PRECISION_LABEL, RARITY_LABEL, runOptimize, searchSkills,
  type OptimizerResult, type PlanSkill, type PlanState,
} from './api.js';
import {
  applyCapture, applyEvolutions, captureSummary, deviceLabel, pickDevice, waitForDesktopBridge,
  type AdbDevice, type CapturedSkill, type DesktopBridge,
} from './desktop.js';

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
const GROUND_OPTIONS: readonly { v: GroundCondition; label: string }[] = [
  { v: 0, label: '良' }, { v: 1, label: '稍重' }, { v: 2, label: '重' }, { v: 3, label: '不良' },
];
const WEATHER_OPTIONS: readonly { v: Weather; label: string }[] = [
  { v: 1, label: '晴' }, { v: 2, label: '阴' }, { v: 3, label: '雨' }, { v: 4, label: '雪' },
];
const SEASON_OPTIONS: readonly { v: Season; label: string }[] = [
  { v: 1, label: '春' }, { v: 2, label: '夏' }, { v: 3, label: '秋' }, { v: 4, label: '冬' }, { v: 5, label: '樱花' },
];
const REASON_LABEL: Record<string, string> = {
  unaffordable: '超预算', inapplicable: '不适配本配置', 'no-gain': '组合内无正收益', outbid: '被更优组合挤出',
};

const STORAGE_KEY = 'uma-skill-optimizer-plan-v1';
/** 上次选中的 adb 设备(序列号) */
const SERIAL_KEY = 'uma-skill-optimizer-adb-serial';

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
    groundCondition: 0, weather: 1, season: 1,
  },
  // 与 examples/input.example.json 保持一致
  skills: [
    { name: '迅疾如风', pt: 180 }, { name: '中距离直线◎', pt: 130 }, { name: '短兵相接', pt: 180 },
    { name: '直线能手', pt: 100 }, { name: 'Seirios(继承)(1)', pt: 150 }, { name: '中距离直线○', pt: 90 },
    { name: '博弈者(1)', pt: 200 }, { name: '瞬息万变', pt: 200 }, { name: '亲手把握未来', pt: 110 },
    { name: '春初暖风', pt: 180 }, { name: '跟前直线◎', pt: 130 }, { name: 'Into High Gear!(继承)(1)', pt: 150 },
    { name: '王道征途', pt: 180 }, { name: '愿者上钩(继承)', pt: 120 },
  ],
};

export default function App() {
  const [plan, setPlan] = useState<PlanState>(loadInitialPlan);
  const [courseQuery, setCourseQuery] = useState('');
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<OptimizerResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  /** 导出/保存的结果提示(桌面版弹对话框后显示落盘路径) */
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [readLog, setReadLog] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  // 只有被 pywebview 装进桌面窗时才有值;普通浏览器/单文件版恒为 null,按钮不出现。
  // 注意必须等注入完成:pywebview 是页面加载**之后**才创建 window.pywebview 的,
  // 首帧直接读会永远拿不到(实测就是窗口开了但没有「从模拟器读取」按钮)。
  const [bridge, setBridge] = useState<DesktopBridge | null>(null);
  useEffect(() => waitForDesktopBridge(setBridge), []);
  // adb 设备选择:多模拟器共存时 5555 未必是赛马娘那台(实测被 MuMu 占过),
  // 所以一律先列设备让用户选,选过的记下来下次直接用。
  const [devices, setDevices] = useState<readonly AdbDevice[]>([]);
  const [serial, setSerial] = useState<string | null>(null);
  const [loadingDevices, setLoadingDevices] = useState(false);

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

  /** 刷新设备列表(force=true 会去扫一遍常见模拟器端口) */
  const refreshDevices = async (force = false) => {
    if (!bridge) return;
    setLoadingDevices(true);
    try {
      const resp = await bridge.devices(force);
      if (!resp.ok) {
        setDevices([]);
        setSerial(null);
        setReadLog([`设备列表读取失败:${resp.error ?? '未知错误'}`]);
        return;
      }
      const list = resp.devices ?? [];
      setDevices(list);
      let remembered: string | null = null;
      try { remembered = localStorage.getItem(SERIAL_KEY); } catch { /* 忽略 */ }
      const picked = pickDevice(list, remembered ?? resp.recommended ?? null);
      setSerial(picked);
      if (picked) {
        try { localStorage.setItem(SERIAL_KEY, picked); } catch { /* 忽略 */ }
      }
      if (list.length === 0) setReadLog(['没找到在线的模拟器。先启动模拟器(雷电/MuMu 都行),再点「刷新设备」。']);
    } catch (e) {
      setReadLog([`设备列表读取失败:${(e as Error).message}`]);
    } finally {
      setLoadingDevices(false);
    }
  };

  // 桌面壳就绪后自动列一次设备(不扫端口,快)
  useEffect(() => { if (bridge) void refreshDevices(false); }, [bridge]);

  const chooseDevice = (value: string) => {
    setSerial(value);
    try { localStorage.setItem(SERIAL_KEY, value); } catch { /* 忽略 */ }
  };

  /** 桌面窗专用:从模拟器读技能名与价格,覆盖候选列表 */
  const readFromEmulator = async () => {
    if (!bridge) return;
    setReading(true);
    setReadLog(['正在读取…(划到顶 + 逐屏识别,约 10~20 秒)']);
    setError(null);
    try {
      const resp = await bridge.capture_skills(serial ?? undefined);
      setReadLog(captureSummary(resp));
      if (!resp.ok) return;
      const merged = applyCapture(plan, resp, (c: CapturedSkill) => {
        const entry = SKILLS.find(k => k.id === c.id);
        if (!entry) return null;
        const skill: PlanSkill = {
          id: entry.id, name: entry.name, pt: c.pt, rarity: entry.rarity, precision: entry.precision,
        };
        return skill;
      });
      // 进化关系必须挂到候选上:进化后的技能不在候选列表里(金技能免费变来的),
      // 不挂的话优化器只会按进化前的数值算 —— 表现就是"怎么还是只有迅速果断"。
      const evo = applyEvolutions(merged.skills, resp.evolutions);
      patch({ skills: evo.skills, budget: merged.budget, chains: resp.chains ?? [] });
      setResult(null);
      if (merged.dropped > 0) setReadLog(prev => [...prev, `有 ${merged.dropped} 条未能对应到技能库,已丢弃`]);
      if (evo.evolved.length > 0) {
        setReadLog(prev => [...prev,
          `可进化 ${evo.evolved.length} 个:${evo.evolved.map(e => `${e.from}→${e.to}`).join('、')}`]);
      }
      if (evo.skipped.length > 0) {
        setReadLog(prev => [...prev,
          `条件未达成 ${evo.skipped.length} 个(按进化前算):${evo.skipped.map(e => `${e.from}→${e.to}`).join('、')}`]);
      }
    } catch (e) {
      setReadLog([`读取失败:${(e as Error).message}`]);
    } finally {
      setReading(false);
    }
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
        groundCondition: plan.groundCondition,
        weather: plan.weather,
        season: plan.season,
        skills: plan.skills.map(s => {
          // 金技能的列表价已含前置价:把关系展开成 requires,优化器才不会重复计费
          const chain = plan.chains.find(c => c.skillId === s.id);
          const req = chain !== undefined && plan.skills.some(x => x.id === chain.prereqId)
            ? chain.prereqId
            : undefined;
          return {
            id: s.id,
            pt: s.pt,
            ...(req !== undefined ? { requires: req } : {}),
            // 进化方向也要一起传:进化是免费的,优化器会按进化后的数值算收益并择优
            ...(s.evolvesTo !== undefined ? { evolvesTo: s.evolvesTo } : {}),
            ...(s.evolveAlternatives !== undefined && s.evolveAlternatives.length > 0
              ? { evolveAlternatives: s.evolveAlternatives }
              : {}),
          };
        }),
      });
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const download = async () => {
    const text = exportPlan(plan);
    // 桌面版:交给 Python 弹系统保存对话框。WebView2 里 <a download> 会被静默丢掉,
    // 以前点「导出 JSON」其实什么都没落盘(用户问"导出的文件放哪儿了"就是这个)。
    if (bridge !== null) {
      try {
        const r = await bridge.save_plan(text);
        if (r.ok) setSaveNote(`已保存:${r.path ?? ''}`);
        else if (r.cancelled === true) setSaveNote('已取消保存');
        else setSaveNote(`保存失败:${r.error ?? '未知原因'}`);
      } catch (e) {
        setSaveNote(`保存失败:${(e as Error).message}`);
      }
      return;
    }
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'skill-plan.json';
    a.click();
    URL.revokeObjectURL(a.href);
    setSaveNote('已下载到浏览器的默认下载目录(skill-plan.json)');
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

          <div className="field row">
            <span>场地状态 / 天气 / 季节</span>
            <select value={plan.groundCondition} onChange={e => { patch({ groundCondition: Number(e.target.value) as GroundCondition }); setResult(null); }}>
              {GROUND_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <select value={plan.weather} onChange={e => { patch({ weather: Number(e.target.value) as Weather }); setResult(null); }}>
              {WEATHER_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
            <select value={plan.season} onChange={e => { patch({ season: Number(e.target.value) as Season }); setResult(null); }}>
              {SEASON_OPTIONS.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </div>
          <p className="field-note">场地状态会改变体力消耗;天气/季节只决定「晴天◎」「秋季优俊少女◎」这类绿技能与环境条件技能是否生效</p>
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
            {bridge && (
              <span className="device-picker">
                <select
                  value={serial ?? ''}
                  onChange={e => chooseDevice(e.target.value)}
                  disabled={reading || loadingDevices || devices.length === 0}
                  title="选择要读取的模拟器(序列号即 adb 的 主机:端口)"
                >
                  {devices.length === 0 && <option value="">{loadingDevices ? '正在查找设备…' : '未找到模拟器'}</option>}
                  {devices.map(d => (
                    <option key={d.serial} value={d.serial} disabled={d.state !== 'device'}>
                      {deviceLabel(d)}
                    </option>
                  ))}
                </select>
                <button className="mini" onClick={() => void refreshDevices(true)} disabled={reading || loadingDevices} title="重新扫描 5555/7555/16384 等常见模拟器端口">
                  {loadingDevices ? '…' : '刷新设备'}
                </button>
              </span>
            )}
            {bridge && (
              <button onClick={readFromEmulator} disabled={reading || serial === null}>
                {reading ? '读取中…' : '从模拟器读取'}
              </button>
            )}
            <button onClick={openFile}>导入 JSON</button>
            <button onClick={() => { void download(); }}>导出 JSON</button>
            {saveNote !== null && <span className="dim">{saveNote}</span>}
            <button onClick={() => { setPlan(importPlan(JSON.stringify(EXAMPLE))); setResult(null); setReadLog([]); }}>载入示例</button>
            <input ref={fileRef} type="file" accept=".json" hidden onChange={onFile} />
          </div>
          {readLog.length > 0 && (
            <ul className="read-log">
              {readLog.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          )}
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
              <tr><th>#</th><th>技能</th><th className="num">PT</th><th className="num">单独马身</th><th className="num">集内边际</th><th className="num">边际(秒)</th></tr>
            </thead>
            <tbody>
              {result.chosen.map((c, i) => (
                <tr key={c.id}>
                  <td>{i + 1}</td>
                  <td>
                    {c.name}
                    {c.filler === true && <span className="dim"> (凑数·花完PT)</span>}
                    {c.note !== undefined && <div className="dim">ⓘ {c.note}</div>}
                  </td>
                  <td className="num">{c.ptInferred === true ? `≈${c.pt}` : c.pt}</td>
                  <td className="num">
                    {c.soloUnavailable === true ? (
                      // 单独买不发动(要先有别的技能发动过)→ 0.00 会被读成"没收益",显示「—」
                      <span className="dim">—</span>
                    ) : c.evolvesTo !== null ? (
                      <>
                        {c.soloBodyBefore.toFixed(2)} → <b>{c.soloBody.toFixed(2)}</b>
                        {/* 用户要求的标注格式:进化后技能名(来源技能名+进化) */}
                        <div className="dim">{c.evolvesTo}（{c.name}进化）</div>
                        {c.evolveOptions !== undefined && c.evolveOptions.length > 1 && (
                          <div className="dim">
                            方向:{c.evolveOptions.map(o => `${o.name} ${o.soloBody.toFixed(2)}`).join(' / ')}
                          </div>
                        )}
                      </>
                    ) : c.soloBody.toFixed(2)}
                  </td>
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
                  <tr>
                    <th>技能</th><th className="num">PT</th><th className="num">单独马身</th><th>原因</th><th className="num">差PT</th>
                    {result.rejected.some(r => r.detail !== '') && <th>说明</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.rejected.map(r => (
                    <tr key={r.id}>
                      <td>
                        {r.name}
                        {r.evolvesTo != null && <span className="dim"> → {r.evolvesTo}</span>}
                      </td>
                      <td className="num">{r.ptInferred === true ? `≈${r.pt}` : r.pt}</td>
                      <td className="num">
                        {r.soloUnavailable === true ? <span className="dim">—</span> : r.soloBody.toFixed(2)}
                      </td>
                      <td>{REASON_LABEL[r.reason]}</td>
                      <td className="num">{r.reason === 'outbid' && r.missingPt > 0 ? r.missingPt : ''}</td>
                      {result.rejected.some(x => x.detail !== '') && <td className="dim">{r.detail}</td>}
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

      <p className="disclaimer">
        由 mioX 通过 AI 制作,仅供个人测试使用,非官方同人开源工具(GPL-3.0),与 Cygames/bilibili 无关;《赛马娘 Pretty Derby》名称与商标归各权利方所有。
        数据来源:公开解包数据与社区攻略资料整理;马身收益仅作技能购买参考。随机机制(随机位置发动/依赖他马等)按满足区段的期望值近似计算,近似项已在界面标注。
      </p>
    </div>
  );
}
