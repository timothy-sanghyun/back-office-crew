// Usage: echo VALUE | node scripts/set-env.mjs KEY   — writes KEY=VALUE into .env safely.
import fs from 'node:fs';
const key = process.argv[2];
const value = fs.readFileSync(0, 'utf8').trim();
if (!key || !value) process.exit(0);
const file = new URL('../.env', import.meta.url);
let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
const i = lines.findIndex((l) => l.startsWith(key + '='));
if (i >= 0) lines[i] = `${key}=${value}`; else lines.push(`${key}=${value}`);
fs.writeFileSync(file, lines.join('\n'));
