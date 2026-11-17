// The Tools page's calls, answered from the three built-in plugins and the mock project file's `plugins` block (mocks/config-edit.ts).
// Nothing is started: the doctor's answer is made up.
import type { ServerResponse } from 'node:http';
import type { PluginDoctor, PluginsView, PluginView, ToolJobView } from '../../src/api/types.ts';
import { projectValues } from './config-edit.ts';

interface Ctx {
  path: string; method: string; body: any; project: string; res: ServerResponse;
  send: (res: ServerResponse, status: number, body: unknown) => void;
}

type Values = Record<string, unknown>;
const record = (v: unknown): v is Values => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const here = '/studio/alba/plugins';

/** The built-in plugins as the server shows them before the project's settings are put in. */
const KNOWN: Omit<PluginView, 'enabled' | 'kinds' | 'problems'>[] = [
  {
    id: 'example-echo', version: '1.0.0', description: 'Repeats the text it is given; an example of a tool plugin.', origin: 'built-in', folder: `${here}/example-echo`,
    settings: [], servers: [{ name: 'echo', command: 'node', args: [`${here}/example-echo/server.mjs`], tools: ['echo'], workers: true, env: [] }],
    skill: `${here}/example-echo/skills/example-echo`, probe: ['node', '--version'], resources: [],
    operations: [
      { name: 'echo', description: 'Repeats a text and keeps it as echo.txt in the job folder.', input: { type: 'object', required: ['text'] }, timeout_minutes: 10 },
      { name: 'echo-paid', description: 'The same, as a paid operation - priced by the server\'s echo_price tool at one credit per started 100 characters.', input: { type: 'object', required: ['text'] }, timeout_minutes: 10, paid: { unit: 'credits', priced_by_tool: true } },
    ],
  },
  {
    id: 'image-gateway', version: '1.0.0', description: 'Generates pictures from a prompt, or edits them from reference pictures, through an OpenAI-compatible images endpoint.', origin: 'built-in', folder: `${here}/image-gateway`,
    settings: [
      { name: 'base_url', description: 'The endpoint, without /v1 (https://api.openai.com, or a local gateway such as http://127.0.0.1:8000).', default: 'https://api.openai.com' },
      { name: 'model', description: 'The image model a call uses when it names none.', default: 'gpt-image-1' },
      { name: 'key_env', description: 'The name of the environment variable that holds the API key; empty for a gateway that needs no key. The value is never written anywhere.', default: 'OPENAI_API_KEY' },
    ],
    servers: [{ name: 'image', command: 'node', args: [`${here}/image-gateway/server.mjs`, '--base-url', '{base_url}', '--model', '{model}', '--key-env', '{key_env}'], tools: ['image_generate'], workers: true, env: [] }],
    skill: `${here}/image-gateway/skills/image-gateway`, probe: ['node', '--version'], resources: [],
    operations: [{ name: 'generate', description: 'Pictures from a prompt, guided by reference pictures when refs are given; PNG files with their real size.', input: { type: 'object', required: ['prompt'] }, timeout_minutes: 15, paid: { unit: 'images', priced_by_tool: true } }],
  },
  {
    id: 'tripo-3d', version: '1.0.0', description: 'Generates 3D models from pictures or text with Tripo Studio (the member account logged in on this machine) and downloads them.', origin: 'built-in', folder: `${here}/tripo-3d`,
    settings: [
      { name: 'server', description: 'Absolute path of a local Tripo Studio plugin\'s mcp/bootstrap.mjs (for example in the Codex plugin cache); empty to start the npm package with npx.', default: '' },
      { name: 'package', description: 'The npm package of the Tripo Studio MCP server, used when server is empty.', default: 'tripo-studio-plugin@0.3.13' },
      { name: 'ceiling', description: 'Credits a quote asks for when Tripo cannot price an operation (its quote says unknown). A person approves it; what the wallet shows was spent is booked.', default: '60' },
    ],
    servers: [
      { name: 'tripo', command: 'node', args: [`${here}/tripo-3d/start-tripo.mjs`, '--server', '{server}', '--package', '{package}'], tools: ['tripo_auth_status', 'tripo_get_payment', 'tripo_quote_operation', 'tripo_generate_model', 'tripo_export_model', 'tripo_download', 'tripo_task_wait'], workers: true, env: [] },
      { name: 'tripo-ops', command: 'node', args: [`${here}/tripo-3d/ops.mjs`, '--server', '{server}', '--package', '{package}', '--ceiling', '{ceiling}'], workers: false, env: [] },
    ],
    skill: `${here}/tripo-3d/skills/tripo-3d`, probe: ['node', `${here}/tripo-3d/start-tripo.mjs`, '--check', '--server', '{server}', '--package', '{package}'], resources: [{ name: 'tripo-wallet', slots: 1 }],
    operations: [{ name: 'generate-model', description: 'A model from a picture, from views of one object, or from text; waited for and downloaded (GLB, or exported to another format). Paid in Tripo credits.', input: { type: 'object', required: ['mode', 'face_limit'] }, timeout_minutes: 90, paid: { unit: 'credits', priced_by_tool: true } }],
  },
];

const day = () => new Date().toISOString().slice(0, 10);
const JOBS = (): ToolJobView[] => [
  { id: 'J4', tool: 'tripo-3d', version: '1.0.0', operation: 'generate-model', status: 'waiting-quote', by: 'web', order: 'ART-12', quote: { unit: 'credits', amount: 60, id: 'C3', unpriced: true, manual: 'an unpriced quote waits for a person' }, waiting: 'quote C3 of ART-12 waits for a person: alba credits approve ART-12 C3 --cap N', created: `${day()}T09:40:00.000Z` },
  { id: 'J3', tool: 'image-gateway', version: '1.0.0', operation: 'generate', status: 'done', by: 'producer', order: 'ART-11', case: 'question/ART-11', quote: { unit: 'images', amount: 2, id: 'C2', auto: true, autoAt: `${day()}T08:12:01.000Z` }, spent: 2, files: ['/studio/state/tool-jobs/J3/crate-1.png', '/studio/state/tool-jobs/J3/crate-2.png'], created: `${day()}T08:12:00.000Z`, started: `${day()}T08:12:01.000Z`, ended: `${day()}T08:12:40.000Z` },
  { id: 'J2', tool: 'image-gateway', version: '1.0.0', operation: 'generate', status: 'failed', by: 'web', order: 'ART-9', quote: { unit: 'images', amount: 1, id: 'C1', auto: true, autoAt: '2026-11-12T15:00:01.000Z' }, spent: 1, spentUnknown: true, error: 'no answer to tools/call image_generate within 900 s', created: '2026-11-12T15:00:00.000Z', started: '2026-11-12T15:00:01.000Z', ended: '2026-11-12T15:15:01.000Z' },
  { id: 'J1', tool: 'example-echo', version: '1.0.0', operation: 'echo', status: 'done', by: 'cli', files: [], created: '2026-11-10T10:00:00.000Z', started: '2026-11-10T10:00:00.500Z', ended: '2026-11-10T10:00:01.000Z' },
];

/** The view the server would give for the mock project file now. */
function viewOf(project: string): PluginsView {
  const raw = record(projectValues(project).plugins) ? projectValues(project).plugins as Values : {};
  const enable = strings(raw.enable);
  const settings = record(raw.settings) ? raw.settings : {};
  const byKind: Record<string, string[]> = {};
  if (record(raw.by_kind)) for (const [k, v] of Object.entries(raw.by_kind)) byKind[k] = strings(v);
  const tools = KNOWN.map((p): PluginView => {
    const given = record(settings[p.id]) ? settings[p.id] as Values : {};
    const value = (name: string) => (Object.hasOwn(given, name) ? String(given[name]) : p.settings.find(s => s.name === name)?.default ?? '');
    const fill = (s: string) => s.replace(/\{(\w+)\}/g, (_, n: string) => value(n));
    return {
      ...p, enabled: enable.includes(p.id),
      settings: p.settings.map(s => ({ ...s, ...(enable.includes(p.id) && Object.hasOwn(given, s.name) ? { value: String(given[s.name]) } : {}) })),
      servers: p.servers.map(s => ({ ...s, args: s.args.map(fill), env: p.id === 'image-gateway' && value('key_env') ? [{ name: value('key_env'), set: false }] : s.env })),
      ...(p.probe ? { probe: p.probe.map(fill) } : {}),
      kinds: Object.entries(byKind).filter(([, ids]) => ids.includes(p.id)).map(([k]) => k),
      problems: [],
    };
  });
  const jobs = JOBS();
  const auto = record(raw.auto_approve) ? raw.auto_approve : {};
  const approved = (unit: string, today: boolean) => jobs.filter(j => j.quote?.auto && j.quote.unit === unit && (!today || (j.quote.autoAt ?? '').startsWith(day()))).reduce((n, j) => n + (j.quote!.amount ?? 0), 0);
  return {
    project, file: `/studio/${project}/alba.yaml`, enable, tools, by_kind: byKind,
    auto_approve: Object.entries(auto).map(([unit, v]) => {
      const rule = record(v) ? { per_job: Number(v.per_job), per_day: v.per_day === undefined ? Number(v.per_job) * 10 : Number(v.per_day), ...(v.per_project !== undefined ? { per_project: Number(v.per_project) } : {}) } : { per_job: Number(v), per_day: Number(v) * 10 };
      return { unit, ...rule, today: approved(unit, true), ever: approved(unit, false) };
    }),
    units: [...new Set(tools.filter(x => x.enabled).flatMap(x => x.operations.flatMap(o => (o.paid ? [o.paid.unit] : []))))].sort(),
    problems: [], jobs, jobCount: jobs.length,
  };
}

export function handlePlugins(c: Ctx): boolean {
  const { path, method, res, send, project, body } = c;
  if (path === 'plugins' && method === 'GET') return send(res, 200, viewOf(project)), true;
  if (path === 'plugins/doctor' && method === 'POST') {
    const view = viewOf(project);
    const ids: string[] = Array.isArray(body.ids) && body.ids.length ? body.ids : view.tools.filter(x => x.enabled).map(x => x.id);
    const results = ids.map(id => {
      const tool = view.tools.find(x => x.id === id);
      if (!tool) return { id, ok: false, checks: [{ name: 'manifest', ok: false, detail: 'no such plugin' }] };
      const checks = [{ name: 'probe', ok: true, detail: 'node --version: v24.11.0' }, ...tool.servers.map(s => (
        id === 'tripo-3d' && s.name === 'tripo' ? { name: `mcp ${s.name}`, ok: false, detail: 'initialize: the server exited (code 1) (Tripo Studio is not logged in on this machine)' }
          : { name: `mcp ${s.name}`, ok: true, detail: `offers ${s.tools?.length ?? 3} tool(s)${s.tools ? `; the ${s.tools.length} listed are there` : ''}` }))];
      return { id, ok: checks.every(x => x.ok), checks };
    });
    const answer: PluginDoctor = { project, at: new Date().toISOString(), ok: results.every(r => r.ok), results };
    return setTimeout(() => send(res, 200, answer), 900), true;
  }
  return false;
}
