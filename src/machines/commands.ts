import { gzipSync } from 'node:zlib';
import path from 'node:path';
import type { Machine } from './config.ts';

/** Standard target OS locations, independent of the host OS and user profile. */
export const posixSystemPath = (...parts: string[]): string => path.posix.join(path.posix.sep, ...parts);

/** A PowerShell command. The script travels gzip-compressed behind a short loader: an SSH login whose shell is cmd.exe
 * refuses command lines over 8191 characters, and -EncodedCommand (UTF-16 in base64) nearly triples a script's size. */
export const ps = (script: string) => {
  const packed = gzipSync(Buffer.from(`[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'\n${script}`, 'utf8')).toString('base64');
  const loader = `$ProgressPreference='SilentlyContinue'; iex ([IO.StreamReader]::new([IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${packed}')), [IO.Compression.CompressionMode]::Decompress))).ReadToEnd()`;
  return ['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(loader, 'utf16le').toString('base64')];
};
export const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const shQuote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=30'];
/** A command for the machine, as run from the alba host. */
export function onMachine(machine: Machine, argv: string[]): string[] {
  if ('local' in machine.connect) return argv;
  return ['ssh', ...SSH, machine.connect.ssh, machine.os === 'windows' ? argv.join(' ') : argv.map(shQuote).join(' ')];
}
