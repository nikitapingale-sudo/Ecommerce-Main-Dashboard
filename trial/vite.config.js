import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [react()],

    resolve: {
      alias: {
        '@':           path.resolve(__dirname, './src'),
        '@components': path.resolve(__dirname, './src/components'),
        '@pages':      path.resolve(__dirname, './src/pages'),
        '@utils':      path.resolve(__dirname, './src/utils'),
      },
    },

    server: {
      port: 5173, strictPort: false, open: true, cors: true,
      proxy: {
        '/api': {
          target: env.VITE_API_BASE_URL || 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
        },
      },
    },

    build: {
      outDir: 'dist',
      sourcemap: mode !== 'production',
      minify: mode === 'production' ? 'esbuild' : false,
      target: 'es2020',
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            react:    ['react', 'react-dom'],
            recharts: ['recharts'],
            xlsx:     ['xlsx'],
            lucide:   ['lucide-react'],
          },
        },
      },
    },

    optimizeDeps: {
      include: ['react', 'react-dom', 'recharts', 'xlsx', 'lucide-react', 'date-fns'],
    },

    define: {
      __APP_VERSION__: JSON.stringify('1.0.0'),
      __BUILD_TIME__:  JSON.stringify(new Date().toISOString()),
      __DEV_MODE__:    mode !== 'production',
    },

    preview: { port: 4173, open: true },
  };
});
