import http from "node:http";
import { json } from "node:stream/consumers";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";

const MODEL = process.env.MODEL ?? "anthropic/claude-haiku-5.5";

// pi keeps its state on the drive. FULL syncs every step to disk,
// so a VM that crashes mid-turn doesn't take the last steps with it.
const db = await openNodeSqliteDatabase("/workspace/.pi/agent.sqlite");
await db.exec("PRAGMA synchronous = FULL");
const storage = await SqliteStorage.open(db);

// models through AI Gateway, with the key from AI_GATEWAY_API_KEY
const gateway = vercelAIGatewayProvider();
const models = createModels();
models.setProvider(
  createProvider({ id: gateway.id, name: gateway.name, baseUrl: gateway.baseUrl, auth: gateway.auth, api: anthropicMessagesApi(), models: gateway.getModels() }),
);

const registry = createRegistry();
registry.install(CodingTools); // read, write, edit, bash

const harness = await Harness.open(
  storage,
  { models, registry, env: () => new NodeExecutionEnv({ cwd: "/workspace" }) },
  context,
);
const conversation = await harness.root(context, {
  agent: { model: { provider: gateway.id, modelId: MODEL }, cwd: "/workspace" },
});

// pick up whatever the last sandbox didn't finish
harness.resume();

// POST { prompt } runs a turn and replies with { reply }, the agent's last message
http.createServer(async (req, res) => {
  const { prompt } = (await json(req).catch(() => ({}))) as { prompt?: string };
  if (typeof prompt !== "string") return res.writeHead(400).end("POST { prompt }\n");
  const sub = await conversation.submit({ type: "input", content: prompt, whenBusy: "followUp" }, context);
  await sub.wait(context);
  const { entries } = await conversation.context(context);
  const last = entries.flatMap((entry) => entry.model ?? []).findLast((message) => message.role === "assistant");
  const reply = Array.isArray(last?.content) ? last.content.map((part) => ("text" in part ? part.text : "")).join("") : "";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));
}).listen(Number(process.env.PORT ?? 3000), "0.0.0.0");

process.on("SIGTERM", async () => {
  await harness.close(context);
  process.exit(0);
});
