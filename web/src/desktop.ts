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

export interface CaptureResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: string;
  readonly skills?: readonly CapturedSkill[];
  /** 下位技能关系(金技能的列表价已含前置价),两端都在 skills 里才有效 */
  readonly chains?: readonly { skillId: string; prereqId: string }[];
  readonly pt_balance?: number | null;
  readonly pages?: number;
  readonly frames?: number;
  readonly stop_reason?: string;
  readonly needs_confirm?: readonly { row: string; alternatives: readonly string[] }[];
  readonly warnings?: readonly string[];
}

export interface DesktopBridge {
  doctor(): Promise<{ ok: boolean; size?: [number, number]; calibrated?: boolean; error?: string }>;
  capture_skills(): Promise<CaptureResponse>;
  save_plan(path?: string): Promise<{ ok: boolean; path?: string; count?: number; error?: string }>;
}

/** 拿到桌面壳的 API;不在壳里就返回 null(单文件版/普通浏览器)。 */
export function desktopBridge(): DesktopBridge | null {
  const w = window as unknown as { pywebview?: { api?: DesktopBridge } };
  return w.pywebview?.api ?? null;
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
