import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Read .env too, but let real environment variables win.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiPort = Number(env.PORT || 3000);
  const vitePort = Number(env.VITE_PORT || 5173);
  const proxy = { '/api': { target: `http://localhost:${apiPort}` } };

  return {
    root: 'client',
    publicDir: 'public',
    plugins: [react(), tailwindcss()],
    server: { port: vitePort, strictPort: true, proxy },
    preview: { port: vitePort, strictPort: true, proxy },
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
