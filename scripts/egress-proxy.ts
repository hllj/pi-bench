// Allowlisting HTTP/HTTPS forward proxy -- the ONLY way out of a sealed
// SWE-bench task container (see run-swe-bench.sh, sealed mode).
//
// The task container sits on an `--internal` docker network (no route to
// anything outside it). This proxy runs in a second container attached to
// both that internal network and the normal bridge, and forwards only to
// the host:port pairs in EGRESS_ALLOW (the agent/judge LLM endpoints). Every
// other destination -- pypi.org, github.com, raw.githubusercontent.com, ... --
// gets a 403, no matter whether the request came from bash, python urllib,
// pip, a subagent, or an in-process extension tool.
//
// Every decision is logged to stdout as one JSON line, so the host can pull
// `docker logs` for a task's time window as tamper-proof evidence of what the
// agent tried to reach (the agent can't touch this container's logs).
//
// Env:
//   EGRESS_ALLOW   comma-separated host:port list, e.g. "openrouter.ai:443,host.docker.internal:8000"
//   EGRESS_PORT    listen port (default 3128)

import http from "node:http";
import net from "node:net";
import { isEgressAllowed, parseEgressAllowlist } from "../src/egress";

const allow = parseEgressAllowlist(process.env.EGRESS_ALLOW || "");
const listenPort = Number(process.env.EGRESS_PORT || 3128);

function log(decision: "allow" | "deny", method: string, target: string, client: string | undefined) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), decision, method, target, client }));
}

const server = http.createServer((req, res) => {
  // Plain-HTTP forward proxying: the request line carries an absolute URL
  // (e.g. a local llama.cpp server at http://host.docker.internal:8080).
  let url: URL;
  try {
    url = new URL(req.url || "");
  } catch {
    res.writeHead(400).end("egress-proxy: expected absolute-form request URL\n");
    return;
  }
  const port = url.port ? Number(url.port) : 80;
  const target = `${url.hostname}:${port}`;
  if (url.protocol !== "http:" || !isEgressAllowed(url.hostname, port, allow)) {
    log("deny", req.method || "GET", target, req.socket.remoteAddress);
    res.writeHead(403, { "content-type": "text/plain" }).end(
      `egress-proxy: ${target} is blocked (benchmark sandbox: no internet access)\n`
    );
    return;
  }
  log("allow", req.method || "GET", target, req.socket.remoteAddress);
  const upstream = http.request(
    { host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    }
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502);
    res.end(`egress-proxy: upstream error: ${e.message}\n`);
  });
  req.pipe(upstream);
});

// HTTPS: CONNECT host:port tunnel. The payload is TLS end to end; the proxy
// only ever decides on the destination.
server.on("connect", (req, clientSocket: net.Socket, head) => {
  const [host, portStr] = (req.url || "").split(":");
  const port = Number(portStr || 443);
  const target = `${host}:${port}`;
  if (!host || !isEgressAllowed(host, port, allow)) {
    log("deny", "CONNECT", target, clientSocket.remoteAddress);
    clientSocket.end(
      `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\negress-proxy: ${target} is blocked (benchmark sandbox: no internet access)\n`
    );
    return;
  }
  log("allow", "CONNECT", target, clientSocket.remoteAddress);
  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", close);
  clientSocket.on("error", close);
});

server.listen(listenPort, "0.0.0.0", () => {
  console.error(`[egress-proxy] listening on :${listenPort}, allow=${[...allow].join(",") || "(nothing)"}`);
});
