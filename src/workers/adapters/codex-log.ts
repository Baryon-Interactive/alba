/**
 * Does the end of a Codex log show a command that was started and has not finished?
 * The log prints `exec`, then the command line (`<command> in <folder>`), and the result line (` succeeded in 3ms:`,
 * ` exited 1 in 0ms:`) only when the command is over, so a header with no result after it is a command still running.
 * Several commands can run at once; their results are matched in order of start.
 */
const RESULT = /^ (?:succeeded|exited -?\d+|failed|timed out)\b[^:]* in [\d.]+m?s:\s*$/;

export function openCommand(logText: string): string | undefined {
  const pending: string[] = [];
  const lines = logText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === 'exec' && i + 1 < lines.length) { pending.push(commandText(lines[i + 1])); i++; continue; }
    if (RESULT.test(lines[i])) pending.shift();
  }
  return pending.at(-1);
}

/** The command without the shell wrapper and the trailing ` in <folder>`. */
function commandText(line: string): string {
  return line.replace(/\s+in \S[^"]*$/, '').replace(/^"?[^"]*?(?:powershell|pwsh|bash|cmd)(?:\.exe)?"?\s+(?:-Command|-lc|\/c)\s+/i, '').replace(/^["']|["']$/g, '').trim();
}

export const textSessionId = (head: string): string | undefined => /^session id: ([0-9a-f-]{36})s*$/m.exec(head)?.[1];
