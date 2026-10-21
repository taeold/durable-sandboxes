// POST /?actor=alice goes to the actor "alice".
// Plain fetch handler, so it runs in a Vercel Function, a Node server, wherever.
import { APIError, Drive, Sandbox } from "@vercel/sandbox";

// every actor runs this image (the Pi agent in ./agent)
const IMAGE = "pi-agent:latest";
const COMMAND = ["node", "/app/server.ts"];
const ENV = { AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? "" };

const PORT = 3000;
const TIMEOUT_MS = 10 * 60_000;

export default {
  async fetch(request: Request) {
    const actor = new URL(request.url).searchParams.get("actor");
    if (!actor) return new Response("Missing ?actor=\n", { status: 400 });

    // one drive per actor
    const drive = await Drive.getOrCreate({ name: actor });
    const sandbox = await sandboxFor(drive);

    return forward(sandbox, request);
  },
};

async function sandboxFor(drive: Drive): Promise<Sandbox> {
  // already running somewhere, reuse it
  if (drive.currentSandboxName) return Sandbox.get({ name: drive.currentSandboxName });
  try {
    const sandbox = await Sandbox.create({
      image: IMAGE,
      mounts: { "/workspace": drive },
      ports: [PORT],
      timeout: TIMEOUT_MS, // sandbox goes away after 10 min, drive stays
      persistent: false,
      env: { PORT: String(PORT), ...ENV },
    });
    const [cmd, ...args] = COMMAND;
    await sandbox.runCommand({ cmd, args, detached: true });
    return sandbox;
  } catch (error) {
    // someone else mounted it first, use theirs
    if (error instanceof APIError && error.response.status === 409) return sandboxFor(await Drive.get({ name: drive.name }));
    throw error;
  }
}

async function forward(sandbox: Sandbox, request: Request): Promise<Response> {
  const body = request.body ? await request.arrayBuffer() : undefined;
  // Until the program is listening, Vercel's proxy answers SANDBOX_NOT_LISTENING
  // and never passes the request on, so retrying is safe.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await fetch(sandbox.domain(PORT), {
      method: request.method,
      body,
      headers: { "accept-encoding": "identity" }, // otherwise the proxy compresses and buffers the whole reply
    });
    if (response.headers.get("x-vercel-error") !== "SANDBOX_NOT_LISTENING") return response;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return new Response("The actor's program did not start listening within 30 s\n", { status: 504 });
}
