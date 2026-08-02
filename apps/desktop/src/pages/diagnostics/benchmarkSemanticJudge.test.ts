import { describe, expect, it } from 'vitest';
import { parseBenchmarkJudgeJson } from './benchmarkSemanticJudge';

describe('parseBenchmarkJudgeJson', () => {
  it('accepts fenced JSON and clamps scores to the supported range', () => {
    expect(parseBenchmarkJudgeJson('```json\n{"score": 120, "rationale": "完整"}\n```')).toEqual({ score: 100, rationale: '完整' });
  });

  it('finds the final score object after provider reasoning text', () => {
    expect(parseBenchmarkJudgeJson('先分析：{不是最终结果}\n最终结果：{"score": 82, "rationale": "数字基本保留"}')).toEqual({
      score: 82,
      rationale: '数字基本保留',
    });
  });

  it('rejects responses without a numeric score', () => {
    expect(() => parseBenchmarkJudgeJson('没有 JSON 结果')).toThrow();
    expect(() => parseBenchmarkJudgeJson('{"rationale":"缺少分数"}')).toThrow();
  });
});
