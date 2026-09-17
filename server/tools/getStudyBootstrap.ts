import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStudyBootstrap } from "../services/studyBootstrap.js";
import { safeTool } from "./helpers.js";

export function registerGetStudyBootstrapTool(server: McpServer): void {
  server.registerTool("get_study_bootstrap", {
    title: "Start or resume WordLoop",
    description: "唯一的 WordLoop 学习启动入口：普通 active session 立即恢复；已完成的 pretest 会在同一 study flow 中按 backend 学习队列继续，不会重新 resume pretest；When bootstrap encounters an already completed Lesson round, it transparently closes that round and continues discovery of remaining daily work. 无 active 时先幂等准备今日队列，再按复习、新词预测试、正式学习或完成状态返回。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, () => safeTool(getStudyBootstrap));
}
