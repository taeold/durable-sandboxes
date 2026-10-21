# Durable Sandboxes

A proof of concept for actor-like programs on Vercel Drive and Vercel Sandbox, in the style of Cloudflare Durable Objects and Agent Substrate. Each actor is a Drive, and it runs in the one sandbox that has its Drive mounted.

## How it works

This request handler routes each request to its actor:

```ts
export default {
  async fetch(request: Request) {
    const actor = new URL(request.url).searchParams.get("actor")!;

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
      image: "pi-agent:latest",
      mounts: { "/workspace": drive },
      ports: [3000],
      timeout: 10 * 60_000, // sandbox goes away after 10 min, drive stays
    });
    await sandbox.runCommand({ cmd: "node", args: ["/app/server.ts"], detached: true });
    return sandbox;
  } catch (error) {
    // someone else mounted it first, use theirs
    if (error instanceof APIError && error.response.status === 409) {
      return sandboxFor(await Drive.get({ name: drive.name }));
    }
    throw error;
  }
}
```

The full file, with imports, settings and `forward`, is [`router.ts`](router.ts).

To put an actor to sleep, stop its sandbox. To fork an actor, fork its Drive:

```ts
const drive = await Drive.get({ name: "agent-alice" });
await (await Sandbox.get({ name: drive.currentSandboxName! })).stop();
await drive.fork({ name: "agent-alice-2" });
```

The program is any HTTP server that listens on `$PORT` and keeps its state in `/workspace`. Here it is the Pi coding agent in [`agent/`](agent), which keeps its files and conversation there.

## Run it

You need Node 24, Docker, and a Vercel account.

```sh
npm install
vercel link
vercel env pull                                  # writes a Vercel token to .env.local
echo "AI_GATEWAY_API_KEY=<your key>" >> .env.local
vercel vcr login docker
vercel vcr build docker agent pi-agent:latest --push
npm run demo
```

The agent can see the Gateway key, so give it a low spending limit.

[`demo.ts`](demo.ts) calls the router to run one turn, puts the actor to sleep, forks it, and sends a different second turn to each actor:

```text
main: Created `app.js`, which exports an `add(a, b)` function that returns the sum of its two arguments.
main: I added `multiply(a, b)` to `app.js`, returning the product of its arguments, and exported it alongside `add`.
fork: I added `subtract(a, b)` to `app.js` and exported it alongside `add`.

main's app.js:
function add(a, b) {
  return a + b;
}

function multiply(a, b) {
  return a * b;
}

module.exports = { add, multiply };

fork's app.js:
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

module.exports = { add, subtract };
```

## Limitations

- A sandbox stops 10 minutes after it starts, busy or not.
- A fork or a read-only copy of an actor's Drive shows its state as of the actor's last stop.
- Waking an actor takes a few seconds.
- The sandbox URL is public and has no authentication.
- If the program crashes, requests to its actor fail with 504 after 30 seconds. There are no restarts, alarms, or WebSockets.
- Each awake actor is a whole VM. The Hobby plan allows 10 at a time.

## License

Apache-2.0
