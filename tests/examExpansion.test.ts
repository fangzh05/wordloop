import {it,expect} from 'vitest';
import {normalizeCandidate,validateJudgments,advisoryAllowsKeep,reviewKey,candidateReasons,buildFormEvidence} from '../scripts/lib/examExpansion.js';
it('normalizes input without changing global identity rules',()=>{expect(normalizeCandidate('\uFEFF  AcadeMIC  ')).toBe('academic');expect(normalizeCandidate('cafe\u0301')).toBe('café');});
it('model cannot approve a derivational merge or an inflection deletion',()=>{
 const j={original:'economic',suggested_lemma:'economical',decision:'spelling_variant' as const,part_of_speech:'adjective',exam_relevance:'supported' as const,confidence:1,reason:'incorrect suggestion',requires_review:false};
 expect(advisoryAllowsKeep('economic',j)).toBe(false);expect(advisoryAllowsKeep('affect',{...j,original:'affect',suggested_lemma:'effect'})).toBe(false);
});
it('rejects illegal JSON, missing candidates and extra fields',()=>{expect(()=>validateJudgments('not json',['a'])).toThrow();expect(()=>validateJudgments([],['a'])).toThrow();expect(()=>validateJudgments([{original:'a',decision:'merge'}],['a'])).toThrow();});
it('cache identity is stable and batch-sensitive',()=>{expect(reviewKey(['a','b'])).toBe(reviewKey(['a','b']));expect(reviewKey(['a','b'])).not.toBe(reviewKey(['a']));});
it('inflection analysis is only a hint and does not merge derived identities',()=>{expect(candidateReasons('activities',new Set(['activity']))).toContain('possible_inflection:activity');expect(candidateReasons('analysis',new Set(['analyse','analyst']))).toEqual([]);});
it('finds irregular forms only from explicit ECDICT form evidence',()=>{const forms=buildFormEvidence('word,exchange\nshrink,p:shrank/d:shrunk\nanalyse,i:analysing\n',new Set(['shrank','analysis']));expect([...forms.get('shrank')!]).toEqual(['shrink']);expect(forms.has('analysis')).toBe(false);});
