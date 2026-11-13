import { t } from '../i18n.ts';

export interface Round {
  text: string;            // the full report
  signature: string;       // what must differ for the round to count as a change (the report without its time)
  exitCode: number;
}

export interface LoopDeps {
  print(text: string): void;
  sleep(ms: number): Promise<void>;
  clock(): string;         // "21:34"
  stop?: () => boolean;    // true to end the loop (tests); a person ends it with Ctrl+C
}

/**
 * Runs `round` every `minutes` until stopped. A round that changed nothing since the last one prints one line; a round that changed
 * something prints its whole report. A round that ends with exit code 2 or 3 (problems, bad configuration) is marked loudly
 * every time, and the loop goes on: the next round may well be fine.
 */
export async function tickLoop(round: () => Round, minutes: number, deps: LoopDeps): Promise<void> {
  let previous: string | undefined;
  while (!deps.stop?.()) {
    let r: Round;
    try { r = round(); } catch (e) { r = { text: `alba: ${(e as Error).message}`, signature: `error: ${(e as Error).message}`, exitCode: 3 }; }
    const same = r.signature === previous;
    previous = r.signature;
    const loud = r.exitCode >= 2 ? `!!! ${t('exit {code}: {what}', { code: r.exitCode, what: r.exitCode === 2 ? t('problems') : t('the tick could not run') })} !!!` : '';
    if (!same) deps.print(`${loud ? loud + '\n' : ''}${r.text}`);
    else deps.print(`${deps.clock()}  ${t('nothing changed')} (exit ${r.exitCode})${loud ? '  ' + loud : ''}`);
    if (deps.stop?.()) break;
    await deps.sleep(minutes * 60000);
  }
}
