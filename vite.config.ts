import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

/**
 * Hosted mode (PLATFORM_URL) in dev: clubs live at `<slug>.<platform host>`, e.g.
 * PLATFORM_URL=http://localhost:5173 → http://broadway.localhost:5173. Vite already accepts
 * `*.localhost`; any other platform domain (and its subdomains) is allowed explicitly.
 */
function allowedHosts(platformUrl: string | undefined): string[] | undefined {
  if (!platformUrl?.trim()) return undefined;
  try {
    const host = new URL(platformUrl.trim()).hostname.toLowerCase();
    return [host, `.${host}`];
  } catch {
    return undefined;
  }
}

export default defineConfig(({ mode }) => {
  // Read .env too, but let real environment variables win.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiPort = Number(env.PORT || 3000);
  const vitePort = Number(env.VITE_PORT || 5173);
  // changeOrigin stays off: the API picks the club (hosted mode) from the browser's Host header.
  const proxy = { '/api': { target: `http://localhost:${apiPort}`, changeOrigin: false } };
  const hosts = allowedHosts(env.PLATFORM_URL);

  return {
    root: 'client',
    publicDir: 'public',
    plugins: [react(), tailwindcss()],
    server: { port: vitePort, strictPort: true, proxy, allowedHosts: hosts },
    preview: { port: vitePort, strictPort: true, proxy, allowedHosts: hosts },
    build: {
      outDir: '../dist/client',
      emptyOutDir: true,
      sourcemap: true,
      rolldownOptions: {
        output: {
          // Long-lived vendor chunks: app deploys don't bust the cached libraries.
          codeSplitting: {
            groups: [
              { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/, priority: 2 },
              { name: 'vendor', test: /node_modules[\\/]/, priority: 1 },
            ],
          },
        },
      },
    },
  };
});
