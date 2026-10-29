import fs from "node:fs";
import path from "node:path";

const srcPublic = path.resolve(process.cwd(), "src", "web", "public");
const distPublic = path.resolve(process.cwd(), "dist", "web", "public");

fs.mkdirSync(distPublic, { recursive: true });
fs.cpSync(srcPublic, distPublic, { recursive: true });
fs.chmodSync(path.resolve(process.cwd(), "dist", "cli.js"), 0o755);
