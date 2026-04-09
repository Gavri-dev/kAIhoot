// Tiny helper to catch syntax errors before packing the extension.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(full);
    }
  }
  return files;
}

function runNodeCheck(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Syntax check failed: ${file}`)));
    child.on('error', reject);
  });
}

const files = (await walk(fileURLToPath(new URL('../scripts', import.meta.url)))).concat(await walk(fileURLToPath(new URL('../tools', import.meta.url))));
for (const file of files) {
  const info = await stat(file);
  if (info.size > 0) await runNodeCheck(file);
}
console.log(`Syntax OK for ${files.length} files.`);
