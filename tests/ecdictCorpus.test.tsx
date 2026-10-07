import {describe,it,expect,vi} from "vitest";
import {renderToStaticMarkup} from "react-dom/server";
import {csvRecords,dictionaryGlosses,buildEcdictCorpus,ECDICT_VERSION} from "../scripts/lib/ecdictCorpus.js";
import {FamilyMiniCard} from "../web/src/family/FamilyPanel.js";
import {getFamilyDictionary} from "../server/services/familyDictionary.js";
import {buildFamilyLesson} from "../server/services/familyLesson.js";
import type {FamilyNode,FamilyCandidate} from "../shared/familyContracts.js";
import type {SupabaseClient} from "@supabase/supabase-js";

const csv='word,phonetic,definition,translation,pos\nact,ækt,"n. a deed\\nv. perform","n. 行动, 行为\\nvi. 行动, 表演\\nvt. 扮演, 装作\\n[计] 自动代码翻译技术",\n';
const entry=()=>buildEcdictCorpus(csv,["act"]).dictionary_entries[0]!;
const node=(lemma="act",pos="v"):FamilyNode=>({lexeme_id:`en:${lemma}:${pos}`,lemma,language:"en",part_of_speech:pos,frequency_band:null,utility_score:.8,exam_relevance:.8,family_key:"act",
  senses:[{sense_id:`${lemma}-1`,lexeme_id:`en:${lemma}:${pos}`,definition:"perform an action",synset_id:null,register:null}],forms:[],user_state:null,priority:.8,reason:"形态派生关系"});

describe("Bilingual sourced dictionary knowledge",()=>{
  it("reads CSV quotes, commas, embedded newlines and BOM without executing content",()=>{
    expect([...csvRecords('\ufeffword,translation\r\nact,"a comma, and ""quote""\nsecond line"\r\n')]).toEqual([["word","translation"],["act",'a comma, and "quote"\nsecond line']]);
    expect(()=>[...csvRecords('word,"unclosed')]).toThrow("Unclosed");
  });
  it("retains all named POS including vt/vi and domain notes instead of only the graph POS",()=>{
    const e=entry();expect(e.parts_of_speech.map(g=>g.label)).toEqual(["n.","vi.","vt.",""]);
    expect(e.parts_of_speech.filter(g=>g.part_of_speech==="v").map(g=>g.definition_zh)).toEqual(["行动, 表演","扮演, 装作"]);
    expect(e.english_definition).toBe("n. a deed\nv. perform");
  });
  it("preserves English-only POS without guessing a Chinese sense alignment",()=>{
    const g=dictionaryGlosses("n. 行动","n. a deed\nv. perform");
    expect(g[1]).toEqual({label:"v.",part_of_speech:"v",definition_zh:null,definition_en:"perform"});
    expect(dictionaryGlosses("[网络] 一种东西","")[0]!.part_of_speech).toBeNull();
  });
  it("normalizes case/space duplicates while retaining original record evidence",()=>{
    const data=buildEcdictCorpus(csv+' ACT ,ækt,,"n. 法案",\n',[" act ","ACT"]);
    expect(data.dictionary_entries).toHaveLength(1);expect(data.report.requested).toBe(1);
    expect(data.dictionary_entries[0]!.provenance.records).toHaveLength(2);
    expect(data.dictionary_entries[0]!.chinese_translation).toContain("法案");
  });
  it("imports only requested dictionary facts with version/license/hash and never graph relations or cards",()=>{
    const data=buildEcdictCorpus(csv,["act","absent"],"fixture-hash");
    expect(data.report.missing).toEqual(["absent"]);expect(data).not.toHaveProperty("relations");expect(data).not.toHaveProperty("user_words");
    expect(entry().source_version).toBe(ECDICT_VERSION);expect(entry().license).toBe("MIT");
    expect(data.dictionary_entries[0]!.provenance.file_sha256).toBe("fixture-hash");
  });
  it("renders Chinese-first, full POS and every available English sense with source attribution",()=>{
    const n={...node(),dictionary:entry()};n.senses.push({...n.senses[0]!,sense_id:"act-2",definition:"behave in a certain manner"});
    const html=renderToStaticMarkup(<FamilyMiniCard node={n}/>);
    for(const text of ["词典释义","行动, 行为","vi.","vt.","英文释义","perform an action","behave in a certain manner","ECDICT","MIT","未学习"])expect(html).toContain(text);
    expect(html.indexOf("词典释义")).toBeLessThan(html.indexOf("英文释义"));
  });
  it("labels missing Chinese explicitly rather than generating it",()=>{
    const dict=entry();dict.chinese_translation="";dict.parts_of_speech=dictionaryGlosses("","v. perform");
    expect(renderToStaticMarkup(<FamilyMiniCard node={{...node(),dictionary:dict}}/>)).toContain("暂无中文释义");
  });
  it("uses Chinese only for the matching POS in productive recall, preserving source English context",()=>{
    const base=node("action","n"),target={...node("perform"),dictionary:{...entry(),lemma:"perform"}};
    const decision={candidate:target,eligible_now:true,stage:"B",relation:{morphology:"比较词性"}} as FamilyCandidate;
    const lesson=buildFamilyLesson({center:base,nodes:[base,target],edges:[],depth:1,truncated:false},decision);
    expect(lesson.steps.at(-1)!.prompt).toContain("行动, 表演；扮演, 装作");
    expect(lesson.steps.at(-1)!.prompt).not.toContain("自动代码");expect(lesson.steps.at(-1)!.prompt).not.toContain("a deed");
  });
  it("bounds and canonicalizes dictionary reads, with honest empty/error results",async()=>{
    const query:any={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),order:vi.fn().mockReturnThis(),limit:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:entry(),error:null})};
    const db={from:vi.fn(()=>query)} as unknown as SupabaseClient;
    expect((await getFamilyDictionary(" ACT ",db))!.lemma).toBe("act");expect(query.eq).toHaveBeenCalledWith("lemma","act");expect(query.limit).toHaveBeenCalledWith(1);
    query.maybeSingle.mockResolvedValue({data:null,error:null});expect(await getFamilyDictionary("missing",db)).toBeNull();
    query.maybeSingle.mockResolvedValue({data:null,error:{code:"42P01"}});await expect(getFamilyDictionary("act",db)).rejects.toMatchObject({status:503,code:"FAMILY_DICTIONARY_UNAVAILABLE"});
  });
  it("can stabilize a base from sourced Chinese even when WordNet senses are absent",()=>{
    const base={...node("perform"),senses:[],dictionary:{...entry(),lemma:"perform"}};
    const lesson=buildFamilyLesson({center:base,nodes:[base],edges:[],depth:1,truncated:false},{candidate:null,relation:null,reason:"先巩固",eligible_now:false,stage:"A",utility:null});
    expect(lesson.stage).toBe("A");expect(lesson.target_id).toBeNull();expect(lesson.steps).toHaveLength(2);expect(lesson.steps[0]!.prompt).toContain("行动, 表演");
  });
});
