import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getStudyBootstrap } from "../services/studyBootstrap.js";
import { safeTool } from "./helpers.js";

export function registerGetStudyBootstrapTool(server: McpServer): void {
  server.registerTool("get_study_bootstrap", {
    title: "Start or resume WordLoop",
    description: "唯一的 WordLoop 学习启动入口：普通 active session 立即恢复；已完成的 pretest 会在同一 study flow 中按 backend 学习队列继续，不会重新 resume pretest；active Lesson phase=lesson_complete 时返回 { action: done }，表示 current vocabulary round has no more words，且当前 active round 仍等待既有的 round-end wrap-up；不得在 round wrap-up 完成之前调用 finish_study_session，长难句收尾完成并批改后必须调用 finish_study_session，再立即调用 get_study_bootstrap 发现今天剩余的 daily words；只有释放 active session 后的新 bootstrap 在没有剩余 review、pretest 或 lesson 项时，才表示真正没有剩余学习项；无 active 时先幂等准备今日队列，再返回复习、新词预测试、正式学习或完成状态。",
    inputSchema: z.object({}).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, () => safeTool(getStudyBootstrap));
}
