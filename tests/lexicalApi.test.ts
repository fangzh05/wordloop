import { beforeEach,describe,it,expect,vi } from "vitest";
const mocks=vi.hoisted(()=>({graph:vi.fn()}));
vi.mock("../server/services/lexicalGraph.js",()=>({getLexicalGraph:mocks.graph}));
import { handleWebApiRequest } from "../server/webApi.js";
import { configureRuntimeEnv,getAuthenticatedUserId,resetDatabaseForTests } from "../server/db.js";
beforeEach(()=>{vi.clearAllMocks();resetDatabaseForTests();configureRuntimeEnv({DEV_USER_ID:"00000000-0000-4000-8000-000000000001",WORDLOOP_WEB_TOKEN:"lexical-local-test",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"dummy-test-only"});});
const req=(query:string,auth=true)=>new Request(`https://wordloop.test/api/web/lexical/graph?${query}`,{headers:auth?{authorization:"Bearer lexical-local-test"}:{}});
describe("strict lexical API",()=>{
 it("authenticates before knowledge and learner state reads",async()=>{expect((await handleWebApiRequest(req("lexeme=circle&view=root",false))).status).toBe(401);expect(mocks.graph).not.toHaveBeenCalled();});
 it.each(["lexeme=circle&view=root&depth=2","lexeme=circle&view=root&user_id=other","lexeme=circle&view=global","lexeme=circle&view=root&relation_types=SYNONYM","lexeme=circle&view=network&relation_types=DERIVATION","lexeme=circle&view=root&lexeme=act","lexeme=&view=root"])("rejects invalid query %s",async query=>{expect((await handleWebApiRequest(req(query))).status).toBe(400);expect(mocks.graph).not.toHaveBeenCalled();});
 it("forwards filtered graph under server identity and no-store",async()=>{
  mocks.graph.mockImplementation(async()=>({user:getAuthenticatedUserId()}));
  const r=await handleWebApiRequest(req("lexeme=persuade&view=network&relation_types=SYNONYM,COLLOCATION"));
  expect(r.status).toBe(200);expect(r.headers.get("cache-control")).toBe("no-store");expect(await r.json()).toEqual({user:"00000000-0000-4000-8000-000000000001"});
  expect(mocks.graph).toHaveBeenCalledWith("persuade","network",["SYNONYM","COLLOCATION"]);
 });
 it("permits an empty network filter and Family compatibility",async()=>{
  mocks.graph.mockResolvedValue({});await handleWebApiRequest(req("lexeme=circle&view=network&relation_types="));expect(mocks.graph).toHaveBeenLastCalledWith("circle","network",[]);
  await handleWebApiRequest(req("lexeme=circle&view=family"));expect(mocks.graph).toHaveBeenLastCalledWith("circle","family",undefined);
 });
});
