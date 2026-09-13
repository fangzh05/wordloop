import type { SupabaseClient } from "@supabase/supabase-js";
import { getAuthenticatedUserId, getDatabase } from "../../db.js";
import { assertDatabaseResult } from "../../services/shared.js";
import { ShanbayClient } from "./client.js";
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

export async function importShanbayBook(bookId?: string, client = new ShanbayClient()) {
  const current = await client.getCurrentBook().catch((error) => {
    if (!bookId) throw error;
    return null;
  });
  const book: ShanbayBook = bookId
    ? current?.id === bookId ? current : { id: bookId, name: `Shanbay book ${bookId}`, is_current: false }
    : current!;
  const fetched = await client.getAllWords(book.id);
  return persistShanbayBook(book, fetched.words);
}
