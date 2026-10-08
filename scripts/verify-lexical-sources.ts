import { createHash } from "node:crypto";
import reviewed from "../server/data/lexicalReviewed.json" with {type:"json"};
const records=[...reviewed.etymons,...reviewed.etymological_links,...reviewed.senses,...reviewed.sense_relations];
const expected=new Map<string,string>();
for(const r of records) if(r.source==="English Wiktionary contributors") {
 const p=r.provenance as Record<string,unknown>;if(typeof p.sha256_wikitext!=="string")throw new Error("Missing revision checksum");
 expected.set(r.source_version,p.sha256_wikitext);
}
const url=new URL("https://en.wiktionary.org/w/api.php");
url.search=new URLSearchParams({action:"query",prop:"revisions",revids:[...expected.keys()].join("|"),rvprop:"ids|content",rvslots:"main",format:"json"}).toString();
const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error("Wiktionary revision verification unavailable");
const result=await response.json() as any,found=new Set<string>();
for(const page of Object.values(result.query?.pages??{}) as any[])for(const rev of page.revisions??[]){
 const id=String(rev.revid),checksum=createHash("sha256").update(rev.slots.main["*"]).digest("hex");
 if(expected.get(id)!==checksum)throw new Error(`Revision checksum mismatch ${id}`);found.add(id);
}
if(found.size!==expected.size)throw new Error("One or more pinned revisions unavailable");
const pdf=await fetch("https://www.enago.com.tr/downloads/commonly-confused-terms-part1.pdf",{signal:AbortSignal.timeout(30000)});
if(!pdf.ok||createHash("sha256").update(Buffer.from(await pdf.arrayBuffer())).digest("hex")!=="398cdbd50a53083c74594c948093daf011616506346db7574a586c236096a8e4")throw new Error("Usage source checksum mismatch");
console.log(JSON.stringify({verified_wiktionary_revisions:found.size,verified_usage_pdf:true}));
