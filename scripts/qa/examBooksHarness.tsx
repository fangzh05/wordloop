import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TodayPage} from '../../web/src/standalone/pages/TodayPage.js';
import {VocabularyPage} from '../../web/src/standalone/pages/VocabularyPage.js';
import {ExamBookProvider} from '../../web/src/standalone/components/ExamBookSelector.js';
function Harness(){const[page,setPage]=useState('today');return <ExamBookProvider tokenKey="local-fixture"><main className="standalone-app"><p>LOCAL FIXTURE · 非生产学习数据</p><nav><button onClick={()=>setPage('today')}>今日</button><button onClick={()=>setPage('vocabulary')}>词库</button><button onClick={()=>document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}>明暗</button></nav>{page==='today'?<TodayPage view={null} busy={false} tokenKey="local-fixture" onBudgetAction={async()=>null} onContinue={()=>{}} onStartConsolidation={()=>{}} onOpenCapture={()=>{}} onOpenVocabulary={()=>setPage('vocabulary')}/>:<VocabularyPage tokenKey="local-fixture"/>}</main></ExamBookProvider>};
createRoot(document.getElementById('root')!).render(<Harness/>);
