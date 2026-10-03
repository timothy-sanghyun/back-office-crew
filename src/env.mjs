// Tiny .env loader (no dependency). Existing environment variables win.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnv() {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') process.env[m[1]] = v;
  }
}
