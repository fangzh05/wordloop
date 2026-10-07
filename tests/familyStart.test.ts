import {beforeEach,describe,expect,it,vi} from "vitest";
import type {FamilyNode} from "../shared/familyContracts.js";
const fixture=vi.hoisted(()=>({dictionary:null as unknown,rpcError:null as unknown,rpc:vi.fn(),from:vi.fn()}));
vi.mock("../server/db.js",()=>({getAuthenticatedUserId:()=>"fixture-user",getDatabase:()=>({rpc:fixture.rpc,from:fixture.from})}));
import {startFamilyMicroSession} from "../server/services/familyGraph.js";
const base:FamilyNode={lexeme_id:"en:perform:v",lemma:"perform",language:"en",part_of_speech:"v",frequency_band:null,utility_score:.8,exam_relevance:.8,family_key:"perform",senses:[],forms:[],priority:.8,reason:"current",
  user_state:{status:"unknown",stability:1,reps:1,consecutive_correct:1,next_review_at:null,error_layers:[],layers:Object.fromEntries(["meaning","spelling","pronunciation","collocation","grammar"].map(k=>[k,{needs_practice:false,correct_streak:null}])) as NonNullable<FamilyNode["user_state"]>["layers"]}};
beforeEach(()=>{
  fixture.dictionary={entry_id:"dictionary:perform",lemma:"perform",language:"en",phonetic:null,english_definition:"",chinese_translation:"v. 执行；表演",parts_of_speech:[{label:"v.",part_of_speech:"v",definition_zh:"执行；表演",definition_en:null}],source:"ECDICT",source_version:"fixture",license:"MIT",provenance:{record_number:2},confidence:.9};
  fixture.rpcError=null;fixture.rpc.mockReset();fixture.from.mockReset();
  fixture.from.mockImplementation((table:string)=>{const chain:any={};for(const method of ["select","eq","is","order","limit"])chain[method]=()=>chain;chain.maybeSingle=async()=>({data:table==="study_sessions"?{id:"fixture-study"}:table==="lexical_dictionary_entries"?fixture.dictionary:null,error:null});return chain;});
  fixture.rpc.mockImplementation(async(name:string,args:any)=>name==="get_family_graph_v1"?{data:{center_id:base.lexeme_id,nodes:[structuredClone(base)],edges:[],exposures:[],truncated:false,has_developing_member:false},error:null}:{data:{id:"fixture-micro",lesson:args.p_lesson,index:0,completed:false,activated:false,feedback:null},error:fixture.rpcError});
});
describe("Current-word consolidation start",()=>{
  it("starts a sourced Chinese Stage A course even when OEWN senses are absent, with no derivative activation",async()=>{
    const result=await startFamilyMicroSession("perform","fixture-request");
    expect(result.stage).toBe("A");expect(result.step?.prompt).toContain("执行；表演");expect(result.step).not.toHaveProperty("answer");
    const payload=fixture.rpc.mock.calls.find(c=>c[0]==="start_family_micro_v1")![1].p_lesson;
    expect(payload.target_id).toBeNull();expect(payload.steps).toHaveLength(2);
    expect(fixture.from.mock.calls.map(c=>c[0])).not.toContain("user_words");
  });
  it("reports missing content honestly instead of repeating the candidate recommendation",async()=>{
    fixture.dictionary=null;
    await expect(startFamilyMicroSession("perform","fixture-request")).rejects.toMatchObject({code:"FAMILY_CONTENT_UNAVAILABLE",message:expect.stringContaining("缺少可用释义")});
    expect(fixture.rpc.mock.calls.some(c=>c[0]==="start_family_micro_v1")).toBe(false);
  });
  it("preserves the existing daily budget rejection with a useful explanation",async()=>{
    fixture.rpcError={message:"FAMILY_BUDGET_REACHED"};
    await expect(startFamilyMicroSession("perform","fixture-request")).rejects.toMatchObject({status:409,code:"FAMILY_BUDGET_REACHED",message:"今日学习预算已用完。"});
  });
});
