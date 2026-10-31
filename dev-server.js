"use strict";


const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "public");
const port = 5500;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http
  .createServer((req, res) => {
    let urlPath = "/";
    try {
      urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    } catch (e) {
      res.writeHead(400);
      return res.end("Permintaan tidak valid");
    }
 
    if (rel === "/") rel = "/index.html";
    else if (!path.extname(rel)) rel = rel + ".html";

    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403);
      return res.end("Dilarang");
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        return res.end("Tidak ditemukan");
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => {
    console.log("Server lokal: http://127.0.0.1:" + port);
  });