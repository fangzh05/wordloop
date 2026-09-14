import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../../db.js";
import { assertDatabaseResult } from "../../services/shared.js";
import { ShanbayClient, type ShanbayImportCursor } from "./client.js";
import { dedupeShanbayWords } from "./mapper.js";
import type { ShanbayBook, ShanbayWord } from "./types.js";

const DB_BATCH_SIZE = 300;

export async function getCurrentShanbayBook(client = new ShanbayClient()): Promise<ShanbayBook> {
  return client.getCurrentBook();
}

export async function previewShanbayBook(bookId: string, client = new ShanbayClient()) {
  const current = await client.getCurrentBook().catch(() => null);
  const fetched = await client.getAllWords(bookId);
  return {
    book: { id: bookId, name: current?.id === bookId ? current.name : `Shanbay book ${bookId}`, is_current: current?.id === bookId },
    unlearned: fetched.counts.unlearned,
    learning: fetched.counts.learning,
    simple_learned: fetched.counts.simple_learned,
    estimated_unique_total: dedupeShanbayWords(fetched.words).length,
  };
}

export async function persistShanbayBook(
  book: ShanbayBook, words: ShanbayWord[], db: SupabaseClient = getDatabase(), userId = getAuthenticatedUserId(),
) {
  const unique = dedupeShanbayWords(words);
  let added = 0; let existing = 0;
  for (let offset = 0; offset < unique.length; offset += DB_BATCH_SIZE) {
    const { data, error } = await db.rpc("import_vocabulary_batch_v1", {
      p_user_id: userId, p_book_id: book.id, p_book_name: book.name,
      p_items: unique.slice(offset, offset + DB_BATCH_SIZE),
    });
    assertDatabaseResult(error);
    const result = data as { new: number; existing: number };
    added += result.new; existing += result.existing;
  }
  return { books: 1, book, unique: unique.length, new: added, existing };
}

export async function importShanbayBook(bookId?: string, cursor?: ShanbayImportCursor, client = new ShanbayClient()) {
  const current = await client.getCurrentBook().catch((error) => {
    if (!bookId) throw error;
    return null;
  });
  const book: ShanbayBook = bookId
    ? current?.id === bookId ? current : { id: bookId, name: `Shanbay book ${bookId}`, is_current: false }
    : current!;
  // A complete book can contain many thousands of words.  Keep this MCP
  // request bounded and return a cursor; the widget calls us again until the
  // cursor is null.  Each batch is idempotent, so a lost response is safe to
  // retry and never resets a user's learning state.
  return importShanbayBookChunk(book, cursor, client);
}

export interface ShanbayImportChunkResult {
  books: 1;
  book: ShanbayBook;
  unique: number;
  new: number;
  existing: number;
  processed: number;
  state: ShanbayImportCursor["state"];
  page: number;
  pages: number;
  state_total: number | null;
  complete: boolean;
  next_cursor: ShanbayImportCursor | null;
}

/** Import one bounded chunk. See importShanbayBook for the public entry point. */
export async function importShanbayBookChunk(
  book: ShanbayBook,
  cursor?: ShanbayImportCursor,
  client = new ShanbayClient(),
  db: SupabaseClient = getDatabase(),
  userId = getAuthenticatedUserId(),
): Promise<ShanbayImportChunkResult> {
  const fetched = await client.getWordChunk(book.id, cursor);
  const unique = dedupeShanbayWords(fetched.words);
  let added = 0;
  let existing = 0;
  for (let offset = 0; offset < unique.length; offset += DB_BATCH_SIZE) {
    const { data, error } = await db.rpc("import_vocabulary_batch_v1", {
      p_user_id: userId, p_book_id: book.id, p_book_name: book.name,
      p_items: unique.slice(offset, offset + DB_BATCH_SIZE),
    });
    assertDatabaseResult(error);
    const result = data as { new: number; existing: number };
    added += result.new;
    existing += result.existing;
  }
  return {
    books: 1,
    book,
    unique: unique.length,
    new: added,
    existing,
    processed: fetched.words.length,
    state: fetched.state,
    page: fetched.page,
    pages: fetched.pages,
    state_total: fetched.state_total,
    complete: fetched.next_cursor === null,
    next_cursor: fetched.next_cursor,
  };
}
