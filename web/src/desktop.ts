/**
 * 桌面壳(pywebview)桥接。
 *
 * 约定:网页版是纯前端,`file://` 下调不到 adb。只有被 pywebview 装进窗口时,
 * `window.pywebview.api` 才存在——前端据此决定要不要显示「从模拟器读取」按钮。
 * 所以这部分代码必须在没有壳的情况下**完全惰性**:不引用、不报错、按钮不出现。
 */

export interface CapturedSkill {
  readonly id: string;
  readonly name: string;
  readonly pt: number;
}

/**
 * 一条「可进化」关系(从游戏里点开「进化 ⓘ」弹窗读到)。
 *
 * 进化后的技能**不在候选列表里** —— 它是金技能达成条件后**免费**变来的,不用单独买。
 * 所以必须单独传:只发候选技能的话,优化器只会按进化前的数值算,用户看到的就是
 * 「怎么还是只有迅速果断」。一个技能可能有多条进化方向,每条一行。
 */
export interface EvolutionRow {
  readonly fromId: string;
  readonly from: string;
  readonly toId: string;
  readonly to: string;
  /** 本局条件是否达成;false 也要列出来(说明"有这个方向但本局不行") */
  readonly conditionMet: boolean;
}

export interface CaptureResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: string;
  readonly skills?: readonly CapturedSkill[];
  /** 下位技能关系(金技能的列表价已含前置价),两端都在 skills 里才有效 */
  readonly chains?: readonly { skillId: string; prereqId: string }[];
  /** 进化关系;conditionMet=true 的会参与择优 */
  readonly evolutions?: readonly EvolutionRow[];
  readonly pt_balance?: number | null;
  readonly pages?: number;
  readonly frames?: number;
  readonly stop_reason?: string;
  readonly needs_confirm?: readonly { row: string; alternatives: readonly string[] }[];
  readonly warnings?: readonly string[];
}

export interface DesktopBridge {
  /** 列 adb 设备(force=true 会去扫一遍常见模拟器端口,模拟器刚启动时用) */
  devices(force?: boolean): Promise<DeviceResponse>;
  doctor(serial?: string): Promise<{ ok: boolean; serial?: string; size?: [number, number]; calibrated?: boolean; error?: string }>;
  /** 逐屏读取技能列表;serial 不传时后端按「前台是赛马娘」自动挑 */
  capture_skills(serial?: string): Promise<CaptureResponse>;
  save_plan(path?: string): Promise<{ ok: boolean; path?: string; count?: number; error?: string }>;
}

/** 一台 adb 设备(下拉框一项) */
export interface AdbDevice {
  readonly serial: string;
  /** adb 的连接状态:`device` 可用 / `offline` 掉线 / `unauthorized` 没点授权 */
  readonly state: string;
  readonly model?: string;
  /** 设备唯一序列号;同一台模拟器常同时挂在 `127.0.0.1:5555` 和 `emulator-5554` 下,后端据此去重 */
  readonly serialno?: string;
  readonly size?: string;
  readonly foreground?: string | null;
  /** 前台应用的中文名(认得出来才有,认不出就是包名) */
  readonly app?: string;
  /** 前台是不是赛马娘 —— 多模拟器共存时这是唯一可靠的判断 */
  readonly isUma?: boolean;
  readonly error?: string;
}

export interface DeviceResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: string;
  readonly devices?: readonly AdbDevice[];
  /** 后端推荐的序列号(前台是赛马娘的那台) */
  readonly recommended?: string | null;
}

/** 下拉框里一行文字:`序列号 · 机型 · 分辨率 · 前台应用` */
export function deviceLabel(d: AdbDevice): string {
  const parts = [d.serial];
  if (d.model) parts.push(d.model);
  if (d.size) parts.push(d.size);
  if (d.state !== 'device') parts.push(d.state === 'unauthorized' ? '未授权' : '未连接');
  else if (d.isUma) parts.push('★ 赛马娘');
  else if (d.app) parts.push(d.app);
  return parts.join(' · ');
}

/** 从设备列表里挑默认选中项:存过的 > 后端推荐 > 第一台在线 */
export function pickDevice(devices: readonly AdbDevice[], remembered: string | null): string | null {
  if (remembered && devices.some(d => d.serial === remembered && d.state === 'device')) return remembered;
  const online = devices.filter(d => d.state === 'device');
  const rec = online.find(d => d.isUma) ?? online[0];
  return rec?.serial ?? null;
}

/** 拿到桌面壳的 API;不在壳里就返回 null(单文件版/普通浏览器)。 */
export function desktopBridge(): DesktopBridge | null {
  const w = window as unknown as { pywebview?: { api?: DesktopBridge } };
  return w.pywebview?.api ?? null;
}

/**
 * 等桌面壳就绪。
 *
 * **不能只在首帧读一次** `window.pywebview` —— pywebview 是在页面加载完之后才注入这个对象的
 * (实测 0.5s 时已有,但 React 首帧比它早),首帧读到 null 就再也不会更新,
 * 结果窗口打开了却没有「从模拟器读取」按钮。
 *
 * 双保险:监听官方 `pywebviewready` 事件 + 100ms 轮询兜底(有些版本/后端不触发事件)。
 * 返回取消函数,组件卸载时调用。
 */
export function waitForDesktopBridge(onReady: (b: DesktopBridge) => void): () => void {
  let done = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;

  const check = () => {
    if (done) return true;
    const b = desktopBridge();
    if (b === null) return false;
    done = true;
    if (timer !== undefined) clearInterval(timer);
    if (giveUp !== undefined) clearTimeout(giveUp);
    onReady(b);
    return true;
  };

  const onEvent = () => { check(); };

  if (!check()) {
    window.addEventListener('pywebviewready', onEvent);
    timer = setInterval(check, 100);
    giveUp = setTimeout(() => { if (timer !== undefined) clearInterval(timer); }, 5000);
  }

  return () => {
    window.removeEventListener('pywebviewready', onEvent);
    if (timer !== undefined) clearInterval(timer);
    if (giveUp !== undefined) clearTimeout(giveUp);
  };
}

/** 把抓到的技能并进计划:替换候选列表、用 OCR 到的 PT 余额当预算(有才覆盖)。 */
export function applyCapture<T>(
  current: { skills: readonly T[]; budget: number },
  resp: CaptureResponse,
  toSkill: (c: CapturedSkill) => T | null,
): { skills: T[]; budget: number; dropped: number } {
  const converted = (resp.skills ?? []).map(toSkill);
  const skills = converted.filter((s): s is T => s !== null);
  return {
    skills,
    // pt_balance 可能是 0(没识别到),此时保留用户手填的预算
    budget: resp.pt_balance && resp.pt_balance > 0 ? resp.pt_balance : current.budget,
    dropped: converted.length - skills.length,
  };
}

/**
 * 把 `evolutions` 挂到对应的候选技能上。
 *
 * 只认 `conditionMet=true` 的方向 —— 条件没达成的话这局变不了,按进化后数值算会高估。
 * 但**记账要留痕**:返回 `skipped`,前端可以提示"这个技能有进化方向,但本局条件没达成",
 * 否则用户只会看到"进化后的技能没出现"。
 */
export function applyEvolutions<T extends { id: string; evolvesTo?: string; evolveAlternatives?: readonly string[] }>(
  skills: readonly T[],
  evolutions: readonly EvolutionRow[] | undefined,
): { skills: T[]; evolved: EvolutionRow[]; skipped: EvolutionRow[] } {
  const met = (evolutions ?? []).filter(e => e.conditionMet);
  const skipped = (evolutions ?? []).filter(e => !e.conditionMet);
  const byFrom = new Map<string, EvolutionRow[]>();
  for (const e of met) {
    const list = byFrom.get(e.fromId) ?? [];
    list.push(e);
    byFrom.set(e.fromId, list);
  }
  const out = skills.map(s => {
    const list = byFrom.get(s.id);
    if (list === undefined || list.length === 0) return s;
    const ids = list.map(e => e.toId).filter((id, i, a) => a.indexOf(id) === i);
    return { ...s, evolvesTo: ids[0], evolveAlternatives: ids.slice(1) };
  });
  return { skills: out, evolved: met, skipped };
}

/** 把抓取结果整理成人能读的几行提示。 */
export function captureSummary(resp: CaptureResponse): string[] {
  if (!resp.ok) return [resp.error ?? "读取失败"];
  const out: string[] = [];
  out.push(`读到 ${resp.skills?.length ?? 0} 个技能(${resp.pages ?? 0} 屏 / ${resp.frames ?? 0} 帧)`);
  if (resp.pt_balance) out.push(`PT 余额 ${resp.pt_balance}`);
  if (resp.stop_reason) out.push(`停止原因:${resp.stop_reason}`);
  for (const n of resp.needs_confirm ?? []) out.push(`需确认:${n.row}`);
  for (const w of resp.warnings ?? []) out.push(`注意:${w}`);
  return out;
}
