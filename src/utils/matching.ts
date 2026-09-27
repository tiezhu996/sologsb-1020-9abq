import type { ArchiveRecord, FieldKey, MatchCandidate } from '../types';

const normalize = (value: string) => value.toLowerCase().replace(/[\s·,，。:：;；()（）\-_/]/g, '');
const chars = (value: string) => {
  const text = normalize(value);
  if (text.length < 2) return [text];
  return Array.from({ length: text.length - 1 }, (_, index) => text.slice(index, index + 2));
};
const dice = (left: string, right: string) => {
  const a = chars(left);
  const b = chars(right);
  if (!a.length || !b.length) return 0;
  const remaining = [...b];
  let hits = 0;
  a.forEach((item) => {
    const index = remaining.indexOf(item);
    if (index >= 0) { hits += 1; remaining.splice(index, 1); }
  });
  return (2 * hits) / (a.length + b.length);
};
const jaccard = (left: string[], right: string[]) => {
  const a = new Set(left.map(normalize));
  const b = new Set(right.map(normalize));
  if (!a.size && !b.size) return 1;
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  a.forEach((item) => { if (b.has(item)) intersection += 1; });
  return intersection / (a.size + b.size - intersection);
};
const exactish = (left: string, right: string) => {
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length) + 0.15;
  return dice(a, b);
};
const displayValue = (record: ArchiveRecord, field: FieldKey) => {
  const value = record[field];
  return Array.isArray(value) ? value.join('、') : String(value);
};

export function scorePair(left: ArchiveRecord, right: ArchiveRecord) {
  const fieldScores: Record<FieldKey, number> = {
    title: exactish(left.title, right.title),
    date: exactish(left.date, right.date),
    people: jaccard(left.people, right.people),
    places: jaccard(left.places, right.places),
    identifier: exactish(left.identifier, right.identifier),
    medium: exactish(left.medium, right.medium),
    extent: exactish(left.extent, right.extent),
    rights: exactish(left.rights, right.rights),
    notes: exactish(left.notes, right.notes)
  };
  const score = fieldScores.title * .3 + fieldScores.date * .2 + fieldScores.people * .2 + fieldScores.places * .14 + fieldScores.identifier * .16;
  const reasons: string[] = [];
  if (fieldScores.identifier > .8) reasons.push('编号高度一致');
  if (fieldScores.title > .58) reasons.push('标题相似');
  if (fieldScores.date > .9) reasons.push('日期一致');
  if (fieldScores.people > .8) reasons.push('人物一致');
  if (fieldScores.places > .6) reasons.push('地点相近');
  if (!reasons.length) reasons.push('组合字段达到匹配阈值');
  return { score: Math.min(1, score), fieldScores, reasons };
}

export function computeMatches(records: ArchiveRecord[]): MatchCandidate[] {
  // 已合并的记录退出匹配，避免合并结果又与其他记录生成新候选、重新进入待复核队列
  const active = records.filter((record) => record.status !== 'merged');
  const left = active.filter((record) => record.group === 'A');
  const right = active.filter((record) => record.group === 'B');
  const matches: MatchCandidate[] = [];
  left.forEach((a) => {
    const candidates = right.map((b) => ({ record: b, ...scorePair(a, b) }))
      .filter((item) => item.score >= .38)
      .sort((x, y) => y.score - x.score)
      .slice(0, 4);
    candidates.forEach((candidate) => {
      matches.push({
        id: `match-${a.id}-${candidate.record.id}`,
        leftId: a.id,
        rightId: candidate.record.id,
        score: candidate.score,
        fieldScores: candidate.fieldScores,
        status: 'suggested',
        reasons: candidate.reasons
      });
    });
  });
  return matches.sort((a, b) => b.score - a.score);
}

export function fieldValue(record: ArchiveRecord, field: FieldKey): string {
  return displayValue(record, field);
}

const pairKey = (leftId: string, rightId: string) => `${leftId}|${rightId}`;

/**
 * 在当前记录上重新计算候选匹配，但保留同一对记录已有的复核结论
 * （已确认 / 已忽略 / 已合并）。只有此前从未出现过的组合才是新的待复核项；
 * 因合并等原因不再参与计算的旧组合也原样保留其结论，不回到待复核队列。
 */
export function reconcileMatches(prev: MatchCandidate[], records: ArchiveRecord[]): MatchCandidate[] {
  const decisions = new Map<string, { status: MatchCandidate['status']; reviewedAt?: string }>();
  prev.forEach((match) => {
    if (match.status !== 'suggested') {
      decisions.set(pairKey(match.leftId, match.rightId), { status: match.status, reviewedAt: match.reviewedAt });
    }
  });

  const fresh = computeMatches(records);
  const seen = new Set<string>();
  const next: MatchCandidate[] = fresh.map((candidate) => {
    const key = pairKey(candidate.leftId, candidate.rightId);
    seen.add(key);
    const kept = decisions.get(key);
    return kept ? { ...candidate, status: kept.status, reviewedAt: kept.reviewedAt } : candidate;
  });

  // 保留新计算中不再出现（如超出候选上限或记录已被合并移除）但既往已有结论的组合
  prev.forEach((match) => {
    const key = pairKey(match.leftId, match.rightId);
    if (seen.has(key)) return;
    seen.add(key);
    next.push(match);
  });

  return next.sort((a, b) => b.score - a.score);
}
