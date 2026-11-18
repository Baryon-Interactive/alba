import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fail, releaseText as text, t } from '../i18n.ts';
import { ioStoreEncrypted, pakEncrypted, pckEncrypted } from './archive.ts';
import { FINDING_IDS, validateRelease, type AuditPolicy, type FindingId, type ReleaseEngine } from './config.ts';
import { secretScanner } from './secrets.ts';

type Severity = 'fail' | 'warn';
export interface Finding {
  id: FindingId;
  severity: Severity;
  files: string[];
  advice: string;
  reason?: string;
  excerpts?: Record<string, string>;
}
export interface AuditResult {
  engine: ReleaseEngine | null;
  findings: Finding[];
  summary: Record<Severity, number>;
}

interface Entry { relative: string; directory: boolean }

async function entries(dir: string): Promise<Entry[]> {
  const found: Entry[] = [];
  const remaining = [''];
  while (remaining.length) {
    const parent = remaining.pop()!;
    for (const item of await readdir(path.join(dir, parent), { withFileTypes: true })) {
      if (!item.isDirectory() && !item.isFile()) continue;
      const relative = parent ? `${parent}/${item.name}` : item.name;
      found.push({ relative, directory: item.isDirectory() });
      if (item.isDirectory()) remaining.push(relative);
    }
  }
  return found.sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
}

const monoRuntime = /(?:^|\/)MonoBleedingEdge$/i;
const managedDll = /^((?:.*\/)?[^/]+_Data)\/Managed\/([^/]+)\.dll$/i;
const engineAssembly = /^(?:UnityEngine|Unity\.|System|Mono\.)|^(?:mscorlib|netstandard)$/i;
const gameAssembly = /(?:^|\/)GameAssembly\.(?:dll|so)$/i;
const il2cppData = /(?:^|\/)il2cpp_data$/i;
const webFile = /(?:^|\/)Build\/[^/]+\.(?:data|wasm)[^/]*$/i;
const backup = /_(?:BackUpThisFolder_ButDontShipItWithYourGame|BurstDebugInformation_DoNotShip)$/i;
const symbols = /\.(?:pdb|dsym|debug|sym)$|(?:^|\/)Manifest_DebugFiles_[^/]*\.txt$/i;
const pak = /\.pak$/i, utoc = /\.utoc$/i, pck = /\.pck$/i;
const executable = /\.(?:exe|x86_64|arm64|aarch64|x86_32|arm32|bin)$/i;

function guessEngine(files: Entry[]): ReleaseEngine | null {
  if (files.some(({ relative }) => pak.test(relative) || utoc.test(relative) || /\.ucas$/i.test(relative))) return 'unreal';
  if (files.some(({ relative }) => pck.test(relative) || /(?:^|\/)project\.godot$/i.test(relative))) return 'godot';
  if (files.some(({ relative }) => monoRuntime.test(relative) || gameAssembly.test(relative) || il2cppData.test(relative) ||
    backup.test(relative) || managedDll.test(relative) || webFile.test(relative))) return 'unity';
  return null;
}

const advice: Record<FindingId, string> = {
  'mono-assemblies': text.auditMono, 'il2cpp-backup': text.auditBackup, 'debug-symbols': text.auditSymbols,
  'unencrypted-pak': text.auditPak, 'pak-unreadable': text.auditUnreadable, 'unsigned-pak': text.auditSignature,
  'godot-unencrypted-pck': text.auditGodot, secrets: text.auditSecrets, 'web-build': text.auditWeb,
};

export async function auditBuild(dir: string, selected?: ReleaseEngine,
  policy: AuditPolicy = validateRelease({}, '').audit, signPak = true): Promise<AuditResult> {
  let listing: Entry[];
  try { listing = await entries(dir); } catch { return fail(text.auditFolder, { dir }); }
  let engine = selected ?? guessEngine(listing);
  const files = new Set(listing.filter(entry => !entry.directory).map(({ relative }) => relative.toLowerCase()));
  const dirs = new Set(listing.filter(entry => entry.directory).map(({ relative }) => relative.toLowerCase()));
  const hits = new Map<FindingId, string[]>();
  const excerpts: Record<string, string> = Object.create(null);
  const scanSecret = secretScanner(policy.extra_secret_patterns);
  const add = (id: FindingId, relative: string) => {
    if (!hits.has(id)) hits.set(id, []);
    hits.get(id)!.push(relative);
  };

  for (const { relative, directory } of listing) {
    const absolute = path.join(dir, relative);
    if (symbols.test(relative)) add('debug-symbols', relative);
    if (directory && backup.test(relative)) add('il2cpp-backup', relative);
    if (engine === 'unity') {
      const managed = managedDll.exec(relative);
      if (directory && monoRuntime.test(relative)) add('mono-assemblies', relative);
      if (!directory && managed && !engineAssembly.test(managed[2])) {
        const data = managed[1].toLowerCase();
        const parent = data.slice(0, data.lastIndexOf('/') + 1);
        if (!dirs.has(`${data}/il2cpp_data`) && !files.has(`${parent}gameassembly.dll`) && !files.has(`${parent}gameassembly.so`)) {
          add('mono-assemblies', relative);
        }
      }
      if (!directory && webFile.test(relative)) add('web-build', relative);
    }
    if (directory) continue;
    let unreadableArchive = false;
    if (engine === 'unreal' && (pak.test(relative) || utoc.test(relative))) {
      const isPak = pak.test(relative);
      const encrypted = await (isPak ? pakEncrypted(absolute) : ioStoreEncrypted(absolute));
      if (encrypted === undefined) { add('pak-unreadable', relative); unreadableArchive = true; }
      else if (!encrypted) add('unencrypted-pak', relative);
      if (isPak && signPak) {
        const lower = relative.toLowerCase();
        if (!files.has(lower.replace(/\.pak$/, '.sig')) && !files.has(`${lower}.sig`)) add('unsigned-pak', relative);
      }
    }
    if (engine === null || engine === 'godot') {
      const standalone = pck.test(relative);
      if (standalone || executable.test(relative) || !path.extname(relative)) {
        const encrypted = await pckEncrypted(absolute, !standalone);
        if (encrypted !== undefined) engine = 'godot';
        if (encrypted === false) add('godot-unencrypted-pck', relative);
      }
    }
    try {
      const excerpt = await scanSecret(absolute, relative, (await stat(absolute)).size);
      if (excerpt) { add('secrets', relative); excerpts[relative] = excerpt; }
    } catch { if (!unreadableArchive) return fail(text.auditFile, { file: relative }); }
  }

  const summary = { fail: 0, warn: 0 };
  const findings = FINDING_IDS.flatMap((id): Finding[] => {
    const paths = hits.get(id);
    if (!paths?.length) return [];
    const reason = policy.allow.find(entry => entry.id === id)?.reason;
    const severity = !reason && id !== 'pak-unreadable' && id !== 'web-build' && policy.fail_on.includes(id) ? 'fail' : 'warn';
    summary[severity]++;
    return [{ id, severity, files: paths, advice: t(advice[id]), ...(reason && { reason }), ...(id === 'secrets' && { excerpts }) }];
  });
  return { engine, findings, summary };
}
