import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';

const args = process.argv.slice(2);
const arg = name => args[args.indexOf(name) + 1];
const engine = args[0] === 'pack' ? 'vesper' : args[0] === 'BuildCookRun' ? 'unreal' : args[0] === '--headless' ? 'godot' : 'unity';
const key = process.env.GODOT_SCRIPT_ENCRYPTION_KEY;
appendFileSync(process.env.DEMO_RELEASE_TRACE, JSON.stringify({ engine, args, cwd: process.cwd(), mappedKey: !!key,
  sourceKey: !!process.env.DEMO_GODOT_KEY }) + '\n');

if (process.env.DEMO_RELEASE_FAIL === '1') {
  console.error('Fixture engine failed');
  process.exit(7);
}

if (engine === 'unity') {
  writeFileSync(arg('-logFile'), 'Unity editor log\n');
  const output = arg('-albaOutput');
  const dir = path.dirname(output);
  const name = path.parse(output).name;
  if (arg('-albaBackend') === 'mono') {
    mkdirSync(path.join(dir, `${name}_Data`, 'Managed'), { recursive: true });
    writeFileSync(path.join(dir, `${name}_Data`, 'Managed', 'Demo.dll'), 'fixture');
  } else writeFileSync(path.join(dir, 'GameAssembly.dll'), 'fixture');
} else if (engine === 'unreal') {
  const dir = args.find(value => value.startsWith('-archivedirectory=')).slice('-archivedirectory='.length);
  const pak = Buffer.alloc(221);
  pak[16] = 1;
  pak.writeUInt32LE(0x5a6f12e1, 17);
  pak.writeUInt32LE(11, 21);
  writeFileSync(path.join(dir, 'demo.pak'), pak);
  writeFileSync(path.join(dir, 'demo.sig'), 'fixture');
  const ini = readFileSync(path.join('Config', 'DefaultCrypto.ini'), 'utf8');
  console.log('Crypto key from editor:', /^EncryptionKey=(.+)$/m.exec(ini)?.[1]);
} else if (engine === 'godot') {
  const output = args[3];
  writeFileSync(output, 'fixture');
  const pck = Buffer.alloc(112);
  pck.write('GDPC');
  pck.writeUInt32LE(2, 4);
  pck.writeUInt32LE(+!!key, 20);
  writeFileSync(path.join(path.dirname(output), `${path.parse(output).name}.pck`), pck);
  if (key) {
    process.stdout.write('Godot key: ' + key.slice(0, 33));
    await setTimeout(40);
    process.stdout.write(key.slice(33).toLowerCase() + '\n');
    process.stderr.write('Godot key again: ' + key + '\n');
  }
} else {
  mkdirSync(arg('--output'));
  writeFileSync(path.join(arg('--output'), 'demo.pack'), 'fixture');
}
console.log(`Finished ${engine}`);
