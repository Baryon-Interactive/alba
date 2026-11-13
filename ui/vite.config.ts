import { defineConfig } from 'vitest/config';
import type { Plugin, ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { mockApi } from './mocks/plugin.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
/** Reject server-only dependencies before they can become empty browser shims. */
const browserBoundary = (): Plugin => ({
  name: 'alba-browser-boundary',
  enforce: 'pre',
  apply: 'build',
  resolveId(source) {
    if (source.startsWith('node:')) this.error(`Server-only module ${source} cannot be included in the console.`);
    return null;
  },
});
/**
 * `@git-diff-view` imports `all` (every highlight.js language) from `lowlight`: 1 MB in the review chunk. Only for imports made by that
 * package, `lowlight` is replaced by src/lib/highlight/lowlight-shim.ts, which registers a hand-picked set.
 */
const lightHighlight = (): Plugin => ({
  name: 'alba-light-highlight',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source === 'lowlight' && importer && /@git-diff-view[+/]lowlight/.test(importer.replaceAll('\\', '/'))) return here('./src/lib/highlight/lowlight-shim.ts');
    return null;
  },
});

const target = process.env.ALBA_URL ?? 'http://127.0.0.1:4777';
/** This dev server's own origin as the browser addressed it (loopback names only). */
const devOrigin = (host: string | undefined): string | undefined => (host && /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host) ? `http://${host}` : undefined);
/**
 * The server accepts writes only from its own origin. The dev page is on another port, so the proxy speaks for that page alone: an
 * Origin equal to this dev server's own origin becomes the server's; any other Origin goes through as it is and is refused. Sign in
 * through this dev server (/login?key=... on its port): the session cookie is then set for the dev page.
 */
const toServer: ProxyOptions = {
  target,
  changeOrigin: true,
  configure: proxy => proxy.on('proxyReq', (out, incoming) => {
    const origin = incoming.headers.origin;
    if (origin && origin === devOrigin(incoming.headers.host)) out.setHeader('origin', new URL(target).origin);
  }),
};

// Dev: `pnpm dev` proxies /api, /login and /logout to a running `alba serve` (ALBA_URL, default http://127.0.0.1:4777);
// `pnpm dev:mock` answers /api itself from src/mocks (made-up data, no server needed).
export default defineConfig(({ mode }) => ({
  plugins: [browserBoundary(), lightHighlight(), react(), tailwindcss(), ...(mode === 'mock' ? [mockApi()] : [])],
  resolve: { alias: { '@/components/CommandPalette': here('./src/lib/lazy-command-palette.tsx'), '@': here('./src'), '@api': here('../src/api/types.ts') } },
  server: {
    port: 5173,
    fs: { allow: [here('..')] },
    proxy: mode === 'mock' ? undefined : { '/api': toServer, '/login': toServer, '/logout': toServer },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 900, manifest: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
}));
