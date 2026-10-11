import {getDatabase,getAuthenticatedUserId} from '../db.js';
import {z} from 'zod';
export const examBookId=z.enum(['kaoyan','cet4','cet6','ielts','toefl']);
export async function listExamBooks(){
 const result=await getDatabase().rpc('list_exam_books_v1',{p_user_id:getAuthenticatedUserId()});
 if(result.error)throw Error('词书目录暂时不可用。');return result.data;
}
export async function selectExamBook(id:z.infer<typeof examBookId>){
 const result=await getDatabase().rpc('set_exam_book_v1',{p_user_id:getAuthenticatedUserId(),p_book_id:id});
 if(result.error)throw Error('词书暂不可选择，请刷新目录。');return result.data;
}
export async function listExamBookWords(id:z.infer<typeof examBookId>,after:string,limit:number){
 const db=getDatabase();
 const book=await db.from('exam_books').select('id').eq('id',id).eq('is_public',true).eq('is_available',true).maybeSingle();
 if(book.error||!book.data)return {items:[],next_cursor:null};
 const result=await db.from('exam_book_words').select('normalized_word').eq('book_id',id).gt('normalized_word',after).order('normalized_word').limit(limit+1);
 if(result.error)throw Error('词书列表暂时不可用。');
 return {items:result.data.slice(0,limit),next_cursor:result.data.length>limit?result.data[limit-1]!.normalized_word:null};
}
