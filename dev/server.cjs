const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number.parseInt(process.argv[2] || process.env.PORT || "8124", 10);
const host = "127.0.0.1";
const plkBase = "https://pdp-api.plk-sa.pl/api/v1";

// Local Windows environments can miss the corporate/root CA that Node needs for PLK TLS.
// This applies only to the disposable development proxy, not to Home Assistant.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
  });
  res.end(body);
}

function resolveRequest(url) {
  const pathname = decodeURIComponent(new URL(url, `http://${host}:${port}`).pathname);
  let requested = pathname === "/" ? "/dev/index.html" : pathname;
  if (requested.endsWith("/")) requested += "index.html";
  if (requested === "/favicon.ico") return "favicon";

  const filePath = path.resolve(root, `.${requested}`);
  if (!filePath.startsWith(root)) return null;
  return filePath;
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${host}:${port}`);
  if (requestUrl.pathname.startsWith("/api/plk_rail_card/")) {
    handleProxy(req, res, requestUrl);
    return;
  }

  const filePath = resolveRequest(req.url);
  if (filePath === "favicon") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      send(res, 404, "Not found");
      return;
    }

    send(res, 200, data, types[path.extname(filePath).toLowerCase()] || "application/octet-stream");
  });
});

async function handleProxy(req, res, requestUrl) {
  const apiKey = req.headers["x-plk-api-key"] || process.env.PLK_API_KEY;
  if (!apiKey) {
    send(res, 401, JSON.stringify({ message: "Missing X-PLK-API-Key" }), "application/json; charset=utf-8");
    return;
  }

  const targetPath = requestUrl.pathname.replace(/^\/api\/plk_rail_card/, "");
  const target = new URL(`${plkBase}${targetPath}`);
  requestUrl.searchParams.forEach((value, key) => {
    target.searchParams.set(key, value);
  });

  try {
    const upstream = await fetch(target, {
      headers: {
        "X-API-Key": apiKey,
        "Content-Type": "application/json",
      },
    });
    const body = await upstream.text();
    send(
      res,
      upstream.status,
      body,
      upstream.headers.get("content-type") || "application/json; charset=utf-8"
    );
  } catch (error) {
    send(res, 502, JSON.stringify({ message: error.message }), "application/json; charset=utf-8");
  }
}

server.listen(port, host, () => {
  console.log(`Local test server: http://${host}:${port}/dev/`);
});

