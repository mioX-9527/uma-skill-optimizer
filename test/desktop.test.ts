import { describe, expect, it } from 'vitest';
import {
  applyCapture, captureSummary, deviceLabel, pickDevice, type AdbDevice, type CapturedSkill,
} from '../web/src/desktop.js';

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

  it('购物车不干净时立刻警告:读到的价是「还需」不是原价', () => {
    const lines = captureSummary({
      ok: true, skills: [{ id: 'a', name: 'A', pt: 90 }], pt_balance: 2761, cart_dirty: true,
    });
    const text = lines.join('\n');
    expect(text).toContain('还需');
    expect(text).toContain('重置');
    // 干净的读取不该冒出这条(否则用户会以为坏了)
    expect(captureSummary({ ok: true, skills: [], cart_dirty: false }).join('\n')).not.toContain('重置');
  });
});

/**
 * 多模拟器共存时的设备选择。
 *
 * 踩过:默认写死 `127.0.0.1:5555`,那天 5555 其实被 MuMu 占着(前台碧蓝航线),
 * 用户在雷电里开赛马娘 → 读到的是横屏的碧蓝航线界面 → 「读取不了」。
 * 所以下拉框要能把「哪台开着赛马娘」直接写脸上。
 */
describe('deviceLabel', () => {
  const base: AdbDevice = { serial: '127.0.0.1:5555', state: 'device', model: 'PHM110', size: '720x1280' };

  it('前台是赛马娘时标出来', () => {
    const label = deviceLabel({ ...base, foreground: 'com.bilibili.umamusu', app: '赛马娘', isUma: true });
    expect(label).toContain('127.0.0.1:5555');
    expect(label).toContain('720x1280');
    expect(label).toContain('赛马娘');
  });

  it('前台是别的游戏时显示那个游戏名', () => {
    const label = deviceLabel({ ...base, foreground: 'com.bilibili.azurlane', app: '碧蓝航线' });
    expect(label).toContain('碧蓝航线');
  });

  it('掉线/未授权不显示成"能用"', () => {
    expect(deviceLabel({ serial: '127.0.0.1:7555', state: 'offline' })).toContain('未连接');
    expect(deviceLabel({ serial: '127.0.0.1:7555', state: 'unauthorized' })).toContain('未授权');
  });
});

describe('pickDevice', () => {
  const uma: AdbDevice = { serial: '127.0.0.1:16384', state: 'device', isUma: true };
  const azur: AdbDevice = { serial: '127.0.0.1:5555', state: 'device' };
  const dead: AdbDevice = { serial: '127.0.0.1:7555', state: 'offline' };

  it('没有记忆时优先挑开着赛马娘的那台', () => {
    expect(pickDevice([azur, uma, dead], null)).toBe('127.0.0.1:16384');
  });

  it('记忆的设备本身是赛马娘时优先用它(尊重用户上次的选择)', () => {
    expect(pickDevice([azur, uma], '127.0.0.1:16384')).toBe('127.0.0.1:16384');
  });

  // 真机踩出来的:5555 昨天是雷电,今天被 MuMu 抢走了(端口冲突)。如果盲目沿用记住的
  // 序列号,就会一直去读 MuMu 的画面,用户看到的是"读取失败"而雷电里明明开着游戏。
  it('记忆的设备在线但前台不是赛马娘时,让位给开着赛马娘的那台', () => {
    expect(pickDevice([azur, uma], '127.0.0.1:5555')).toBe('127.0.0.1:16384');
  });

  it('记忆的设备掉线了就不能再用', () => {
    expect(pickDevice([azur, dead], '127.0.0.1:7555')).toBe('127.0.0.1:5555');
  });

  it('一台在线的都没有时返回 null', () => {
    expect(pickDevice([dead], null)).toBeNull();
  });
});
