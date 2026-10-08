import type { AppCompositionInterface, PWAContentInterface } from '@quatrain/types';

/**
 * Official Modaka-Hub application composition definition.
 * Connects the Modaka-Hub curation UI with Modaka runtime adapters.
 */
export const modaka-hubComposition: AppCompositionInterface<PWAContentInterface> = {
   content: {
      type: 'pwa',
      name: 'modaka-hub',
      version: '0.1.0',
      distPath: './dist',
      manifest: {
         name: 'Modaka-Hub OKF Curation Workbench',
         short_name: 'Modaka-Hub',
         theme_color: '#1a202c',
         background_color: '#1a202c'
      }
   },
   adapters: {
      ai: {
         default: { package: '@quatrain/ai-gemini', adapter: 'GeminiAdapter' },
         ocr: { package: '@quatrain/ingestion-ocr', adapter: 'OcrIngestionAdapter' },
         audio: { package: '@quatrain/ingestion-audio', adapter: 'AudioIngestionAdapter' }
      },
      backend: { package: '@quatrain/backend', adapter: 'OKFBackendAdapter' },
      storage: { package: '@quatrain/storage-local', adapter: 'LocalStorageAdapter' },
      searchengine: { package: '@quatrain/searchengine-qmd', adapter: 'QmdSearchEngineAdapter' },
      queue: { package: '@quatrain/queue-sqlite', adapter: 'SQLiteQueueAdapter' }
   },
   config: {
      okfRoot: process.env.GIT_LOCAL_PATH || './data/okf',
      defaultCategory: 'inbox'
   }
};
