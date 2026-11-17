import { afterEach, describe, expect, it } from "vitest";
import { SpritesClient } from "@fly/sprites";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";

// This intentionally exercises the installed SDK on the baseline Node runtime:
// mocks cannot prove that its WebSocket implementation sends auth headers or
// decodes the provider's multiplexed stream.
let server: Server | undefined;
let socket: Duplex | undefined;
afterEach(async () => { socket?.destroy(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; socket = undefined; });
function frame(payload: Buffer): Buffer { return Buffer.concat([Buffer.from([0x82, payload.length]), payload]); }
describe("Sprites SDK baseline transport", () => {
  it("passes auth and argv and decodes separate stdout, stderr and exit frames", async () => {
    server = createServer();
    const request = new Promise<{ authorization: string | undefined; commands: string[] }>(resolve => server!.on("upgrade", (req, peer) => {
      socket = peer;
      const url = new URL(req.url!, "http://localhost");
      resolve({ authorization: req.headers.authorization, commands: url.searchParams.getAll("cmd") });
      const accept = createHash("sha1").update(String(req.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      peer.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      peer.write(frame(Buffer.from([1, ...Buffer.from("hello")])));
      peer.write(frame(Buffer.from([2, ...Buffer.from("warning")])));
      peer.write(frame(Buffer.from([3, 0])));
    }));
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No transport port");
    const result = await new SpritesClient("transport-test", { baseURL: `http://127.0.0.1:${address.port}` }).sprite("test").execFile("printf", ["hello"], { timeout: 3000, maxBuffer: 20000 });
    expect(await request).toEqual({ authorization: "Bearer transport-test", commands: ["printf", "hello"] });
    expect(result).toEqual({ stdout: "hello", stderr: "warning", exitCode: 0 });
  });
});
