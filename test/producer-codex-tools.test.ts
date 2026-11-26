import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { codexCommand, codexExecArgs } from '../src/producer/engines/codex.ts';
import { tmpDir } from './tmp.ts';

// Optional installed-CLI check; the only provider is a loopback HTTP server, never a paid endpoint.
test('installed Codex exposes no shell or apply_patch in its effective request tools', { skip: !process.env.ALBA_CODEX_TEST_CLI ? 'Set ALBA_CODEX_TEST_CLI to enable the optional installed-Codex catalog check.' : false, timeout: 90000 }, async () => {
  const dir = tmpDir('alba-codex-tools-'), mcp = path.join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
  let received!: (value: any) => void;
  const request = new Promise<any>(resolve => { received = resolve; });
  const server = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { received(JSON.parse(body)); } catch (error) { received({ error: String(error), body }); } res.writeHead(400); res.end('tool catalog captured'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port, command = codexCommand(process.env.ALBA_CODEX_TEST_CLI);
  const args = codexExecArgs({ cli: process.env.ALBA_CODEX_TEST_CLI, cwd: dir, mcpConfig: mcp, systemPrompt: 'Reply OK without using tools.', model: 'model-sample', config: ['model_provider="loopback"', `model_providers.loopback={name="Loopback",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,stream_max_retries=0}`, 'features.enable_request_compression=false'] });
  const child = spawn(command.program, [...command.prefix, ...args.slice(0, -1), '--ignore-user-config', '-'], { cwd: dir, windowsHide: true });
  let stderr = ''; child.stderr.on('data', d => { stderr += d; }); child.stdout.resume(); child.stdin.on('error', () => {}); child.stdin.end('Reply OK.');
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([request, closed.then(() => { throw new Error('Codex exited before sending tools: ' + stderr); }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('No model request: ' + stderr)), 60000); })]);
    const effectiveTools = [...(body.tools ?? []), ...(body.input ?? []).filter((item: any) => item.type === 'additional_tools').flatMap((item: any) => item.tools ?? [])];
    const names: string[] = [];
    const collect = (tools: any[]) => { for (const tool of tools) { if (tool.tools) collect(tool.tools); if (tool.name) names.push(tool.name); } };
    collect(effectiveTools);
    assert.ok(names.length, 'the effective tool catalog was inspected');
    assert.ok(!names.some(name => /apply_patch|exec_command|write_stdin|shell|spawn_agent/.test(name)), JSON.stringify(names));
  } finally { clearTimeout(timer); child.kill(); await closed; await new Promise<void>(resolve => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); }
});
