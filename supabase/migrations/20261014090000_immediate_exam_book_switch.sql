-- Apply book switches on the user's current local day. Existing daily queue
-- entries and active study sessions remain intact; future replenishment uses
-- the newly selected book.
create or replace function public.set_exam_book_v1(p_user_id uuid,p_book_id text)
returns jsonb language plpgsql set search_path=public as $$
declare d date; old text; private_book boolean;
begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
 select (now() at time zone timezone)::date into d from users where id=p_user_id;
 if d is null then raise exception 'Unknown user'; end if;
 if not exists(select 1 from exam_books where id=p_book_id and is_public and is_available) and not
 (p_book_id='kaoyan' and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc')) then raise exception 'Book unavailable'; end if;
 select case when effective_date>d then previous_book_id else book_id end into old from user_book_preferences where user_id=p_user_id;
 if not found and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc') then old:='kaoyan';end if;
 private_book:=p_book_id='kaoyan' and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='ougkp')
 and exists(select 1 from word_sources where user_id=p_user_id and source_book_id='athgc');
 insert into user_book_preferences(user_id,book_id,previous_book_id,effective_date) values(p_user_id,p_book_id,old,d)
 on conflict(user_id) do update set book_id=excluded.book_id,previous_book_id=excluded.previous_book_id,effective_date=excluded.effective_date,updated_at=now();
 insert into daily_book_targets(user_id,local_date,book_id,private_kaoyan) values(p_user_id,d,p_book_id,private_book)
 on conflict(user_id,local_date) do update set book_id=excluded.book_id,private_kaoyan=excluded.private_kaoyan;
 return jsonb_build_object('book_id',p_book_id,'effective_date',d);
end $$;
revoke all on function public.set_exam_book_v1(uuid,text) from public,anon,authenticated;
grant execute on function public.set_exam_book_v1(uuid,text) to service_role;

-- Make already-selected next-day targets effective today, preserving all
-- previously assigned daily_import_words and study-session snapshots.
with pending as materialized (
 select preference.user_id,preference.book_id,
        (now() at time zone app_user.timezone)::date as local_date,
        (preference.book_id='kaoyan'
         and exists(select 1 from word_sources where user_id=preference.user_id and source_book_id='ougkp')
         and exists(select 1 from word_sources where user_id=preference.user_id and source_book_id='athgc')) as private_kaoyan
 from user_book_preferences preference
 join users app_user on app_user.id=preference.user_id
 where preference.effective_date>(now() at time zone app_user.timezone)::date
), updated as (
 update user_book_preferences preference
 set effective_date=pending.local_date,updated_at=now()
 from pending
 where preference.user_id=pending.user_id
 returning preference.user_id,preference.book_id
)
insert into daily_book_targets(user_id,local_date,book_id,private_kaoyan)
select pending.user_id,pending.local_date,pending.book_id,pending.private_kaoyan
from pending join updated using(user_id,book_id)
on conflict(user_id,local_date) do update
set book_id=excluded.book_id,private_kaoyan=excluded.private_kaoyan;
