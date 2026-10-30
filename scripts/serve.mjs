// A tiny local server that behaves like GitHub Pages.
// Extensionless paths find the .html file; anything missing returns 404.html with status 404.
// Usage: node scripts/serve.mjs [port]   (default 8787)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8787);

// Folders Jekyll leaves out of the published site (see _config.yml).
const EXCLUDED = ["/checks", "/scripts", "/.gitignore", "/.pytools", "/node_modules", "/package.json", "/package-lock.json", "/_config.yml", "/.git"];

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

async function exists(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function findFile(pathname) {
  // Same resolution order GitHub Pages uses: exact file, then folder index, then .html
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  if (rel.endsWith("/")) {
    const idx = join(ROOT, rel, "index.html");
    return (await exists(idx)) ? idx : null;
  }
  const exact = join(ROOT, rel);
  if (await exists(exact)) return exact;
  const html = exact + ".html";
  if (await exists(html)) return html;
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;
  let file = null;
  if (!EXCLUDED.some((x) => pathname === x || pathname.startsWith(x + "/"))) {
    file = await findFile(pathname);
  }
  let status = 200;
  if (!file) {
    status = 404;
    file = join(ROOT, "404.html");
  }
  const body = await readFile(file);
  // No extension: GitHub Pages sends application/octet-stream for such files.
  const type = TYPES[extname(file)] || "application/octet-stream";
  res.writeHead(status, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "no-store" });
  res.end(body);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("Serving " + ROOT + " at http://127.0.0.1:" + PORT + "/");
});
