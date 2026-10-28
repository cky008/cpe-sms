import fs from "node:fs";
import path from "node:path";

const srcPublic = path.resolve(process.cwd(), "src", "web", "public");
const distPublic = path.resolve(process.cwd(), "dist", "web", "public");

fs.mkdirSync(distPublic, { recursive: true });
for (const ent of fs.readdirSync(srcPublic, { withFileTypes: true })) {
  if (ent.isFile()) {
    fs.copyFileSync(path.join(srcPublic, ent.name), path.join(distPublic, ent.name));
  }
}
fs.chmodSync(path.resolve(process.cwd(), "dist", "cli.js"), 0o755);
