/** 终端对齐辅助:按显示宽度(中日韩全角按 2)计算 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F\u4E00-\u9FFF]/.test(ch) ? 2 : 1;
  return w;
}

export function padEndW(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}

export function padStartW(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s;
}

export function fmtBody(v: number): string {
  return (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));
}

/** CJK 表格行 */
export function tableRow(cols: readonly string[], widths: readonly number[], aligns: readonly ('left' | 'right')[]): string {
  return cols
    .map((c, i) => {
      const w = widths[i] ?? 0;
      return aligns[i] === 'right' ? padStartW(c, w) : padEndW(c, w);
    })
    .join('  ')
    .trimEnd();
}
