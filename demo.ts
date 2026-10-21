// Runs one turn, stops the sandbox, forks the drive, then sends a different turn to each copy. Uses real Vercel sandboxes.
import { Drive, Sandbox } from "@vercel/sandbox";
import router from "./router.ts";

const run = Date.now().toString(36);
const main = `demo-${run}-main`;
const fork = `demo-${run}-fork`;
const sandboxes = new Set<string>();

async function prompt(actor: string, text: string): Promise<string> {
  const request = new Request(`http://localhost/?actor=${actor}`, { method: "POST", body: JSON.stringify({ prompt: text }) });
  const { reply } = (await (await router.fetch(request)).json()) as { reply: string };
  sandboxes.add((await sandboxOf(actor)).name);
  return reply;
}

async function sandboxOf(actor: string): Promise<Sandbox> {
  const drive = await Drive.get({ name: actor });
  return Sandbox.get({ name: drive.currentSandboxName! });
}

async function appJs(actor: string): Promise<string> {
  return (await (await sandboxOf(actor)).runCommand("cat", ["/workspace/app.js"])).stdout();
}

try {
  console.log("main:", await prompt(main, "Create app.js that exports add(a, b). Reply in one short sentence."));

  // stop the sandbox, the drive keeps the conversation and files
  await (await sandboxOf(main)).stop();

  // copy the drive to a new actor
  await (await Drive.get({ name: main })).fork({ name: fork });

  // both wake up in new sandboxes with the same first turn behind them
  const [mainReply, forkReply] = await Promise.all([
    prompt(main, "Add multiply(a, b) to app.js. Reply in one short sentence."),
    prompt(fork, "Add subtract(a, b) to app.js. Reply in one short sentence."),
  ]);
  console.log("main:", mainReply);
  console.log("fork:", forkReply);

  console.log(`\nmain's app.js:\n${await appJs(main)}`);
  console.log(`fork's app.js:\n${await appJs(fork)}`);
} finally {
  for (const name of sandboxes) {
    const sandbox = await Sandbox.get({ name });
    if (sandbox.status === "running") await sandbox.stop();
    await sandbox.delete();
  }
  for (const actor of [main, fork]) await (await Drive.get({ name: actor })).delete().catch(() => {});
}
