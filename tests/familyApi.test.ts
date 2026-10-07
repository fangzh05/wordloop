import { beforeEach, describe, it, expect, vi } from "vitest";
const mocks=vi.hoisted(()=>({graph:vi.fn(),candidate:vi.fn(),start:vi.fn(),answer:vi.fn(),save:vi.fn(),resume:vi.fn(),dictionary:vi.fn()}));
vi.mock("../server/services/familyDictionary.js",()=>({getFamilyDictionary:mocks.dictionary}));
vi.mock("../server/services/familyGraph.js",async (original)=>({
  ...await original<typeof import("../server/services/familyGraph.js")>(),getFamilyGraph:mocks.graph,getFamilyCandidate:mocks.candidate,
  startFamilyMicroSession:mocks.start,submitFamilyStep:mocks.answer,addFamilyCandidate:mocks.save,getFamilyMicroSession:mocks.resume,
}));
import { handleWebApiRequest } from "../server/webApi.js";
import { configureRuntimeEnv, getAuthenticatedUserId, resetDatabaseForTests } from "../server/db.js";
const user="00000000-0000-4000-8000-000000000001";
beforeEach(()=>{ vi.clearAllMocks(); resetDatabaseForTests(); configureRuntimeEnv({DEV_USER_ID:user,WORDLOOP_WEB_TOKEN:"family-test-local-token",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"dummy-test-only-key-not-real"}); });
function req(path:string,body?:unknown,auth=true) { return new Request(`https://wordloop.test/api/web/family/${path}`,{method:body?"POST":"GET",headers:{...(auth?{authorization:"Bearer family-test-local-token"}:{}),"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})}); }
describe("Family authenticated Web API",()=>{
  it("authenticates lazy dictionary reads and rejects identity/unknown payload fields",async()=>{
    expect((await handleWebApiRequest(req("dictionary?lemma=act",undefined,false))).status).toBe(401);
    expect(mocks.dictionary).not.toHaveBeenCalled();
    expect((await handleWebApiRequest(req("dictionary?lemma=act&user_id=other"))).status).toBe(400);
    expect((await handleWebApiRequest(req("dictionary?lemma="))).status).toBe(400);
    mocks.dictionary.mockResolvedValue({lemma:"act",chinese_translation:"行动"});
    const result=await handleWebApiRequest(req("dictionary?lemma=act"));expect(result.status).toBe(200);expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({lemma:"act",chinese_translation:"行动"});expect(mocks.dictionary).toHaveBeenCalledWith("act");
  });
  it("requires authentication before graph/learner reads",async()=>{ expect((await handleWebApiRequest(req("graph?lexeme=act",undefined,false))).status).toBe(401); expect(mocks.graph).not.toHaveBeenCalled(); });
  it("rejects depth escalation and client user identity",async()=>{
    expect((await handleWebApiRequest(req("graph?lexeme=act&depth=2"))).status).toBe(400);
    expect((await handleWebApiRequest(req("graph?lexeme=act&user_id=someone"))).status).toBe(400);
    expect(mocks.graph).not.toHaveBeenCalled();
  });
  it("routes graph expansion under verified server identity",async()=>{
    mocks.graph.mockImplementation(async()=>({user:getAuthenticatedUserId(),depth:1}));
    const r=await handleWebApiRequest(req("expand?lexeme=en%3Aact%3Av&depth=1"));
    expect(await r.json()).toEqual({user,depth:1}); expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("does not accept all-family activation or source-truth relation writes",async()=>{
    expect((await handleWebApiRequest(req("start",{lexeme:"act",request_id:crypto.randomUUID(),activate_all:true}))).status).toBe(400);
    expect((await handleWebApiRequest(req("relations",{relation_type:"DERIVATION"}))).status).toBe(404);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("uses narrow, separate candidate and micro-session requests",async()=>{
    mocks.save.mockResolvedValue({saved:true}); mocks.start.mockResolvedValue({id:"micro"}); mocks.answer.mockResolvedValue({index:1});
    expect((await handleWebApiRequest(req("candidates",{lexeme_id:"en:persuasion:n"}))).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith("en:persuasion:n");
    const key=crypto.randomUUID(); await handleWebApiRequest(req("start",{lexeme:"persuade",request_id:key}));
    expect(mocks.start).toHaveBeenCalledWith("persuade",key);
    await handleWebApiRequest(req("answer",{session_id:key,index:0,answer:"n"})); expect(mocks.answer).toHaveBeenCalledWith(key,0,"n");
  });
});
