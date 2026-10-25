import { describe, expect, it } from 'vitest';
import { applyCapture, captureSummary, type CapturedSkill } from '../web/src/desktop.js';

const toSkill = (c: CapturedSkill) => (c.id === 'bad' ? null : { id: c.id, pt: c.pt });

describe('applyCapture', () => {
  it('用抓取结果替换候选列表', () => {
    const r = applyCapture(
      { skills: [{ id: 'old', pt: 1 }], budget: 500 },
      { ok: true, skills: [{ id: 'a', name: 'A', pt: 90 }, { id: 'b', name: 'B', pt: 130 }] },
      toSkill,
    );
    expect(r.skills).toEqual([{ id: 'a', pt: 90 }, { id: 'b', pt: 130 }]);
    expect(r.dropped).toBe(0);
  });

  it('识别到 PT 余额时覆盖预算', () => {
    const r = applyCapture({ skills: [], budget: 500 }, { ok: true, skills: [], pt_balance: 1830 }, toSkill);
    expect(r.budget).toBe(1830);
  });

  it('没识别到余额(0/null)时保留用户手填预算', () => {
    expect(applyCapture({ skills: [], budget: 500 }, { ok: true, skills: [], pt_balance: 0 }, toSkill).budget).toBe(500);
    expect(applyCapture({ skills: [], budget: 500 }, { ok: true, skills: [], pt_balance: null }, toSkill).budget).toBe(500);
  });

  it('对应不上技能库的条目被丢弃并计数', () => {
    const r = applyCapture(
      { skills: [], budget: 500 },
      { ok: true, skills: [{ id: 'a', name: 'A', pt: 90 }, { id: 'bad', name: '?', pt: 90 }] },
      toSkill,
    );
    expect(r.skills).toHaveLength(1);
    expect(r.dropped).toBe(1);
  });
});

describe('captureSummary', () => {
  it('失败时只给一行错误', () => {
    expect(captureSummary({ ok: false, error: '连不上模拟器' })).toEqual(['连不上模拟器']);
  });

  it('成功时给出数量/余额/停止原因/待确认', () => {
    const lines = captureSummary({
      ok: true, skills: [{ id: 'a', name: 'A', pt: 90 }], pt_balance: 1830,
      pages: 3, frames: 4, stop_reason: '到底了',
      needs_confirm: [{ row: '中距离直线', alternatives: ['中距离直线○', '中距离直线◎'] }],
    });
    const text = lines.join('\n');
    expect(text).toContain('1 个技能');
    expect(text).toContain('1830');
    expect(text).toContain('到底了');
    expect(text).toContain('需确认');
  });
});
