create schema if not exists exam_expansion_audit;
revoke all on schema exam_expansion_audit from public,anon,authenticated;
create table if not exists exam_expansion_audit.batches(id text primary key,created_at timestamptz default now(),baseline jsonb not null,provenance jsonb not null);
create table if not exists exam_expansion_audit.members(batch text not null,book_id text not null,normalized_word text not null,primary key(batch,book_id,normalized_word));
create table if not exists exam_expansion_audit.snapshots(batch text not null,table_name text not null,row_data jsonb not null);
create table if not exists exam_expansion_audit.transport(batch text not null,part integer not null,payload text not null,hash text not null,primary key(batch,part));
create table if not exists exam_expansion_audit.checkpoints(batch text not null,phase text not null,created_at timestamptz default now(),data jsonb not null,primary key(batch,phase));
revoke all on all tables in schema exam_expansion_audit from public,anon,authenticated;
