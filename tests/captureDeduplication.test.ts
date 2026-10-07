import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeCaptureText } from "../server/services/captureNotes.js";
import { captureSavedMessage } from "../shared/captureContracts.js";

const db = new PGlite();
const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const historyNote = "00000000-0000-4000-8000-000000000003";
const historyKeys = ["00000000-0000-4000-8000-000000000004", "00000000-0000-4000-8000-000000000005"];
const migrationName = "20261007025825_captured_note_deduplication.sql";
const migration = readFileSync(new URL("../supabase/migrations/" + migrationName, import.meta.url), "utf8");
async function value(sql: string, args: unknown[] = []) {
  return (await db.query<any>(sql, args)).rows[0];
}
async function capture(text = "Café culture", context = "A Café culture example.", options: {
  user?: string; key?: string; type?: string; ref?: string; url?: string; title?: string;
} = {}) {
  const r = await value("select create_captured_note_v1($1,$2,$3,'phrase','',$4,$5,$6,$7,$8,$9) result", [
    options.user ?? userA, text, normalizeCaptureText(text), context,
    options.type ?? "lesson_example", options.ref ?? null, options.title ?? "Lesson",
    options.url ?? "https://example.test/", options.key ?? crypto.randomUUID(),
  ]);
  return r.result as { note_id: string; occurrence_count: number; new_occurrence: boolean };
}
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table users(id uuid primary key);
    create table user_words(id uuid primary key);
    create table note_review_states(user_id uuid, captured_note_id uuid, enabled boolean, due timestamptz, revision bigint);`);
  const initial = readFileSync(new URL("../supabase/migrations/20260929120641_captured_notes.sql", import.meta.url), "utf8");
  await db.exec(initial.slice(0, initial.indexOf("-- Keep word/card insertion")));
  await db.query("insert into users values($1),($2)", [userA, userB]);
  await db.query("insert into captured_notes(id,user_id,selected_text,normalized_text,selection_type,note) values($1,$2,'history','history','word','Keep this note')", [historyNote,userA]);
  for (const key of historyKeys) await db.query("insert into captured_note_occurrences(user_id,captured_note_id,context_text,source_type,idempotency_key) values($1,$2,'Same source','manual',$3)", [userA,historyNote,key]);
  await db.exec(migration);
}, 30000);
afterAll(() => db.close());
beforeEach(() => db.exec("begin"));
afterEach(() => db.exec("rollback"));

describe("Capture source deduplication in PostgreSQL", () => {
  it("merges historical display while retaining both source rows and request keys", async () => {
    expect(await value("select count(*)::int as total, count(*) filter(where not is_duplicate)::int as visible from captured_note_occurrences where captured_note_id=$1", [historyNote]))
      .toEqual({ total: 2, visible: 1 });
    const row = await value("select occurrence_count,occurrences,note from list_captured_notes_v1($1,'all','history',null,null,25)", [userA]);
    expect(Number(row.occurrence_count)).toBe(1);
    expect(row.occurrences).toHaveLength(1);
    expect(row.note).toBe("Keep this note");
    for (const key of historyKeys) expect(await capture("history", "Same source", {type:"manual",key}))
      .toMatchObject({note_id:historyNote,occurrence_count:1,new_occurrence:false});
  });
  it("deduplicates fresh request IDs, Unicode and whitespace, preserving saved notes and review revision", async () => {
    const first = await capture();
    await db.query("update captured_notes set note='Personal explanation', status='saved' where id=$1", [first.note_id]);
    await db.query("insert into note_review_states values($1,$2,true,'2026-10-10',7)", [userA,first.note_id]);
    const before = await value("select note,status,updated_at from captured_notes where id=$1", [first.note_id]);
    const duplicate = await capture("  CAFÉ   CULTURE ", "  A\tCafe\u0301   culture example. ", {title:"New page title"});
    expect(duplicate).toEqual({note_id:first.note_id,occurrence_count:1,new_occurrence:false});
    expect(await value("select note,status,updated_at from captured_notes where id=$1", [first.note_id])).toEqual(before);
    expect(await value("select enabled,revision,due from note_review_states where captured_note_id=$1", [first.note_id])).toMatchObject({enabled:true,revision:7});
    const row = await value("select occurrence_count,occurrences from list_captured_notes_v1($1,'saved','culture',null,null,25)", [userA]);
    expect(Number(row.occurrence_count)).toBe(1);
    expect(row.occurrences).toHaveLength(1);
  });
  it("retains distinct context, source reference, source type and source URL under one note", async () => {
    const first = await capture();
    const results = [
      await capture(undefined,"A different example."),
      await capture(undefined,undefined,{ref:"another-lesson"}),
      await capture(undefined,undefined,{type:"review_question"}),
      await capture(undefined,undefined,{url:"https://example.test/another"}),
    ];
    expect(results.every(r => r.note_id===first.note_id && r.new_occurrence)).toBe(true);
    expect(results.at(-1)?.occurrence_count).toBe(5);
    expect((await capture()).occurrence_count).toBe(5);
  });
  it("keeps punctuation-distinct expressions and separate users separate", async () => {
    const first = await capture("can");
    const punctuation = await capture("can't");
    const otherUser = await capture("can",undefined,{user:userB});
    expect(new Set([first.note_id,punctuation.note_id,otherUser.note_id]).size).toBe(3);
    expect(otherUser.new_occurrence).toBe(true);
  });
  it("replays original and duplicate receipt keys without adding sources", async () => {
    const firstKey=crypto.randomUUID(), duplicateKey=crypto.randomUUID();
    const first=await capture(undefined,undefined,{key:firstKey});
    await capture(undefined,undefined,{key:duplicateKey});
    for (const key of [firstKey,duplicateKey]) {
      expect(await capture(undefined,"changed retry payload",{key})).toEqual({note_id:first.note_id,occurrence_count:1,new_occurrence:false});
    }
    expect((await value("select count(*)::int n from captured_note_occurrences where captured_note_id=$1",[first.note_id])).n).toBe(2);
  });
  it("rejects a duplicate receipt key reused for another expression and rolls back the new note", async () => {
    await capture();
    const key=crypto.randomUUID();
    await capture(undefined,undefined,{key});
    await db.exec("savepoint conflicting_request");
    await expect(capture("another expression",undefined,{key})).rejects.toThrow("CAPTURE_IDEMPOTENCY_CONFLICT");
    await db.exec("rollback to savepoint conflicting_request");
    expect((await value("select count(*)::int n from captured_notes where normalized_text='another expression'")).n).toBe(0);
  });
  it("enforces the unique source index even if a writer bypasses the capture RPC", async () => {
    const first=await capture();
    await db.exec("savepoint direct_insert");
    await expect(db.query("insert into captured_note_occurrences(user_id,captured_note_id,context_text,source_type,source_url,idempotency_key) values($1,$2,'A Café culture example.','lesson_example','https://example.test/',$3)",[userA,first.note_id,crypto.randomUUID()]))
      .rejects.toThrow(/unique constraint/);
    await db.exec("rollback to savepoint direct_insert");
  });
  it("limits the helper and capture RPC to the server role and keeps table RLS enabled", async () => {
    expect(await value("select has_function_privilege('anon','capture_occurrence_fingerprint_v1(text,text,text,text)','execute') anon, has_function_privilege('authenticated','create_captured_note_v1(uuid,text,text,text,text,text,text,text,text,text,uuid)','execute') authenticated, has_function_privilege('service_role','create_captured_note_v1(uuid,text,text,text,text,text,text,text,text,text,uuid)','execute') server"))
      .toEqual({anon:false,authenticated:false,server:true});
    expect((await value("select bool_and(relrowsecurity) enabled from pg_class where oid in ('captured_notes'::regclass,'captured_note_occurrences'::regclass)")).enabled).toBe(true);
  });
});

describe("Capture duplicate feedback and release integration", () => {
  it("distinguishes a duplicate source, a new source, and a new note", () => {
    expect(captureSavedMessage({new_occurrence:false,occurrence_count:1})).toBe("这条笔记已存在，未重复添加");
    expect(captureSavedMessage({new_occurrence:true,occurrence_count:2})).toBe("笔记已存在，已补充新来源");
    expect(captureSavedMessage({new_occurrence:true,occurrence_count:1})).toBe("已记录到划词笔记");
  });
  it("bundles and documents the migration and does not write learning state", () => {
    for (const file of ["setup.sql","scripts/build-sites-worker.ts","README.md"]) {
      const text=readFileSync(new URL("../"+file,import.meta.url),"utf8");
      expect(text).toContain(file==="setup.sql" ? migration.trim() : migrationName);
    }
    expect(migration).not.toMatch(/(?:insert into|update|delete from) public\.(?:words|user_words|study_sessions|attempts|daily_imports|daily_import_words|fsrs_review_logs|note_review_states|note_review_events)/i);
  });
});
