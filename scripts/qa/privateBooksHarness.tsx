import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ExamBookProvider,CurrentExamBook} from '../../web/src/standalone/components/ExamBookSelector.js';
import {WordDetailPanel} from '../../web/src/standalone/components/WordDetailPanel.js';
function Harness(){const[detail,setDetail]=useState(false);return <ExamBookProvider tokenKey="local-fixture"><main className="standalone-app"><p>LOCAL FIXTURE · 使用合成释义测试</p><CurrentExamBook/><button onClick={()=>setDetail(true)}>查看测试词条</button>{detail&&<WordDetailPanel userWordId="00000000-0000-4000-8000-000000000001" onClose={()=>setDetail(false)} tokenKey="local-fixture"/>}</main></ExamBookProvider>;}
createRoot(document.getElementById('root')!).render(<Harness/>);
