import { describe, it, expect } from 'vitest';
import { mergeMissingFields, derivationHeadword, recallCue } from '../scripts/complete-anki-lesson-batches.js';

describe('private batch boundaries',()=>{
  it('removes English answer labels from recall cues while preserving the original sense',()=>{
    const sense='n. 账户；解释；（account for）占据；说明原因';
    expect(recallCue(sense)).not.toMatch(/account/i);
    expect(recallCue(sense)).toContain('说明原因');
    expect(sense).toContain('account for');
    expect(()=>recallCue('account for')).toThrow('WORD_RECALL_CUE_UNAVAILABLE');
  });
  it('keeps valid Anki text and rejects any model attempt to overwrite it',()=>{
    const base={meaning_zh:'分配',example_en:'An existing licensed example.'};
    expect(mergeMissingFields(base,{note:'用法提示'},['note'])).toEqual({...base,note:'用法提示'});
    expect(()=>mergeMissingFields(base,{meaning_zh:'另一解释',note:'提示'},['note'])).toThrow('GENERATED_TRUSTED_FIELD_OVERWRITE');
  });
  it('extracts lexical forms for dictionary verification without treating labels as words',()=>{
    expect(derivationHeadword('allocation n.（分配）')).toBe('allocation');
    expect(derivationHeadword('well-being n.（幸福）')).toBe('well-being');
    expect(derivationHeadword('词形来源：词典')).toBeNull();
  });
});
