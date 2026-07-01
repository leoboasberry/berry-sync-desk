import { createServer } from "node:http";
import { Readable } from "node:stream";

const { default: handler } = await import("./dist/server/server.js");

const port = parseInt(process.env.PORT ?? "3000", 10);

createServer(async (req, res) => {
  const host = req.headers.host ?? "localhost";
  const url = new URL(req.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: body?.length ? body : undefined,
    duplex: "half",
  });

  const response = await handler.fetch(request, {}, {});

  const outHeaders = {};
  response.headers.forEach((v, k) => { outHeaders[k] = v; });
  res.writeHead(response.status, outHeaders);

  if (response.body) {
    Readable.fromWeb(response.body).pipe(res);
  } else {
    res.end();
  }
}).listen(port, () => {
  console.log(`Berry Sync listening on port ${port}`);
});
