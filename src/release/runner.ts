import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { releaseText as text } from '../i18n.ts';
import type { BuildCommand } from './build.ts';

/** Keep enough lookahead to redact a secret split across reads, without buffering an entire line. */
function redact(secrets: string[]): Transform {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const pattern = values.length ? new RegExp(values.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi') : undefined;
  const overlap = (values[0]?.length ?? 1) - 1;
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = (chunk: string, last: boolean): string => {
    const data = pending + chunk;
    const limit = last ? data.length : Math.max(0, data.length - overlap);
    let result = '', offset = 0;
    if (pattern) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(data); match && match.index < limit; match = pattern.exec(data)) {
        result += data.slice(offset, match.index) + '<redacted>';
        offset = pattern.lastIndex;
      }
    }
    result += data.slice(offset, limit);
    pending = data.slice(Math.max(offset, limit));
    return result;
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) { callback(null, consume(decoder.write(chunk), false)); },
    flush(callback) { callback(null, consume(decoder.end(), true)); },
  });
}

function childEnvironment(references: Record<string, string>, excluded: string[]) {
  const hidden = new Set(['GODOT_SCRIPT_ENCRYPTION_KEY', ...Object.keys(references), ...Object.values(references), ...excluded]
    .map(name => process.platform === 'win32' ? name.toUpperCase() : name));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !hidden.has(process.platform === 'win32' ? name.toUpperCase() : name)));
  const secrets: string[] = [];
  for (const [name, source] of Object.entries(references)) {
    const secret = process.env[source];
    if (!secret || !/^[a-f\d]{64}$/i.test(secret)) return text.godotKey({ name: source });
    env[name] = secret;
    secrets.push(secret);
  }
  return { env, secrets };
}

function launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const stdio: ['ignore', 'pipe', 'pipe'] = ['ignore', 'pipe', 'pipe'];
  const options = { cwd, env, windowsHide: true, stdio };
  if (process.platform === 'win32' && /\.(?:bat|cmd)$/i.test(command)) {
    const words = [command, ...args];
    if (words.some(word => /["%\r\n]/.test(word))) return text.batchArgument();
    const line = words.map(word => `"${word}"`).join(' ');
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/v:off', '/s', '/c', `"${line}"`], { ...options, windowsVerbatimArguments: true });
  }
  return spawn(command, args, options);
}

export async function runBuild(build: Pick<BuildCommand, 'command' | 'args' | 'env' | 'cwd' | 'logFile'>,
  { engineLog = false, secrets = [], excludedEnv = [] }: { engineLog?: boolean; secrets?: string[]; excludedEnv?: string[] } = {}): Promise<number> {
  const childEnv = childEnvironment(build.env, excludedEnv);
  const hidden = [...secrets, ...childEnv.secrets];
  const consoleLog = engineLog ? `${build.logFile}.console` : build.logFile;
  const child = launch(build.command, build.args, build.cwd, childEnv.env);
  const log = createWriteStream(consoleLog, { flags: 'wx' });
  const combined = new PassThrough();
  // Redact again after merging so adjacent pieces from different streams cannot expose a key.
  const logDone = pipeline(combined, redact(hidden), log);
  void logDone.catch(() => child.kill());
  const exit = new Promise<number>(resolve => {
    child.once('error', () => {
      combined.write(text.launchFailed({ command: build.command }) + '\n');
    });
    child.once('close', code => resolve(code ?? 1));
  });
  const copies = [
    pipeline(child.stdout, redact(hidden), combined, { end: false }),
    pipeline(child.stderr, redact(hidden), combined, { end: false }),
  ];
  const drained = await Promise.allSettled(copies.map(copy => copy.catch(error => { child.kill(); throw error; })));
  const code = await exit;
  combined.end();
  await logDone;
  for (const result of drained) if (result.status === 'rejected') throw result.reason;
  if (engineLog) {
    // Unity owns -logFile. Append its console output after it closes the editor log.
    await pipeline(createReadStream(consoleLog), createWriteStream(build.logFile, { flags: 'a' }));
    await rm(consoleLog);
  }
  return code;
}
