import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Orrery — Interactive Solar System',
        short_name: 'Orrery',
        description:
          'Fly through a procedurally rendered solar system. Real orbits, real scale, real science.',
        theme_color: '#04060a',
        background_color: '#04060a',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // three.js plus the shader bundle is comfortably over the 2 MB default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, './src') },
  },
  build: {
    // es2022 rather than esnext: esnext can emit syntax Safari 15 chokes on.
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // postprocessing must land with three or the chunks import-cycle.
            if (id.includes('three') || id.includes('postprocessing'))
              return 'three';
            if (id.includes('react') || id.includes('scheduler'))
              return 'react';
            if (id.includes('framer-motion')) return 'motion';
          }
          return undefined;
        },
      },
    },
  },
});
