import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStudyBootstrap } from "../services/studyBootstrap.js";
import { safeTool } from "./helpers.js";

export function registerGetStudyBootstrapTool(server: McpServer): void {
  server.registerTool("get_study_bootstrap", {
    title: "Start or resume WordLoop",
    description: "唯一的 WordLoop 学习启动入口：优先恢复 active session，其次返回复习、新词预测试、正式学习或完成状态。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getStudyBootstrap));
}
