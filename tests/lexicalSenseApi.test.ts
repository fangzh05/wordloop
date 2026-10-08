import {beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({graph:vi.fn()}));
vi.mock("../server/services/lexicalGraph.js",()=>({getLexicalGraph:mocks.graph}));
import {handleWebApiRequest} from "../server/webApi.js";
import {configureRuntimeEnv,resetDatabaseForTests} from "../server/db.js";
beforeEach(()=>{vi.clearAllMocks();resetDatabaseForTests();configureRuntimeEnv({DEV_USER_ID:"00000000-0000-4000-8000-000000000001",WORDLOOP_WEB_TOKEN:"sense-test-only",SUPABASE_URL:"https://example.supabase.co",SUPABASE_SERVICE_ROLE_KEY:"dummy-test-only"});});
const req=(query:string,auth=true)=>new Request(`https://wordloop.test/api/web/lexical/graph?${query}`,{headers:auth?{authorization:"Bearer sense-test-only"}:{}});
describe("V2 sense query boundary",()=>{
 it.each(["pos=q","limit=9","offset=-1","offset=10001","evidence_offset=-1","sense_id=","include_folded=1","unknown=true","scope=all","depth=2","user_id=other","sense_id=a&sense_id=b","scope=unscoped&sense_id=a"])("rejects invalid V2 option %s",async tail=>{
  expect((await handleWebApiRequest(req(`lexeme=bear&view=network&version=2&${tail}`))).status).toBe(400);expect(mocks.graph).not.toHaveBeenCalled();
 });
 it.each(["lexeme=bear&view=root&version=2","lexeme=bear&view=family&pos=v","lexeme=bear&view=network&sense_id=test"])("rejects V2 selectors for incompatible consumer %s",async query=>{
  expect((await handleWebApiRequest(req(query))).status).toBe(400);expect(mocks.graph).not.toHaveBeenCalled();
 });
 it("authenticates before V2 reads and passes precise options under the existing server identity",async()=>{
  expect((await handleWebApiRequest(req("lexeme=bear&view=network&version=2",false))).status).toBe(401);
  expect(mocks.graph).not.toHaveBeenCalled();mocks.graph.mockResolvedValue({});
  const response=await handleWebApiRequest(req("lexeme=bear&view=network&version=2&pos=v&sense_id=oewn-bear__2.31.00..&offset=8&limit=5&include_folded=true&evidence_offset=96"));
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.graph).toHaveBeenCalledWith("bear","network",undefined,undefined,undefined,{version:2,pos:"v",sense_id:"oewn-bear__2.31.00..",offset:8,limit:5,scope:undefined,include_folded:true,evidence_offset:96});
 });
});
