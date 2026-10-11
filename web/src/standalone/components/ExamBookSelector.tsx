import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {request} from '../apiClient.js';
type Book={id:string;name:string;source:string;source_version:string;license:string;is_public:boolean;available:boolean;scope:'public'|'private';unavailable_reason:string|null;total:number;in_learning:number;mastered:number;not_enrolled:number};
type Catalog={selected_book_id:string|null;effective_date:string|null;books:Book[]};
const Context=createContext<{data:Catalog|null;error:string;loading:boolean;refresh:()=>Promise<void>;open:()=>void}|null>(null);
export function ExamBookProvider({tokenKey,children}:{tokenKey:string|null;children:ReactNode}) {
 const[data,setData]=useState<Catalog|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),[open,setOpen]=useState(false);
 const[pending,setPending]=useState(''),[saving,setSaving]=useState(false);
 const dialog=useRef<HTMLDialogElement>(null),generation=useRef(0);
 const refresh=async()=>{const g=++generation.current;setLoading(true);try{const value=await request<Catalog>('/api/web/exam-books',{method:'GET'});if(g===generation.current){setData(value);setError('');}}catch{if(g===generation.current)setError('学习词书暂时无法读取。');}finally{if(g===generation.current)setLoading(false);}};
 useEffect(()=>{setData(null);setOpen(false);setPending('');setError('');if(tokenKey)void refresh();return()=>{generation.current++;};},[tokenKey]);
 useEffect(()=>{if(open){setPending(data?.selected_book_id??'');dialog.current?.showModal();}else dialog.current?.close();},[open]);
 const save=async()=>{if(!pending||saving)return;const g=generation.current;setSaving(true);setError('');try{await request('/api/web/exam-books/selection',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({book_id:pending})});if(g!==generation.current)return;await refresh();setOpen(false);}catch{if(g===generation.current)setError('词书保存失败，请刷新后重试。');}finally{setSaving(false);}};
 return <Context.Provider value={{data,error,loading,refresh,open:()=>{setOpen(true);void refresh();}}}>{children}
 <dialog ref={dialog} className="settings-sheet exam-book-sheet" aria-labelledby="exam-books-title" onCancel={event=>{event.preventDefault();if(!saving)setOpen(false);}} onClick={event=>{if(event.target===event.currentTarget&&!saving)setOpen(false);}}>
  <header><div><span className="eyebrow">LEARNING TARGET</span><h2 id="exam-books-title">学习词书</h2></div><button className="secondary-button" disabled={saving} onClick={()=>setOpen(false)}>关闭</button></header>
  <p className="exam-book-note">新目标从明天的新词任务生效。今日任务、当前会话和到期复习照常保留。</p>
  <fieldset disabled={saving} className="exam-book-options"><legend>选择学习目标</legend>{data?.books.map(book=><label key={book.id} className="exam-book-option">
   <input type="radio" name="exam-book" value={book.id} disabled={!book.available} checked={pending===book.id} onChange={()=>setPending(book.id)}/>
   <span><strong>{book.name}</strong><small>{book.scope==='private'?'我的私人词书':'公共词书'} · {book.total.toLocaleString()} 词</small>
   {book.available?<small>已纳入我的学习 {book.in_learning} · {book.scope==='private'?'词头已掌握':'已掌握'} {book.mastered} · 词书未学习 {book.not_enrolled}</small>:<small>{book.unavailable_reason}</small>}
   <small>{book.source} · {book.source_version==='pending'?'版本待准备':book.source_version.slice(0,7)} · {book.license}</small></span>
  </label>)}</fieldset>
  {loading&&<p role="status">正在读取词书…</p>}{error&&<p role="alert" className="standalone-status error">{error}</p>}
  <button type="button" className="button primary" disabled={saving||loading||!data?.books.some(b=>b.id===pending&&b.available)} onClick={()=>void save()}>{saving?'正在保存…':'设为当前学习目标'}</button>
 </dialog></Context.Provider>;
}
export function CurrentExamBook({compact=false}:{compact?:boolean}){
 const state=useContext(Context);if(!state)return null;
 const current=state.data?.books.find(b=>b.id===state.data?.selected_book_id);
 return <section className={`current-exam-book${compact?' is-compact':''}`} aria-label="当前学习词书"><div><span className="eyebrow">{compact?'当前词书':'学习词书'}</span><strong>{current?.name??(state.loading?'正在读取…':'请选择词书')}</strong>{!compact&&current&&<small>{current.total.toLocaleString()} 词 · 已纳入我的学习 {current.in_learning} · {current.scope==='private'?'词头已掌握':'已掌握'} {current.mastered}</small>}{state.data?.effective_date&&<small>目标生效日期 {state.data.effective_date}</small>}</div><button type="button" className="secondary-button" aria-haspopup="dialog" onClick={state.open}>{compact?'更换':'切换词书'}</button>{state.error&&<p role="alert">{state.error}<button type="button" className="secondary-button" onClick={()=>void state.refresh()}>重试</button></p>}</section>;
}
