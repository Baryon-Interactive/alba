#!/usr/bin/env node
// In a checkout, runs the TypeScript sources directly (Node strips the types), so nothing needs building. An installed package
// has no src/ (Node does not strip types under node_modules): it runs the JavaScript built into dist/ (scripts/build.mjs).
// The experimental-feature warning is hidden.
import { existsSync } from 'node:fs';

process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.error(w); });
const sources = new URL('../src/cli/main.ts', import.meta.url);
await import(existsSync(sources) ? sources.href : new URL('../dist/cli/main.js', import.meta.url).href);
