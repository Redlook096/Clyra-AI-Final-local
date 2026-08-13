import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, 'index.html'),
          todo: path.resolve(__dirname, 'todo.html'),
        },
        output: {
          manualChunks(id) {
            // Core React
            if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor';
            // Animation libraries
            if (id.includes('node_modules/motion') || id.includes('node_modules/framer-motion')) return 'motion';
            if (id.includes('node_modules/gsap')) return 'gsap';
            // Icons
            if (id.includes('node_modules/lucide-react')) return 'icons';
            // Markdown and syntax highlighting
            if (id.includes('node_modules/react-syntax-highlighter')) return 'syntax-highlighter';
            if (id.includes('node_modules/react-markdown') || id.includes('node_modules/marked') || id.includes('node_modules/remark')) return 'markdown';
            // UI libraries
            if (id.includes('node_modules/@radix-ui')) return 'radix-ui';
            if (id.includes('node_modules/@xyflow')) return 'xyflow';
            // Editor
            if (id.includes('node_modules/@monaco-editor')) return 'monaco';
            // Workspace-specific chunks
            if (id.includes('/components/StudyPalWorkspace')) return 'study-pal';
            if (id.includes('/components/VibeCoderWorkspace')) return 'vibe-coder';
            if (id.includes('/components/WebBrowserWorkspace')) return 'web-browser';
            if (id.includes('/components/CreatorStudioWorkspace')) return 'creator-studio';
            if (id.includes('/components/AIClipper')) return 'ai-clipper';
          },
        },
      },
    },
    optimizeDeps: {
      entries: ['index.html', 'todo.html'],
      // Commit the eager React bundle immediately. In middleware mode Vite's
      // default crawl hold can otherwise invalidate the entry module after the
      // first browser request and return a transient 504 for its old hash.
      holdUntilCrawlEnd: false,
    },
    server: {
      // Clyra owns preview refreshes. Disabling Vite's page-level HMR avoids
      // a failed development WebSocket in embedded Chromium while project
      // previews still refresh through Clyra's explicit preview lifecycle.
      hmr: false,
      watch: {
        ignored: [
          '**/vibe-sandbox/**',
          '**/projects/**',
          '**/.agentic-browser-profile/**',
          // Non-frontend artifacts in the repo root. Background processes
          // rewrite these (e.g. clipper pipeline scripts), and any change to
          // a watched file outside the module graph forces a full page
          // reload, killing active agent sessions in the UI.
          '**/*.py',
          '**/output/**',
          '**/tmp/**',
          '**/test-results/**',
          '**/playwright-report/**',
        ],
      },
    },
  };
});
