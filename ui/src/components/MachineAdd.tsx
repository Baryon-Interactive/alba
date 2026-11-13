import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/misc';
import { CapabilitySummary } from '@/components/MachineCapabilities';
import { ErrorBox } from '@/components/common';
import type { MachineTestResult } from '@/lib/api';
import { errorText, machineCalls, useMachineChanges, useMachineGuide } from '@/lib/queries';
import { t } from '@/i18n';

type Os = 'windows' | 'linux' | 'macos';
type Step = 'basics' | 'prepare' | 'ssh' | 'test' | 'use';
type CheckKind = 'tcp' | 'http' | 'process' | 'command';
interface ServiceRow { id: string; kind: CheckKind; value: string; hint: string }

const OS_NAMES: Record<Os, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };
const ROLES = ['sim', 'package', 'gpu-qa', 'timing-baseline', 'cache', 'audio'];
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const ID_OK = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ALIAS_OK = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** What a person runs on the new machine, per OS. `key` is this computer's public key. */
export function prepareCommands(os: Os, key: string, admin: boolean): { title: string; text: string }[] {
  const k = key || '<public key of this computer>';
  if (os === 'windows') {
    // One paste in an administrator PowerShell: SSH server on and starting with Windows, this computer's key authorized, firewall open, address shown.
    const authorize = admin
      ? `$f=Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys' \nif (-not (Select-String -Path $f -SimpleMatch '${k}' -Quiet -ErrorAction SilentlyContinue)) { Add-Content -Path $f -Value '${k}' }\nicacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null`
      : `$d="$env:USERPROFILE\\.ssh"; New-Item -ItemType Directory -Force $d | Out-Null\nif (-not (Select-String -Path "$d\\authorized_keys" -SimpleMatch '${k}' -Quiet -ErrorAction SilentlyContinue)) { Add-Content -Path "$d\\authorized_keys" -Value '${k}' }`;
    return [{ title: t('Paste into PowerShell opened as administrator (one time)'), text: [
      "if ((Get-WindowsCapability -Online -Name 'OpenSSH.Server*').State -ne 'Installed') { Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0 | Out-Null }",
      'Set-Service sshd -StartupType Automatic; Start-Service sshd',
      "if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null }",
      authorize,
      "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object IPAddress, InterfaceAlias",
      "Write-Host 'SSH is ready. Enter the IP address above in the next step.'",
    ].join('\n') }];
  }
  const authorize = { title: t('Authorize this computer'), text: `mkdir -p ~/.ssh && chmod 700 ~/.ssh\necho '${k}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys` };
  if (os === 'macos') return [
    { title: t('Turn on Remote Login: System Settings → General → Sharing → Remote Login'), text: 'sudo systemsetup -setremotelogin on' },
    authorize,
    { title: t('Show the IP address to enter in the next step'), text: 'ipconfig getifaddr en0' },
  ];
  return [
    { title: t('Install and start the SSH server (Debian/Ubuntu; use dnf on Fedora)'), text: 'sudo apt install -y openssh-server\nsudo systemctl enable --now ssh' },
    authorize,
    { title: t('Show the IP address to enter in the next step'), text: 'hostname -I' },
  ];
}

export const CONNECTION_HINTS: Record<MachineTestResult['connection']['category'], string> = {
  ok: 'Connected.',
  unresolved: 'The alias is not in the SSH config and is not a known host name. Write the SSH config block first.',
  refused: 'The machine answered but nothing listens on the SSH port. Start the SSH server and allow it through the firewall.',
  timeout: 'No answer from that address. Check the IP, that the machine is on, and that both are on the same network.',
  denied: 'SSH works but the key was refused. Add the public key on the new machine. For an administrator account on Windows it must go in the ProgramData SSH administrators_authorized_keys file, with the permissions fixed.',
  'host-key': 'The host key of that machine changed since the last connection. If it was reinstalled, remove its old line from known_hosts.',
  'no-ssh': 'There is no ssh program on this computer. Install the OpenSSH client.',
  failed: 'SSH failed for another reason. Run "ssh <alias> hostname" in a terminal to see the message.',
};

function CopyBlock({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return <div className="grid gap-1">
    <div className="flex items-center justify-between gap-2"><span className="text-xs text-muted-foreground">{title}</span>
      <Button size="sm" variant="ghost" onClick={async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { toast.error(t('Could not copy: select the text and copy it by hand.')); } }}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? t('Copied') : t('Copy')}</Button></div>
    <pre className="overflow-x-auto rounded-md border bg-muted/40 p-2 text-xs leading-5 whitespace-pre">{text}</pre>
  </div>;
}

const STEPS: { id: Step; label: string; ssh?: boolean }[] = [
  { id: 'basics', label: 'Machine' }, { id: 'prepare', label: 'Prepare it', ssh: true }, { id: 'ssh', label: 'SSH on this computer', ssh: true },
  { id: 'test', label: 'Test' }, { id: 'use', label: 'Use and services' },
];

export function AddMachineDialog({ project, taken, open, onOpenChange }: { project: string; taken: string[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const guide = useMachineGuide(project, open);
  const { add } = useMachineChanges(project);
  const [step, setStep] = useState<Step>('basics');
  const [name, setName] = useState(''), [id, setId] = useState(''), [idTouched, setIdTouched] = useState(false);
  const [os, setOs] = useState<Os>('windows'), [local, setLocal] = useState(false), [admin, setAdmin] = useState(true);
  const [engine, setEngine] = useState('');
  const [keyFile, setKeyFile] = useState('');
  const [alias, setAlias] = useState(''), [host, setHost] = useState(''), [user, setUser] = useState(''), [identity, setIdentity] = useState(''), [port, setPort] = useState('22');
  const [sshState, setSshState] = useState<{ block?: string; written?: boolean; error?: string; busy?: boolean }>({});
  const [test, setTest] = useState<{ busy?: boolean; result?: MachineTestResult; error?: string }>({});
  const [rolesTouched, setRolesTouched] = useState(false);
  const [roles, setRoles] = useState<string[]>([]), [slots, setSlots] = useState('1'), [minFree, setMinFree] = useState('8'), [timing, setTiming] = useState(false);
  const [cpu, setCpu] = useState(''), [gpu, setGpu] = useState(''), [ram, setRam] = useState(''), [notes, setNotes] = useState('');
  const [services, setServices] = useState<ServiceRow[]>([]);

  useEffect(() => { if (open) {
    setStep('basics'); setName(''); setId(''); setIdTouched(false); setKeyFile(''); setOs('windows'); setLocal(false); setAdmin(true); setAlias(''); setHost(''); setUser(''); setIdentity(''); setPort('22');
    setSshState({}); setTest({}); setRoles([]); setRolesTouched(false); setSlots('1'); setMinFree('8'); setTiming(false); setCpu(''); setGpu(''); setRam(''); setNotes(''); setServices([]); add.reset();
  } }, [open]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!idTouched) setId(slug(name)); }, [name, idTouched]);
  useEffect(() => { const keys = guide.data?.publicKeys ?? []; if (keys.length && !keyFile) setKeyFile(keys.find(k => k.file.includes('ed25519'))?.file ?? keys[0].file); }, [guide.data, keyFile]);
  useEffect(() => { if (keyFile && !identity) setIdentity(`~/.ssh/${keyFile.replace(/\.pub$/, '')}`); }, [keyFile]);   // eslint-disable-line react-hooks/exhaustive-deps

  const steps = STEPS.filter(s => !(local && s.ssh));
  const at = steps.findIndex(s => s.id === step);
  const key = guide.data?.publicKeys.find(k => k.file === keyFile)?.key ?? '';
  const sshAlias = alias || id;
  const machine = useMemo(() => {
    const m: Record<string, unknown> = { id, name: name || id, os, connect: local ? { local: true } : { ssh: sshAlias }, roles, slots: Number(slots) || 1, min_free_mem_gb: Number(minFree) || 0, timing_allowed: timing };
    if (engine) m.engine = engine;
    const hardware: Record<string, unknown> = {}; if (cpu) hardware.cpu = cpu; if (gpu) hardware.gpu = gpu; if (Number(ram) > 0) hardware.ram_gb = Number(ram);
    m.hardware = hardware; if (notes.trim()) m.notes = notes.trim();
    m.services = services.filter(s => s.id && s.value).map(s => ({ id: s.id, check: s.kind === 'command' ? { command: s.value.split(' ').filter(Boolean) } : { [s.kind]: s.value }, ...(s.hint ? { start_hint: s.hint } : {}) }));
    return m;
  }, [id, name, os, engine, local, sshAlias, roles, slots, minFree, timing, cpu, gpu, ram, notes, services]);

  const basicsOk = ID_OK.test(id) && !taken.includes(id);
  const sshOk = ALIAS_OK.test(sshAlias);
  const canNext = step === 'basics' ? basicsOk : step === 'ssh' ? sshOk : step === 'test' ? !!test.result?.connection.ok : true;

  const sshBlock = async (write: boolean) => {
    setSshState(s => ({ ...s, busy: true, error: undefined }));
    try {
      const r = await machineCalls.sshBlock({ project, alias: sshAlias, hostname: host, user, identity_file: identity || undefined, port: Number(port) || undefined, write });
      setSshState({ block: r.block, written: r.written });
      if (r.written) toast.success(t('Written to {file}', { file: r.file ?? '' }));
    } catch (e) { setSshState({ error: errorText(e) }); }
  };
  const runTest = async () => {
    setTest({ busy: true });
    try {
      const result = await machineCalls.test(project, { os, connect: local ? { local: true } : { ssh: sshAlias } });
      setTest({ result });
      const total = result.capabilities?.ram_gb ?? result.reading?.total_mem_gb;
      if (total && !ram) setRam(String(Math.round(total)));
      const caps = result.capabilities;
      if (caps && !caps.error) {
        if (!cpu && caps.cpu) setCpu(caps.cpu);
        const gpu0 = caps.gpus.find(g => g.vendor === 'amd' || g.vendor === 'nvidia') ?? caps.gpus[0];
        if (!gpu && gpu0) setGpu(gpu0.name);
        if (!rolesTouched && result.suggestions) setRoles(result.suggestions.roles.map(r => r.role));
      }
    } catch (e) { setTest({ error: errorText(e) }); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="w-[min(94vw,46rem)]">
      <DialogTitle>{t('Add a machine')}</DialogTitle>
      <DialogDescription>{t('alba reaches other machines over SSH with a key, never a password. The guide sets that up step by step, tests it, and writes the machine into the registry.')}</DialogDescription>
      <ol className="flex flex-wrap gap-1" aria-label={t('Steps')}>{steps.map((s, i) => <li key={s.id}><Badge tone={i === at ? 'primary' : i < at ? 'success' : 'outline'}>{i + 1}. {t(s.label)}</Badge></li>)}</ol>

      {step === 'basics' && <div className="grid gap-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1"><Label>{t('Name')}</Label><Input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder={t('Build box')} /></div>
          <div className="grid gap-1"><Label>{t('Id')}</Label><Input value={id} onChange={e => { setIdTouched(true); setId(e.target.value); }} className="font-mono" placeholder="build-box" aria-invalid={id !== '' && !basicsOk} />
            {id !== '' && !ID_OK.test(id) && <span className="text-xs text-destructive">{t('Lower-case letters, digits, hyphens or underscores.')}</span>}
            {taken.includes(id) && <span className="text-xs text-destructive">{t('There is a machine "{id}" already.', { id })}</span>}</div>
        </div>
        <div className="grid gap-1"><Label>{t('Operating system')}</Label>
          <Select value={os} onChange={e => setOs(e.target.value as Os)}><option value="windows">Windows</option><option value="linux">Linux</option><option value="macos">macOS</option></Select></div>
        <div className="grid gap-1"><Label>{t('Engine module')}</Label>
          <Select value={engine} onChange={e => { setEngine(e.target.value); setTest({}); }}><option value="">{t('Use project selection')}</option><option value="unreal">Unreal Engine</option><option value="unity">Unity</option><option value="godot">Godot</option></Select></div>
        <div className="grid gap-2">
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={!local} onChange={() => setLocal(false)} />{t('Another machine on the network (SSH)')}</label>
          <label className="flex items-center gap-2 text-sm"><input type="radio" checked={local} onChange={() => setLocal(true)} />{t('This computer (the one running alba)')}</label>
        </div>
      </div>}

      {step === 'prepare' && <div className="grid gap-3">
        <p className="text-sm">{t('Do this on the new machine. Give it a fixed IP first (a DHCP reservation on the router), or the probes break when the address changes.')}</p>
        {guide.data && (guide.data.publicKeys.length
          ? <div className="grid gap-1"><Label>{t('Public key of this computer')}</Label>
              <Select value={keyFile} onChange={e => { setKeyFile(e.target.value); setIdentity(`~/.ssh/${e.target.value.replace(/\.pub$/, '')}`); }}>{guide.data.publicKeys.map(k => <option key={k.file} value={k.file}>{k.file}</option>)}</Select></div>
          : <CopyBlock title={t('This computer has no SSH key yet. Make one here first, then reopen this guide:')} text="ssh-keygen -t ed25519" />)}
        {os === 'windows' && <label className="flex items-center gap-2 text-sm"><Checkbox checked={admin} onCheckedChange={v => setAdmin(v === true)} />{t('The login account on the new machine is an administrator')}</label>}
        {prepareCommands(os, key, admin).map(c => <CopyBlock key={c.title} title={c.title} text={c.text} />)}
      </div>}

      {step === 'ssh' && <div className="grid gap-3">
        <p className="text-sm">{t('This computer needs a short name (an alias) for the new machine in its SSH config. alba stores only the alias.')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-1"><Label>{t('Alias')}</Label><Input value={alias} onChange={e => setAlias(e.target.value)} className="font-mono" placeholder={id} aria-invalid={!sshOk} /></div>
          <div className="grid gap-1"><Label>{t('IP address or host name')}</Label><Input value={host} onChange={e => setHost(e.target.value)} className="font-mono" placeholder="192.0.2.20" /></div>
          <div className="grid gap-1"><Label>{t('Login name on that machine')}</Label><Input value={user} onChange={e => setUser(e.target.value)} className="font-mono" /></div>
          <div className="grid gap-1"><Label>{t('Private key file')}</Label><Input value={identity} onChange={e => setIdentity(e.target.value)} className="font-mono" placeholder="~/.ssh/id_ed25519" /></div>
          <div className="grid gap-1"><Label>{t('Port')}</Label><Input value={port} onChange={e => setPort(e.target.value)} className="font-mono" /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={!host || !user || sshState.busy} onClick={() => void sshBlock(false)}>{t('Show the block')}</Button>
          <Button disabled={!host || !user || sshState.busy || sshState.written} onClick={() => void sshBlock(true)}>{sshState.written ? t('Written') : t('Write it into the SSH config')}</Button>
          <span className="self-center text-xs text-muted-foreground">{t('Skip this if the alias is already in your SSH config.')}</span>
        </div>
        {sshState.error && <ErrorBox error={sshState.error} />}
        {sshState.block && <CopyBlock title={guide.data?.sshConfig ?? '~/.ssh/config'} text={sshState.block} />}
      </div>}

      {step === 'test' && <div className="grid gap-3">
        <p className="text-sm">{local ? t('alba reads memory, disks and load of this computer.') : t('alba logs in once with the key (no password), records the host key on first contact, then reads memory, disks and load.')}</p>
        <div><Button disabled={test.busy} onClick={() => void runTest()}>{test.busy ? t('Testing…') : t('Test the connection')}</Button></div>
        {test.error && <ErrorBox error={test.error} />}
        {test.result && <div className="grid gap-2 rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2"><Badge tone={test.result.connection.ok ? 'success' : 'danger'}>{test.result.connection.ok ? t('Connected') : t('Not connected')}</Badge>
            {test.result.connection.remoteName && <span className="font-mono text-xs">{test.result.connection.remoteName}</span>}<span className="text-xs text-muted-foreground">{test.result.connection.seconds} s</span></div>
          {!test.result.connection.ok && <p>{t(CONNECTION_HINTS[test.result.connection.category], { alias: sshAlias })}</p>}
          {test.result.connection.detectedOs && test.result.connection.detectedOs !== os && <div className="flex flex-wrap items-center gap-2 text-warning">
            <span>{t('This looks like {os}. Switch the operating system to it?', { os: OS_NAMES[test.result.connection.detectedOs] })}</span>
            <Button size="sm" variant="outline" onClick={() => { setOs(test.result!.connection.detectedOs!); setTest({}); }}>{t('Switch to {os}', { os: OS_NAMES[test.result.connection.detectedOs] })}</Button></div>}
          {test.result.reading && (test.result.reading.error ? <p className="text-destructive">{t('Connected, but the health probe failed. Check that the operating system chosen in the first step is right, and that PowerShell (Windows) or sh, awk and df (Linux, macOS) are available.')}</p>
            : <p className="text-muted-foreground">{t('Free / total memory')}: {test.result.reading.free_mem_gb?.toFixed(1)} / {test.result.reading.total_mem_gb?.toFixed(1)} GB · {t('Disks')}: {test.result.reading.disks.length}</p>)}
          {test.result.capabilities && <div className="border-t pt-2"><CapabilitySummary caps={test.result.capabilities} suggestions={test.result.suggestions} /></div>}
        </div>}
      </div>}

      {step === 'use' && <div className="grid gap-3">
        {test.result?.suggestions && test.result.suggestions.roles.length > 0 && <p className="text-xs text-muted-foreground">{t('Roles the scan supports are preselected. Click a role to change it.')}</p>}
        <div className="grid gap-1"><Label>{t('Machine roles')}</Label><div className="flex flex-wrap gap-1">{[...ROLES, ...(test.result?.suggestions?.roles.some(r => r.role === 'compile-helper') ? ['compile-helper'] : [])].map(r => <button key={r} type="button" onClick={() => { setRolesTouched(true); setRoles(rs => rs.includes(r) ? rs.filter(x => x !== r) : [...rs, r]); }}><Badge tone={roles.includes(r) ? 'primary' : 'outline'}>{r}</Badge></button>)}</div></div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="grid gap-1"><Label>{t('Slots')}</Label><Input value={slots} onChange={e => setSlots(e.target.value)} inputMode="numeric" /></div>
          <div className="grid gap-1"><Label>{t('Minimum free memory (GB)')}</Label><Input value={minFree} onChange={e => setMinFree(e.target.value)} inputMode="decimal" /></div>
          <div className="grid gap-1"><Label>{t('Memory (GB)')}</Label><Input value={ram} onChange={e => setRam(e.target.value)} inputMode="decimal" /></div>
          <div className="grid gap-1"><Label>CPU</Label><Input value={cpu} onChange={e => setCpu(e.target.value)} /></div>
          <div className="grid gap-1"><Label>GPU</Label><Input value={gpu} onChange={e => setGpu(e.target.value)} /></div>
          <label className="flex items-center gap-2 self-end pb-1 text-sm"><Checkbox checked={timing} onCheckedChange={v => setTiming(v === true)} />{t('Timing allowed')}</label>
        </div>
        <div className="grid gap-1"><Label>{t('Notes')}</Label><Input value={notes} onChange={e => setNotes(e.target.value)} /></div>
        <div className="grid gap-2"><div className="flex items-center justify-between"><Label>{t('Services')}</Label>
          <Button size="sm" variant="ghost" onClick={() => setServices(s => [...s, { id: '', kind: 'process', value: '', hint: '' }])}><Plus className="size-3.5" />{t('Add a service')}</Button></div>
          {services.length === 0 && <p className="text-xs text-muted-foreground">{t('Optional: what must be running there (a compile agent, a cache server). alba checks it and shows the start hint when it is down.')}</p>}
          {services.map((s, i) => <div key={i} className="grid gap-1 rounded-md border p-2 sm:grid-cols-[8rem_7rem_1fr_auto]">
            <Input value={s.id} onChange={e => setServices(ss => ss.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} placeholder="id" className="font-mono" />
            <Select value={s.kind} onChange={e => setServices(ss => ss.map((x, j) => j === i ? { ...x, kind: e.target.value as CheckKind } : x))}><option value="process">process</option><option value="tcp">tcp</option><option value="http">http</option><option value="command">command</option></Select>
            <Input value={s.value} onChange={e => setServices(ss => ss.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} className="font-mono" placeholder={s.kind === 'process' ? 'agent.exe' : s.kind === 'tcp' ? 'host:port' : s.kind === 'http' ? 'http://host:port/health' : 'program --check'} />
            <Button size="icon" variant="ghost" aria-label={t('Remove')} onClick={() => setServices(ss => ss.filter((_, j) => j !== i))}><X className="size-4" /></Button>
            <Input className="sm:col-span-4" value={s.hint} onChange={e => setServices(ss => ss.map((x, j) => j === i ? { ...x, hint: e.target.value } : x))} placeholder={t('Start hint shown when it is down (optional)')} />
          </div>)}
        </div>
        {add.isError && <ErrorBox error={errorText(add.error)} />}
        {guide.data?.registry && <p className="text-xs text-muted-foreground">{t('Saved to {file}; a copy of the old file is kept.', { file: guide.data.registry })}</p>}
      </div>}

      <DialogFooter>
        <Button variant="ghost" onClick={() => at > 0 ? setStep(steps[at - 1].id) : onOpenChange(false)}>{at > 0 ? t('Back') : t('Cancel')}</Button>
        {step !== 'use'
          ? <Button disabled={!canNext} onClick={() => setStep(steps[at + 1].id)}>{t('Next')}</Button>
          : <Button disabled={add.isPending || !basicsOk} onClick={() => add.mutate(machine, { onSuccess: () => onOpenChange(false) })}>{add.isPending ? t('Working…') : t('Add the machine')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
