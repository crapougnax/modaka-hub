import * as path from 'node:path';
import * as fs from 'node:fs';
import dotenv from 'dotenv';
import { Log, DefaultLoggerAdapter, LogLevel } from '@quatrain/log';
import { Backend } from '@quatrain/backend';
import { OKFBackendAdapter } from '@quatrain/okf';
import { Storage } from '@quatrain/storage';
import { LocalStorageAdapter } from '@quatrain/storage-local';
import { Ai } from '@quatrain/ai';
import { GeminiAdapter } from '@quatrain/ai-gemini';
import { Ingestion } from '@quatrain/ingestion';
import { OcrIngestionAdapter } from '@quatrain/ingestion-ocr';
import { WebIngestionAdapter } from '@quatrain/ingestion-web';
import { Queue } from '@quatrain/queue';
import { SQLiteQueueAdapter } from '@quatrain/queue-sqlite';
import { queueManager } from './queue';

dotenv.config();

let initialized = false;

export async function initBackend() {
   if (initialized) return;
   initialized = true;

   Log.addLogger('default', new DefaultLoggerAdapter('', LogLevel.INFO), true);
   Log.info('[Modaka-Hub] Initializing backend adapters and OKF storage...');

   const { getGitLocalPath } = await import('./config');
   const gitLocalPath = getGitLocalPath();
   const documentStoragePath = process.env.DOCUMENT_STORAGE_PATH || path.join(gitLocalPath, 'assets');

   // 1. Initialize Document Storage
   let docAdapter: any;
   if (process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY) {
      const { S3StorageAdapter } = await import('@quatrain/storage-s3');
      docAdapter = new S3StorageAdapter({
         config: {
            region: process.env.S3_REGION || 'us-east-1',
            endpoint: process.env.S3_ENDPOINT,
            accesskey: process.env.S3_ACCESS_KEY,
            secret: process.env.S3_SECRET_KEY,
            bucket: process.env.S3_BUCKET || 'documents'
         }
      } as any);
      Log.info(`Document storage configured with S3StorageAdapter on bucket '${process.env.S3_BUCKET || 'documents'}'`);
   } else {
      docAdapter = new LocalStorageAdapter({
         config: { bucket: 'documents' },
         basePath: documentStoragePath
      } as any);
      Log.info('Document storage configured with LocalStorageAdapter');
   }
   Storage.addStorage(docAdapter, 'document-storage', false);

   // 2. Configure OKF Backend Adapter pointing to the root of the git repo
   const okfAdapter = new OKFBackendAdapter({
      config: {
         database: gitLocalPath
      }
   });
   Backend.addBackend(okfAdapter, 'default', true);

   // 3. Configure AI Gemini
   if (process.env.GEMINI_API_KEY) {
      Ai.setAdapter(new GeminiAdapter(process.env.GEMINI_API_KEY));
      Log.info('AI Gemini adapter registered');
   }

   // 4. Configure Ingestion OCR / Web
   Ingestion.addAdapter(new OcrIngestionAdapter(), 'ocr');
   Ingestion.addAdapter(new WebIngestionAdapter(), 'web');

   // 5. Configure SQLite background queue
   const queueDbDir = path.resolve(process.cwd(), '.modaka-hub-queue');
   try {
      fs.mkdirSync(queueDbDir, { recursive: true });
   } catch {}
   Queue.addQueue(new SQLiteQueueAdapter({
      config: { database: path.join(queueDbDir, 'queue.sqlite') }
   }), 'default', true);

   // 6. Start listening to queue
   await queueManager.startListening();
   Log.info('[Modaka-Hub] Backend ready. Targeting OKF repo at:', gitLocalPath);
}

// Auto initialize
initBackend().catch(err => {
   Log.error(`[Modaka-Hub] Initialization error: ${err.message}`);
});
