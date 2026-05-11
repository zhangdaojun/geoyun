import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src')
    }
  },
  server: {
    proxy: {
      '/admin': {
        target: 'http://127.0.0.1:8001',
        changeOrigin: true
      }
    },
    watch: {
      usePolling: true
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('antd') || id.includes('@ant-design') || id.includes('rc-')) return 'vendor-antd';
          if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts';
          if (id.includes('leaflet') || id.includes('react-leaflet')) return 'vendor-map';
          if (id.includes('xlsx')) return 'vendor-xlsx';
          if (id.includes('pdfjs-dist') || id.includes('pdf-parse')) return 'vendor-pdf';
          if (id.includes('jszip') || id.includes('file-saver')) return 'vendor-files';
          if (id.includes('react') || id.includes('react-dom')) return 'vendor-react';
          return 'vendor-misc';
        }
      }
    }
  }
})
