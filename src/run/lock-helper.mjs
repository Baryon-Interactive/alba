import { runNamedLock, usage } from './named-lock.mjs';
const args = process.argv.slice(2);
if (args.includes('list')) { process.stderr.write(`${usage()}\n`); process.exitCode = 2; }
else process.exitCode = await runNamedLock(args);
