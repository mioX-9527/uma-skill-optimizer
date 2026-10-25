import type { Course, SkillConfig } from './engine/index.js';
import coursesJson from '../data/courses.json';
import skillsJson from '../data/skills.json';

export interface SkillEntry extends SkillConfig {
  readonly nameJa?: string;
  readonly nameTrad?: string;
  readonly cnReleased?: boolean;
  readonly restrictionText?: string;
}

export const COURSES = coursesJson as unknown as Course[];
export const SKILLS = skillsJson as unknown as SkillEntry[];
