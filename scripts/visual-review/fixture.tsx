import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppNavigation, SettingsSheet } from "../../web/src/standalone/AppShell.js";
import { TodayPage } from "../../web/src/standalone/pages/TodayPage.js";
import { InsightsPage } from "../../web/src/standalone/pages/InsightsPage.js";
import { VocabularyPage } from "../../web/src/standalone/pages/VocabularyPage.js";
import { CaptureNotesPage } from "../../web/src/standalone/CaptureNotesPage.js";
import { NoteReviewPage } from "../../web/src/standalone/NoteReviewPage.js";
import { FamilyPanel } from "../../web/src/family/FamilyPanel.js";
import { StandaloneReviewWorkspace, StandaloneLessonExplanation, StandaloneLessonExercise, StandaloneLessonHeader } from "../../web/src/standalone/StandaloneApp.js";
import { Button } from "../../web/src/components/Button.js";
import type { AppSection } from "../../web/src/standalone/AppShell.js";

const date = "2026-10-11T02:00:00+08:00";
const words = ["predict","opaque","anticipate","resilient","sustainable","illustrate","subtle","paradigm","evidence"];
const fakeVocabulary = words.map((word,i)=>({user_word_id:"w"+i,word_id:"w"+i,word,display_word:word,ipa_us:"/prɪˈdɪkt/",ipa_uk:null,status:i%3===0?"review":i%3===1?"mastered":"uncertain",source:"shanbay",fsrs_reps:i+1,fsrs_difficulty:5.2,fsrs_stability:7.8,next_review_at:date,active_error_layers:i===0?["collocation"]:[]}));
const notes = ["a matter of perspective","predict the future","in the long run","subtle difference"].map((t,i)=>({
 id:"n"+i,selected_text:t,normalized_text:t,selection_type:i===1?"phrase":"collocation",
 note:"学习时记录的表达；注意真实语境与搭配。",status:"inbox",occurrence_count:i+1,user_word_id:null,word_id:null,
 created_at:date,updated_at:date,first_seen_at:date,last_seen_at:date,
 latest_occurrence:{context_text:i===1?"Scientists can predict the weather weeks in advance.":"This is a matter of perspective rather than certainty.",source_type:"lesson_example",source_title:"Lesson",source_url:null,captured_at:date},occurrences:[],note_review:null
}));
const familyNodes = ["predict","prediction","predictable","predictor","unpredictable"].map((lemma,i)=>({
 lexeme_id:"id"+i,lemma,part_of_speech:i===0?"v":i===1||i===3?"n":"a",
 forms:[],senses:[{sense_id:"s"+i,definition:i===0?"to say what will happen in the future":"related word form"}],
 reason:i===0?"核心词": "现代构词派生",user_state:null,
 dictionary:{parts_of_speech:[{label:i===0?"v. 动词":"n. / adj.",definition_zh:i===0?"预言；预测；预料":"相关派生词"}],source:"ECDICT",license:"MIT",phonetic:"/prɪˈdɪkt/",english_definition:"to say what will happen in the future",chinese_translation:"预测"}
}));
const familyGraph = {
 center:familyNodes[0],nodes:familyNodes,edges:familyNodes.slice(1).map((n,i)=>({
 relation_id:"edge"+i,source_id:"id0",target_id:n.lexeme_id,
 relation_type:"MORPHOLOGICAL_DERIVATION",direction:"forward",source:"fixture",source_version:"0",
 license:"preview",confidence:1,morphology:"derivation",provenance:{}
 })),truncated:false
};
const asEnvelope = (data:any) => ({data,as_of:date,timezone:"Asia/Shanghai",coverage:{target_retention:0.9},next_cursor:null});
const trend = Array.from({length:12},(_,i)=>({date:"2026-10-"+String(i+1).padStart(2,"0"),success_rate:.63+i*.022,samples:20+i,passes:16+i}));
const analytics = asEnvelope({
 long_term_first_recall:{success_rate:.82,passes:164,samples:200,small_sample:false},
 current_memory:{scheduled_word_count:1358,average_stability_days:8.7},
 due_distribution:{overdue_previous_days:7,due_today_elapsed:18,due_today_later:6,future_next_7_days:123,future_days:[]},
 focus_words:[{user_word_id:"w0",word:"predict",reasons:["active_error"]},{user_word_id:"w1",word:"opaque",reasons:["r_below_target"]},{user_word_id:"w2",word:"anticipate",reasons:["high_d_low_s"]}],
 success_trend:trend,
 current_snapshot:{scheduled_word_count:1358,stability_days:{mean:8.7,median:5.9,histogram:[]},difficulty:{mean:5.2,median:5.3,histogram:[]},retrievability:{histogram:[]}},
 days:[]
});
const today = {
 as_of:date,timezone:"Asia/Shanghai",target_retention:.9,
 active_session:{active:true,phase:"review",phase_detail:null,started_at:date,updated_at:date},
 progress:{review:{completed:6,total:24,remaining:18,scope:"active_session"},pretest:{total:12,completed:4,known:2,uncertain:1,unknown:1},formal_learning:{completed_words:3,completed_distinct_words:3,new_words:2,relearn_words:1}},
 captures:{inbox_count:4}
};
const budget = {daily_minutes:45,extra_seconds:0,estimated_used_seconds:1680,remaining_seconds:1020,due_count:18,overdue_count:7,effective_new_limit:12,forecast:[]};
const fixtureView:any={screen:"review",session_revision:"preview-1",state:{phase:"review"},progress:{fsrs:{due_now:18},today:{},review_today:{},all_time:{},settings:{}}};
const originalFetch = window.fetch.bind(window);
window.localStorage.setItem("wordloop_web_token","preview-only");
window.fetch = async (input:any, init?:any)=>{
 const u=new URL(typeof input==="string"?input:input.url,location.origin),p=u.pathname;
 let value:any=null;
 if(p==="/api/web/today")value=today;
 else if(p==="/api/web/budget")value=budget;
 else if(p==="/api/web/analytics")value=analytics;
 else if(p==="/api/web/vocabulary")value=asEnvelope({items:fakeVocabulary});
 else if(p.startsWith("/api/web/vocabulary/"))value=asEnvelope({display_word:"predict",ipa_us:"/prɪˈdɪkt/",ipa_uk:"/prɪˈdɪkt/",audio_url:null,
 senses:[{pos:"v.",definition_cn:"预测；预言；预料"}],memory:{difficulty:5.2,stability_days:7.8,retrievability:.82,lapses:2,next_review_at:date},focus_reasons:["active_error"],
 recent_formal_reviews:[{id:"a",reviewed_at:date,rating:3,scheduled_days:7}],recent_error_attempts:[],captured_notes:[],capture_occurrences:[]});
 else if(p==="/api/web/captures")value={items:notes,counts:{inbox:4,saved:3,learning:1,archived:0},next_cursor:null};
 else if(p==="/api/web/note-reviews")value={items:[{note_id:"n0",selected_text:"a matter of perspective",note:"主要表达一种看问题的视角",note_updated_at:date,due:date,revision:1,
 latest_occurrence:{context_text:"This is a matter of perspective rather than certainty.",source_type:"lesson_example",source_title:"Lesson",source_url:null,captured_at:date}}],total:1,as_of:date};
 else if(p==="/api/web/family/graph"||p==="/api/web/family/expand")value=familyGraph;
 else if(p==="/api/web/family/candidate")value={stage:"A",eligible_now:false,reason:"先巩固核心词，再决定是否学习派生词。"};
 else if(p==="/api/web/family/session")value=null;
 else if(p==="/api/web/family/dictionary")value=familyNodes[0].dictionary;
 else if(p==="/api/web/lexical/graph")value={...familyGraph,view:"root",center:{...familyNodes[0],node_id:"id0"},nodes:familyNodes.map(n=>({...n,node_id:n.lexeme_id,node_type:"lexeme"}))};
 else if(p==="/api/web/imports/shanbay")value={status:"idle"};
 if(p==="/api/web/family/session")return new Response("null",{status:200,headers:{"content-type":"application/json"}});
 if(value!==null)return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
 return new Response(JSON.stringify({error:{code:"FIXTURE_UNHANDLED",message:p}}),{status:404,headers:{"content-type":"application/json"}});
};
function App() {
 const query=new URLSearchParams(location.search);
 const page=query.get("page")??"today";
 const immersive = ["study","lesson","lesson-exercise"].includes(page);
 const [studyAnswer,setStudyAnswer]=useState("");
 const [section,setSection]=useState<AppSection>((["today","study","capture","insights","vocabulary"].includes(page)?page:"today") as AppSection);
 const [showSettings,setShowSettings]=useState(page==="settings");
 const [family,setFamily]=useState(page==="family");
 const [notesReview,setNotesReview]=useState(page==="note-review");
 const [appearance,setAppearance]=useState<"system"|"light"|"dark">("light");
 const route=(p:string)=>{location.href="?page="+p+"&size="+(query.get("size")??"desktop");};
 return <main className="standalone-shell wordloop-shell" data-study-open={immersive?"true":"false"}>
  <div className={immersive?"wordloop-app-grid is-immersive":"wordloop-app-grid"} data-section={section}>
   {!immersive&&<AppNavigation section={section} onNavigate={route as any}/>}
   <section className="standalone-main">
    {!immersive&&<header className="wordloop-topbar"><div className="standalone-brand"><span className="standalone-mark">W</span>WordLoop</div><button className="settings-open-button" onClick={()=>setShowSettings(true)} aria-label="设置">⚙</button></header>}
    {page==="today"&&<TodayPage view={fixtureView} busy={false} tokenKey="fixture" onBudgetAction={async()=>({})} onContinue={()=>route("study")} onStartConsolidation={()=>{}} onOpenCapture={()=>route("capture")} onOpenVocabulary={()=>route("vocabulary")}/>}
    {page==="insights"&&<InsightsPage tokenKey="fixture" onOpenWord={()=>route("vocabulary")}/>}
    {page==="vocabulary"&&<VocabularyPage tokenKey="fixture" initialUserWordId="w0" onDetailChange={()=>{}}/>}
    {page==="capture"&&<CaptureNotesPage onBack={()=>route("today")} onOpenReview={()=>route("note-review")} noteReviewDueCount={1}/>}
    {page==="note-review"&&<NoteReviewPage onBack={()=>route("capture")} />}
    {page==="study"&&<section className="widget-card standalone-card study-task-card review-editorial-card" aria-labelledby="study-title">
      <StandaloneReviewWorkspace item={{word:"predict",part_of_speech:"v.",meaning_zh:"预测；预言；预料"}}
       direction="cn_to_en" currentIndex={2} total={18} answer={studyAnswer} busy={false}
       notice="" noticeIndex={null} onBack={()=>route("today")} onAnswerChange={setStudyAnswer}
       onUnknown={()=>{}} onSubmit={()=>{}} />
    </section>}
    {page==="lesson"&&<section className="widget-card standalone-card lesson-card study-explain-card" aria-labelledby="study-title">
      <StandaloneLessonExplanation title="predict" displayTitle="predict" progressLabel="正式学习 · 03 / 12"
       ipa="/prɪˈdɪkt/" pronunciationAudioUrl={null}
       meaningZh="预测；预言；预料" partOfSpeech="v."
       exampleEn="Scientists can predict the weather weeks in advance, but they cannot know exactly how the climate will change."
       exampleZh="科学家能提前数周预测天气，但无法准确知道气候将如何变化。"
       collocations={["predict the outcome","accurately predict","predict a future trend"]}
       derivations={["prediction · n. 预测","predictable · adj. 可预测的","unpredictable · adj. 难以预料的"]}
       note="predict 表示依据已有信息做出预测；与 anticipate（预期、预先准备）和 foresee（预见）在语境与语气上有所区别。"
       busy={false} onBack={()=>route("today")} onStartExercise={()=>route("lesson-exercise")}/>
    </section>}
    {page==="lesson-exercise"&&<section className="widget-card standalone-card lesson-card study-task-card" aria-labelledby="study-title">
      <StandaloneLessonHeader title="predict" progressLabel="正式学习 · 03 / 12" onBack={()=>route("lesson")}/>
      <StandaloneLessonExercise instruction="使用刚学过的词，完成下面这句话。" prompt="It is difficult to ______ the outcome of the election."
        activityType="cloze" clozeHint={""} multiline={false} answer={studyAnswer} busy={false}
        onAnswerChange={setStudyAnswer} onSubmit={()=>{}} />
    </section>}
    {page==="family"&&<section className="widget-card standalone-card"><h1>词族</h1><Button onClick={()=>setFamily(true)}>打开词族</Button></section>}
    {page==="settings"&&<section className="widget-card standalone-card"><h1>设置</h1></section>}
    {showSettings&&<SettingsSheet open onClose={()=>setShowSettings(false)} appearance={appearance} onAppearanceChange={setAppearance} dailyLimit={50} busy={false} onSaveDailyNewWordLimit={async(limit)=>({}) as any}/>}
    {family&&<FamilyPanel initialWord="predict" onClose={()=>setFamily(false)}/>}
   </section>
  </div>
  <aside className="visual-fixture-stamp" aria-label="测试数据">SOURCE COMPONENT PREVIEW · FIXTURE DATA</aside>
 </main>;
}
document.documentElement.dataset.theme="light";
createRoot(document.getElementById("root")!).render(<App/>);
