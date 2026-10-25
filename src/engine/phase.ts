import type { Course, PhaseId } from './types';

/** 位置 → 比赛阶段 */
export function phaseAt(course: Course, x: number): PhaseId {
  const b = course.phaseBounds;
  if (x >= b.finalStart) return 3;
  if (x >= b.lateStart) return 2;
  if (x >= b.midStart) return 1;
  return 0;
}
