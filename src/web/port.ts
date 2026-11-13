import { createServer } from 'node:net';

/** The ports `fetch` (undici, as the browsers) refuses to connect to: asking the system for any free port can hand out one of these. */
export const FETCH_FORBIDDEN_PORTS: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** A free port on `host` that `fetch` may connect to: the system picks, a forbidden one is given back and another is asked for. */
export async function freePort(host: string, tries = 20): Promise<number> {
  let last = 0;
  for (let i = 0; i < tries; i++) {
    last = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.once('error', reject);
      s.listen(0, host, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
    });
    if (!FETCH_FORBIDDEN_PORTS.has(last)) return last;
  }
  return last;
}
