import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function findRuntimeModule() {
  const specPath = process.env.ALBA_CONSULT;
  if (specPath && existsSync(specPath)) {
    try {
      const spec = JSON.parse(readFileSync(specPath, 'utf8'));
      if (spec && typeof spec.runtime_module === 'string' && existsSync(spec.runtime_module)) return spec.runtime_module;
    } catch { /* fall through */ }
  }
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const originFile = path.join(dir, 'consult-origin.json');
  if (existsSync(originFile)) {
    try {
      const origin = JSON.parse(readFileSync(originFile, 'utf8'));
      if (origin && typeof origin.runtime_module === 'string' && existsSync(origin.runtime_module)) return origin.runtime_module;
    } catch { /* fall through */ }
  }
  for (const name of ['runtime.js', 'runtime.ts']) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const runtimePath = findRuntimeModule();
if (!runtimePath) {
  process.stderr.write('Consult refused: Alba consult runtime could not be located.\n');
  process.exitCode = 1;
} else {
  const { runConsult } = await import(pathToFileURL(runtimePath).href);
  const res = await runConsult(process.argv.slice(2));
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exitCode = res.code;
}
