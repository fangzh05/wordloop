import "dotenv/config";
import { ShanbayClient } from "../server/integrations/shanbay/client.js";
import type { ShanbaySourceState } from "../server/integrations/shanbay/types.js";

const labels: Record<ShanbaySourceState, string> = {
  unlearned: "未学习",
  learning: "学习中",
  simple_learned: "已学习",
};

async function main(): Promise<void> {
  const client = new ShanbayClient();
  const book = await client.getCurrentBook();
  console.log(`词书：${book.name}`);
  console.log(`词书 ID：${book.id}`);

  for (const state of Object.keys(labels) as ShanbaySourceState[]) {
    const words = await client.getPage(book.id, state, 1);
    console.log(`${labels[state]}（第一页）：${words.length}`);
    for (const word of words.slice(0, 3)) console.log(`  - ${word.display}`);
  }
}

main().catch((error: unknown) => {
  // Client errors are intentionally credential-safe; never print request data.
  console.error(error instanceof Error ? error.message : "扇贝检查失败。");
  process.exitCode = 1;
});
