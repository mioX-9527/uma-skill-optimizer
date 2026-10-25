/** 名称归一化:去空白、小写、去末尾 m(便于「东京草2400」↔「东京 草 2400m」) */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[ｍm]+$/, '');
}

export interface MatchResult<T> {
  readonly value?: T;
  readonly matches: readonly T[];
  readonly kind: 'id' | 'exact' | 'fuzzy';
}

/** 按 id / 精确名 / 包含名 查找;返回唯一命中或全部候选(供报错提示) */
export function lookup<T extends { id: string }>(
  items: readonly T[],
  getNames: (item: T) => readonly string[],
  query: string,
): MatchResult<T> {
  const byId = items.find(x => x.id === query);
  if (byId) return { value: byId, matches: [byId], kind: 'id' };

  const q = normalizeName(query);
  const all = items.flatMap(x => getNames(x).map(n => ({ x, n })));
  const exact = all.filter(({ n }) => normalizeName(n) === q);
  if (exact.length > 0) {
    const uniq = [...new Set(exact.map(({ x }) => x))];
    return uniq.length === 1
      ? { value: uniq[0], matches: uniq, kind: 'exact' }
      : { matches: uniq, kind: 'exact' };
  }
  const fuzzy = all.filter(({ n }) => normalizeName(n).includes(q));
  const uniq = [...new Set(fuzzy.map(({ x }) => x))];
  return { matches: uniq, kind: 'fuzzy' };
}
