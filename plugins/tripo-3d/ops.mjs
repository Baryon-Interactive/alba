// The operations Alba runs with Tripo Studio (a server for Alba only; workers use the Tripo server itself).
//   node ops.mjs --server <local bootstrap.mjs or ""> --package <npm spec> --ceiling <credits>
// tripo_price      prices a model from Tripo's own quote; when Tripo cannot price it, answers the project's ceiling and says so.
// tripo_make_model generates a model, follows Tripo's configuration form to its submission, waits for the task, exports another
//                  format when asked, downloads the result into out_dir, and answers what the wallet says was spent.
// tripo_price_op / tripo_operate   the same for any other paid Studio operation (segment, complete parts, remesh, texture, PBR,
//                  upscale, rig, animate, motion, Smart UV, multiview, Magic Brush); tripo_operate_free for the free ones (import,
//                  export, apply UV); tripo_read for read-only questions (parts, presets, local inspection and renders).
// Alba approves the quote before tripo_make_model is called (the credits gate); this program never logs in and never retries a
// paid submission.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { arg, connect, find, serve } from './lib/mcp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = arg('server');
const PACKAGE = arg('package', 'tripo-studio-plugin@0.3.13');
const CEILING = Number(arg('ceiling', '60'));
const MINUTE = 60000;

const VIEWS = ['image_path', 'front_image_path', 'back_image_path', 'left_image_path', 'right_image_path'];
const GENERATE = ['mode', 'prompt', 'tier', 'face_limit', 'texture', 'pbr', 'texture_quality', 'model_version', 'quad', 'smart_poly', 'generate_parts', 't_pose', 'geometry_quality', 'symmetry', 'delight', 'texture_alignment', 'enable_image_autofix', 'segmentation_granularity', 'character_name', ...VIEWS];
const COST = ['mode', 'tier', 'face_limit', 'texture', 'pbr', 'texture_quality', 'model_version', 'quad', 'smart_poly', 'generate_parts', 'geometry_quality'];
const pick = (a, keys) => Object.fromEntries(keys.filter(k => a[k] !== undefined && a[k] !== '').map(k => [k, a[k]]));

const input = {
  type: 'object', required: ['mode', 'face_limit'],
  properties: {
    mode: { type: 'string', enum: ['image', 'multiview', 'text'], description: 'image: one picture; multiview: front/back/left/right views of one object; text: a prompt.' },
    image_path: { type: 'string' }, front_image_path: { type: 'string' }, back_image_path: { type: 'string' }, left_image_path: { type: 'string' }, right_image_path: { type: 'string' },
    prompt: { type: 'string', maxLength: 1000 },
    tier: { type: 'string', enum: ['smart_mesh', 'high_detail'], description: 'Default smart_mesh (a white mesh: texture it in a later operation).' },
    face_limit: { type: 'integer', minimum: 1 },
    texture: { type: 'boolean' }, pbr: { type: 'boolean' }, texture_quality: { type: 'string', enum: ['standard', 'detailed', 'ultra'] },
    format: { type: 'string', enum: ['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf'], description: 'Default glb; other formats are exported first (no credits).' },
    name: { type: 'string', description: 'File name without extension. Default: model.' },
    character_name: { type: 'string' },
    model_version: { type: 'string', description: "Tripo model version (see tripo_generate_model); default Tripo's own." },
    quad: { type: 'boolean' }, smart_poly: { type: 'boolean' }, generate_parts: { type: 'boolean' }, t_pose: { type: 'boolean' },
    geometry_quality: { type: 'string' }, symmetry: { type: 'string' }, delight: { type: 'boolean' }, texture_alignment: { type: 'string' },
    enable_image_autofix: { type: 'boolean' }, segmentation_granularity: { type: 'string' },
  },
};

// Every other Studio operation Alba may run: tool name (without tripo_) -> quote kind.
const PAID = {
  generate_multiview: 'image.multiview', segment_model: 'model.segment', complete_parts: 'model.complete_parts', remesh_model: 'model.remesh',
  generate_texture: 'texture.generate', generate_pbr: 'texture.pbr', upscale_texture: 'texture.upscale', rig_model: 'model.rig',
  animate_model: 'model.animate', generate_motion: 'motion.generate', apply_motion: 'model.apply_motion', generate_uv: 'model.uv_generate',
  preview_texture_edit: 'texture.edit_preview', apply_texture_edits: 'texture.edit_apply',
};
const FREE = { import_model: 'model.import', export_model: 'model.export', apply_uv: 'model.uv_apply' };
const READ = ['get_model', 'list_models', 'get_task', 'list_tasks', 'list_animation_presets', 'list_motions', 'get_motion', 'get_uv_context',
  'inspect_local_parts', 'render_model', 'edit_parts', 'bake_texture_projection', 'paint_texture', 'crop_image', 'get_payment', 'list_operations'];
const opProps = (names) => ({
  tool: { type: 'string', enum: names, description: 'The Tripo Studio tool without its tripo_ prefix.' },
  args: { type: 'object', description: "That tool's own arguments (its input schema in the Tripo server). Local paths absolute." },
  download: { type: 'boolean', description: 'Download the resulting model into the job folder (default true when the result is a model).' },
  format: { type: 'string', enum: ['glb', 'fbx', 'obj', 'usdz', 'stl', '3mf'], description: 'Download format; other than glb is exported first (no credits).' },
  name: { type: 'string', description: 'Downloaded file name without extension. Default: model.' },
});
const opInput = (names, extra = {}) => ({ type: 'object', required: ['tool', 'args', ...Object.keys(extra)], properties: { ...opProps(names), ...extra } });
const OUT = { out_dir: { type: 'string' } };
const tools = [
  { name: 'tripo_price', description: 'Prices a model generation with Tripo\'s quote. Answers { amount, note } in credits; when Tripo cannot price it, the amount is the project\'s ceiling.', inputSchema: input },
  { name: 'tripo_price_op', description: "Prices one paid Studio operation with Tripo's quote ({ amount, note } in credits; the ceiling when Tripo cannot price it).", inputSchema: opInput(Object.keys(PAID)) },
  { name: 'tripo_operate', description: 'Runs one paid Studio operation, follows its form to the task, waits, downloads the model when asked, and answers the ids, files and what the wallet says was spent.', inputSchema: opInput(Object.keys(PAID), OUT) },
  { name: 'tripo_operate_free', description: 'Runs one free Studio operation (import, export, apply UV) the same way.', inputSchema: opInput(Object.keys(FREE), OUT) },
  { name: 'tripo_read', description: 'Answers a read-only or local Studio tool (parts, presets, tasks, local inspection, renders, local edits) and keeps its answer as result.json.', inputSchema: opInput(READ, OUT) },
  { name: 'tripo_make_model', description: 'Generates a model with Tripo Studio, waits for it and downloads it into out_dir. Answers the files, the task and what the wallet says was spent.', inputSchema: { ...input, required: [...input.required, 'out_dir'], properties: { ...input.properties, out_dir: { type: 'string' } } } },
];

const tripo = (env = process.env) => connect(process.execPath, [path.join(HERE, 'start-tripo.mjs'), '--server', SERVER, '--package', PACKAGE], { env });
const withDefaults = a => ({ tier: 'smart_mesh', ...a });

function check(a) {
  if (a.mode === 'image' && !a.image_path) throw new Error('mode image needs image_path');
  if (a.mode === 'multiview' && !a.front_image_path) throw new Error('mode multiview needs front_image_path (and the other views you have)');
  if (a.mode === 'text' && !a.prompt) throw new Error('mode text needs prompt');
  for (const k of VIEWS) if (a[k] && !path.isAbsolute(a[k])) throw new Error(`${k} must be an absolute path`);
}

/** The wallet's credits from tripo_get_payment, or undefined when the answer does not say it plainly. */
function credits(payment) {
  for (const key of ['total_credit', 'available_credits', 'credits_available', 'credit_balance', 'balance', 'remaining_credits', 'credits']) {
    const v = find(payment, key);
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.replace(/,/g, ''))) return Number(v.replace(/,/g, ''));
  }
  return undefined;
}

async function price(a) {
  a = withDefaults(a); check(a);
  const t = await tripo();
  try {
    const { value } = await t.call('tripo_quote_operation', { kind: 'model.generate', input: pick(a, COST) }, 2 * MINUTE);
    const est = find(value, 'estimated_credits');
    const status = find(value, 'status') ?? 'unknown';
    if (typeof est === 'number' && est > 0) return { text: JSON.stringify({ amount: est }), structured: { amount: est, note: `Tripo's estimate (${status}); not a billing guarantee` } };
    const warnings = find(value, 'warnings');
    const why = `Tripo could not price it (quote ${status}${Array.isArray(warnings) && warnings.length ? `: ${warnings[0]}` : ''}); this is the project's ceiling (setting ceiling)`;
    // unpriced: Alba never approves this quote by itself (plugins.auto_approve), a person does.
    return { text: JSON.stringify({ amount: CEILING, unpriced: true }), structured: { amount: CEILING, note: why, unpriced: true } };
  } finally { t.close(); }
}

/** Follows a configuration form to its submission and answers the task id. */
async function submitted(t, created, until) {
  const review = find(created, 'review_id');
  if (!review) { const task = find(created, 'task_id'); if (task) return task; throw new Error('Tripo answered no review_id and no task_id'); }
  for (;;) {
    if (Date.now() > until) throw new Error(`the Tripo form ${review} was not submitted in time`);
    const { value } = await t.call('tripo_get_configuration_review', { review_id: review, wait_ms: 60000 }, 3 * MINUTE);
    const status = String(find(value, 'status') ?? '');
    if (['canceled', 'cancelled', 'failed', 'error', 'expired'].includes(status)) throw new Error(`the Tripo form ${review} ended ${status}${find(value, 'error') ? `: ${JSON.stringify(find(value, 'error')).slice(0, 300)}` : ''}`);
    const task = find(value, 'task_id');
    if (task && !['pending', 'submitting', 'editing', 'draft'].includes(status)) return task;
  }
}

/** Waits for a task to end; answers its record when it succeeded. */
async function finished(t, task, until) {
  for (;;) {
    const left = Math.floor((until - Date.now()) / 1000);
    if (left < 5) throw new Error(`the Tripo task ${task} did not finish in time; it may still run (tripo_get_task ${task})`);
    const { value } = await t.call('tripo_task_wait', { task_id: task, timeout_seconds: Math.min(600, left), poll_seconds: 10 }, (Math.min(600, left) + 60) * 1000);
    const status = String(find(value, 'status') ?? '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'complete', 'done', 'finished'].includes(status)) return value;
    if (['failed', 'canceled', 'cancelled', 'error', 'outcome_unknown', 'expired', 'banned'].includes(status)) throw new Error(`the Tripo task ${task} ended ${status}${find(value, 'error') ? `: ${JSON.stringify(find(value, 'error')).slice(0, 300)}` : ''}`);
  }
}

async function make(a) {
  a = withDefaults(a); check(a);
  if (typeof a.out_dir !== 'string' || !path.isAbsolute(a.out_dir)) throw new Error('out_dir must be an absolute folder');
  mkdirSync(a.out_dir, { recursive: true });
  const until = Date.now() + 85 * MINUTE;
  // Tripo writes only into its allowed output roots: the job's folder joins them for this server.
  const env = { ...process.env, TRIPO_OUTPUT_ROOTS: [a.out_dir, process.env.TRIPO_OUTPUT_ROOTS].filter(Boolean).join(path.delimiter) };
  const t = await tripo(env);
  let before, spentSoFar, sent = false;
  // Before the generation is asked nothing can cost: spent 0. After it, what the wallet shows, or nothing said (Alba then books the
  // most it may have cost).
  const fail = (message) => { const e = new Error(message); if (!sent) e.structured = { spent: 0 }; else if (spentSoFar !== undefined) e.structured = { spent: spentSoFar }; return e; };
  try {
    const auth = (await t.call('tripo_auth_status', {}, 2 * MINUTE)).value;
    if (find(auth, 'authenticated') !== true) throw new Error('Tripo Studio is not logged in on this machine (tripo_auth_status). A person logs in once with the Tripo plugin (tripo_auth_login opens the browser); Alba does not log in.');
    before = credits((await t.call('tripo_get_payment', {}, 2 * MINUTE)).value);
    sent = true;
    const created = (await t.call('tripo_generate_model', pick(a, GENERATE), 5 * MINUTE)).value;
    const task = await submitted(t, created, until);
    const done = await finished(t, task, until);
    let download = task;
    const format = a.format ?? 'glb';
    if (format !== 'glb') {
      const project = find(done, 'project_id');
      if (!project) throw new Error(`the Tripo task ${task} answered no project_id to export ${format} from`);
      const exported = (await t.call('tripo_export_model', { project_id: project, format, texture_packaging: 'embedded', parent_task_id: task, ...(a.name ? { name: a.name } : {}) }, 5 * MINUTE)).value;
      download = await submitted(t, exported, until);
      await finished(t, download, until);
    }
    const name = typeof a.name === 'string' && /^[\w.-]+$/.test(a.name) ? a.name : 'model';
    const file = path.join(a.out_dir, `${name}.${format}`);
    const saved = (await t.call('tripo_download', { task_id: download, path: file }, 10 * MINUTE)).value;
    const after = credits((await t.call('tripo_get_payment', {}, 2 * MINUTE)).value);
    const spent = before !== undefined && after !== undefined && before >= after ? Math.round((before - after) * 1000) / 1000 : undefined;
    const files = [find(saved, 'path'), find(saved, 'blender_path')].filter(f => typeof f === 'string');
    const structured = { files, task_id: task, ...(download !== task ? { export_task_id: download } : {}), ...(find(done, 'project_id') ? { project_id: find(done, 'project_id') } : {}), ...(spent !== undefined ? { spent } : {}) };
    return { text: [`model ${format} from Tripo task ${task}:`, ...files, spent !== undefined ? `wallet: ${before} -> ${after} credits` : 'wallet: not readable; the quote is booked'].join('\n'), structured };
  } catch (e) {
    // A failure after the submission may still have cost credits: say what the wallet shows, so Alba books it.
    if (before !== undefined) { try { const now = credits((await t.call('tripo_get_payment', {}, MINUTE)).value); if (now !== undefined && now < before) spentSoFar = Math.round((before - now) * 1000) / 1000; } catch { /* the wallet is not readable now */ } }
    throw fail(e.message);
  } finally { t.close(); }
}

// ---- Other Studio operations -------------------------------------------------------------------------------------------------
const PATH_KEY = /(_path|_paths|^path|file_path)$/;
const NOT_COST = /(_id|prompt|segments|textures|camera_matrix|character_name)$/;
const costInput = (args) => Object.fromEntries(Object.entries(args ?? {}).filter(([k]) => !PATH_KEY.test(k) && !NOT_COST.test(k)));
const IDS = ['project_id', 'asset_id', 'motion_asset_id', 'candidate_id'];
const ids = (v) => Object.fromEntries(IDS.map(k => [k, find(v, k)]).filter(([, x]) => x !== undefined));
const NO_MODEL = ['generate_multiview', 'generate_motion', 'preview_texture_edit', 'generate_uv'];

function toolName(a, allowed) {
  if (!allowed.includes(a.tool)) throw new Error(`tool ${a.tool} is not one Alba runs here (${allowed.join(', ')})`);
  if (!a.args || typeof a.args !== 'object' || Array.isArray(a.args)) throw new Error('args must be an object');
  for (const [k, v] of Object.entries(a.args)) if (PATH_KEY.test(k) && typeof v === 'string' && !path.isAbsolute(v)) throw new Error(`${k} must be an absolute path`);
  return `tripo_${a.tool}`;
}
const outRoots = (dir) => ({ ...process.env, TRIPO_OUTPUT_ROOTS: [dir, process.env.TRIPO_OUTPUT_ROOTS].filter(Boolean).join(path.delimiter) });
function outDir(a) {
  if (typeof a.out_dir !== 'string' || !path.isAbsolute(a.out_dir)) throw new Error('out_dir must be an absolute folder');
  mkdirSync(a.out_dir, { recursive: true }); return a.out_dir;
}

async function priceOp(a) {
  toolName(a, Object.keys(PAID));
  const t = await tripo();
  try {
    const { value } = await t.call('tripo_quote_operation', { kind: PAID[a.tool], input: costInput(a.args) }, 2 * MINUTE);
    const est = find(value, 'estimated_credits');
    const status = find(value, 'status') ?? 'unknown';
    if (typeof est === 'number' && est > 0) return { text: JSON.stringify({ amount: est }), structured: { amount: est, note: `Tripo's estimate for ${PAID[a.tool]} (${status}); not a billing guarantee` } };
    return { text: JSON.stringify({ amount: CEILING, unpriced: true }), structured: { amount: CEILING, unpriced: true, note: `Tripo could not price ${PAID[a.tool]} (quote ${status}); this is the project's ceiling (setting ceiling)` } };
  } finally { t.close(); }
}

async function operate(a, allowed, paid) {
  const tool = toolName(a, allowed);
  const dir = outDir(a);
  const until = Date.now() + 85 * MINUTE;
  const t = await tripo(outRoots(dir));
  let before, sent = false;
  try {
    const auth = (await t.call('tripo_auth_status', {}, 2 * MINUTE)).value;
    if (find(auth, 'authenticated') !== true) throw new Error('Tripo Studio is not logged in on this machine (tripo_auth_status); a person logs in, Alba does not.');
    if (paid) before = credits((await t.call('tripo_get_payment', {}, 2 * MINUTE)).value);
    sent = true;
    const created = (await t.call(tool, a.args, 5 * MINUTE)).value;
    const task = await submitted(t, created, until);
    const done = await finished(t, task, until);
    const files = [];
    const project = find(done, 'project_id');
    if ((a.download ?? !NO_MODEL.includes(a.tool)) && project) {
      const format = a.format ?? 'glb';
      let from = task;
      if (format !== 'glb') {
        const exported = (await t.call('tripo_export_model', { project_id: project, format, texture_packaging: 'embedded', parent_task_id: task }, 5 * MINUTE)).value;
        from = await submitted(t, exported, until);
        await finished(t, from, until);
      }
      const name = typeof a.name === 'string' && /^[\w.-]+$/.test(a.name) ? a.name : 'model';
      const saved = (await t.call('tripo_download', { task_id: from, path: path.join(dir, `${name}.${format}`) }, 10 * MINUTE)).value;
      files.push(...[find(saved, 'path'), find(saved, 'blender_path')].filter(f => typeof f === 'string'));
    }
    const record = path.join(dir, 'result.json');
    writeFileSync(record, JSON.stringify(done, null, 1)); files.push(record);
    let spent = paid ? undefined : 0;
    if (paid) {
      const after = credits((await t.call('tripo_get_payment', {}, 2 * MINUTE)).value);
      if (before !== undefined && after !== undefined && before >= after) spent = Math.round((before - after) * 1000) / 1000;
    }
    const structured = { task_id: task, ...ids(done), files, ...(spent !== undefined ? { spent } : {}) };
    return { text: [`${a.tool}: task ${task}${project ? ` project ${project}` : ''}`, ...files, spent !== undefined ? `spent ${spent} credits` : 'wallet: not readable; the quote is booked'].join('\n'), structured };
  } catch (e) {
    // A failure after the submission may still have cost credits: say what the wallet shows, so Alba books it.
    const err = new Error(e.message);
    if (!sent || !paid) err.structured = { spent: 0 };
    else if (before !== undefined) {
      try { const now = credits((await t.call('tripo_get_payment', {}, MINUTE)).value); if (now !== undefined) err.structured = { spent: Math.max(0, Math.round((before - now) * 1000) / 1000) }; } catch { /* not readable now */ }
    }
    throw err;
  } finally { t.close(); }
}

async function read(a) {
  const tool = toolName(a, READ);
  const dir = outDir(a);
  const t = await tripo(outRoots(dir));
  try {
    const { value } = await t.call(tool, a.args, 10 * MINUTE);
    const file = path.join(dir, 'result.json');
    writeFileSync(file, JSON.stringify(value, null, 1));
    return { text: `${a.tool}: ${file}`, structured: { files: [file], spent: 0 } };
  } finally { t.close(); }
}

serve({ name: 'tripo-3d-ops', version: '1.1.0' }, tools, {
  tripo_price: price, tripo_make_model: make, tripo_price_op: priceOp,
  tripo_operate: a => operate(a, Object.keys(PAID), true), tripo_operate_free: a => operate(a, Object.keys(FREE), false), tripo_read: read,
});
