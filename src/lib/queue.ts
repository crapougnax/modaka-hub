import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import pdfParse from 'pdf-parse';
import { Queue } from '@quatrain/queue';
import { Log } from '@quatrain/log';
import { Ingestion } from '@quatrain/ingestion';
import { Storage } from '@quatrain/storage';
import { ObjectUri } from '@quatrain/types';
import { Readable } from 'node:stream';
import { ContentItem } from './models/ContentItem';
import { slugify, extractProperNouns } from './utils';
import { buildS3Key } from './category-mapper';
import { searchAndCreateConcept } from './concept-autolink';
import { gitSync } from './git-sync';

let backendPromise: Promise<void> | null = null;
function ensureBackend() {
   if (!backendPromise) {
      backendPromise = import('./backend').then(({ initBackend }) => {
         return initBackend();
      }).catch(e => {
         Log.error(`Failed to initialize backend dynamically: ${e.message}`);
      });
   }
}

export interface IngestTask {
   id: string;
   status: 'pending' | 'processing' | 'completed' | 'failed';
   type: 'pdf' | 'image' | 'text' | 'url';
   name: string;
   progress: number;
   error?: string;
   createdAt: string;
   startedAt?: string;
   completedAt?: string;
   tempFilePath?: string;
   textContent?: string;
   category?: string;
   thematics?: string[];
   soils?: string[];
   climates?: string[];
   latitudes?: string[];
   altitudes?: string[];
   itineraries?: string[];
   soa?: string;
   contextNote?: string;
   fileHash?: string;
   source?: string;
   authors?: string[];
   translators?: string[];
   publisher?: string;
   edition?: string;
   publicationYear?: string;
   language?: string;
   isbn?: string;
   doi?: string;
   copyright?: string;
   originalTitle?: string;
   originalLanguage?: string;
   originalPublisher?: string;
   originalYear?: string;
   originalCopyright?: string;
   citation?: string;
   /** Pre-computed S3 object key (bulk ingestion). */
   s3Key?: string;
   /** When true, skip Gemini AI extraction and use heuristics only. */
   skipAi?: boolean;
}

class ModakaHubQueueManager {
   protected isListening = false;
   protected batchCommitSize = 50;
   protected pendingCommitFiles: string[] = [];
   protected pendingCommitCount = 0;

   public async startListening() {
      if (this.isListening) return;
      this.isListening = true;
      Log.info('[Modaka-Hub Queue] Starting background queue worker for "ingestion"');

      const adapter = Queue.getQueue<any>();
      adapter.listen('ingestion', async (task: any, options: { updateProgress: Function }) => {
         Log.info(`[Modaka-Hub Queue] Processing ingestion task "${task.name || task.id}"`);
         try {
            await this.executeTask(task, async (progress: number) => {
               await options.updateProgress(progress);
            });
            Log.info(`[Modaka-Hub Queue] Completed task "${task.name || task.id}"`);
         } catch (err: any) {
            Log.error(`[Modaka-Hub Queue] Failed task "${task.name || task.id}": ${err.message}`);
            throw err;
         }
      });
   }

   public async getTasks(): Promise<IngestTask[]> {
      ensureBackend();
      const adapter = Queue.getQueue<any>();
      return await adapter.getTasks('ingestion');
   }

   public async addTask(task: Omit<IngestTask, 'id' | 'status' | 'progress' | 'createdAt'>): Promise<IngestTask> {
      ensureBackend();
      const adapter = Queue.getQueue<any>();
      const messageId = await adapter.send(task, 'ingestion');
      return {
         ...task,
         id: messageId,
         status: 'pending',
         progress: 0,
         createdAt: new Date().toISOString()
      } as IngestTask;
   }

   /**
    * Configures the batch commit size for grouped Git commits.
    */
   public setBatchCommitSize(size: number): void {
      this.batchCommitSize = size;
   }

   /**
    * Forces a batch commit of all accumulated pending files.
    */
   public async flushBatchCommit(): Promise<void> {
      if (this.pendingCommitFiles.length === 0) return;
      const files = [...this.pendingCommitFiles];
      const count = this.pendingCommitCount;
      this.pendingCommitFiles = [];
      this.pendingCommitCount = 0;
      await gitSync.stageAndCommit(
         `feat(curation): bulk ingest ${count} documents`,
         files
      );
      Log.info(`[Modaka-Hub Queue] Batch committed ${count} documents (${files.length} files)`);
   }

   protected async executeTask(task: IngestTask, updateProgress: (progress: number) => Promise<void>): Promise<void> {
      ensureBackend();

      const gitLocalPath = process.env.GIT_LOCAL_PATH || '/Users/crapougnax/CODE/BRAD2026/world-agronomy';
      const useS3 = Boolean(process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY);
      const assetsPath = path.join(gitLocalPath, 'assets', 'documents');
      if (!useS3) {
         await fs.mkdir(assetsPath, { recursive: true });
      }

      await updateProgress(20);

      let buffer: Buffer | null = null;
      let rawText = '';

      if (task.tempFilePath) {
         buffer = await fs.readFile(task.tempFilePath);
      }

      const isPdf = task.type === 'pdf' || (task.name && task.name.toLowerCase().endsWith('.pdf'));

      if (isPdf && buffer) {
         try {
            Log.info(`[Modaka-Hub Queue] Parsing PDF contents with pdf-parse (${buffer.length} bytes)...`);
            const parsedPdf = await pdfParse(buffer);
            rawText = parsedPdf.text || '';
         } catch (e: any) {
            Log.warn(`[Modaka-Hub Queue] pdf-parse fallback error: ${e.message}`);
            rawText = '';
         }
      } else if (task.textContent) {
         rawText = task.textContent;
      }

      await updateProgress(45);

      // AI semantic analysis via Gemini adapter with multi-axial prompt
      let aiResult: any = null;
      const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

      if (!task.skipAi) {
         try {
            const ocrAdapter = Ingestion.getAdapter('ocr');
            if (ocrAdapter && (rawText || buffer)) {
               Log.info(`[Modaka-Hub Queue] Running Gemini AI multi-axial extraction (model: ${model})...`);
               aiResult = await ocrAdapter.process(rawText || buffer!, {
                  isText: Boolean(rawText),
                  mimeType: isPdf ? 'application/pdf' : 'text/plain',
                  contextNote: task.contextNote || 'Ingestion Bradtech pour base agronomique OKF. Extrais les 5 axes: sols (soils), climats (climates), latitudes/altitudes, itinéraires techniques (itineraries), productions végétales (crops). Extrais aussi rigoureusement les métadonnées bibliographiques: auteurs (authors: string[]), traducteurs (translators: string[]), éditeur (publisher: string), édition/version (edition: string), année de publication (publicationYear: string), langue (language: string), ISBN (isbn: string), DOI (doi: string), copyright de cette édition (copyright: string), titre original (originalTitle: string), langue originale (originalLanguage: string), éditeur d\'origine (originalPublisher: string), année originale (originalYear: string), copyright original (originalCopyright: string), et la citation normalisée (citation: string).',
                  model
               });
            }
         } catch (err: any) {
            Log.warn(`[Modaka-Hub Queue] AI structuring error: ${err.message}. Using fallback heuristics.`);
         }
      } else {
         Log.info(`[Modaka-Hub Queue] Skipping AI extraction (--skip-ai mode)`);
      }

      await updateProgress(70);

      const title = aiResult?.title || task.name.replace(/\.[^/.]+$/, '');
      const summary = aiResult?.summary || (rawText ? rawText.substring(0, 300).replace(/\s+/g, ' ') + '...' : 'Document agronomique curé.');
      const tags = Array.isArray(aiResult?.tags) && aiResult.tags.length > 0 ? aiResult.tags : ['agronomie', 'curation'];
      const properNouns = Array.isArray(aiResult?.properNouns) ? aiResult.properNouns : extractProperNouns(rawText);
      const deductedCategory = task.category || aiResult?.category || 'soil-health';

      // Deduce 4-axis facets if not provided
      const soils = task.soils || aiResult?.soils || (rawText.toLowerCase().includes('argil') ? ['argilo-calcaire'] : ['vivant-microbiote']);
      const climates = task.climates || aiResult?.climates || (rawText.toLowerCase().includes('mediterran') ? ['mediterraneen'] : ['tempere']);
      const latitudes = task.latitudes || aiResult?.latitudes || ['40-45N'];
      const altitudes = task.altitudes || aiResult?.altitudes || ['plaine-0-200m'];
      const itineraries = task.itineraries || aiResult?.itineraries || (rawText.toLowerCase().includes('viti') ? ['viticulture-biologique', 'enherbement-permanent'] : ['agroecologie']);
      const crops = task.crops || aiResult?.crops || (rawText.toLowerCase().includes('viti') || rawText.toLowerCase().includes('vign') ? ['viticulture'] : (rawText.toLowerCase().includes('arbori') || rawText.toLowerCase().includes('oliv') ? ['arboriculture'] : ['grandes-cultures']));

      const gitStatus = await gitSync.getStatus();
      const currentRev = gitStatus.lastCommit ? `rev-${gitStatus.lastCommit.split(' ')[0]}` : 'rev-1.0.0';
      const soa = task.soa || process.env.DEFAULT_SOA || 'bradtech/world-agronomy';

      const fileHash = task.fileHash || (buffer ? crypto.createHash('sha256').update(buffer).digest('hex') : undefined);
      const originalFileName = task.name || `${slugify(title)}.pdf`;
      let relativeAssetUri: string;

      if (useS3 && buffer) {
         // Upload to S3 (Supabase Storage)
         const s3Key = task.s3Key || buildS3Key(deductedCategory, fileHash || crypto.randomUUID(), originalFileName);
         try {
            const docStorage = Storage.getStorage('document-storage');
            const stream = Readable.from(buffer);
            await docStorage.create(
               { ref: s3Key, bucket: process.env.S3_BUCKET || 'world-agronomy', contentType: isPdf ? 'application/pdf' : 'application/octet-stream' } as any,
               stream
            );
            relativeAssetUri = s3Key;
            Log.info(`[Modaka-Hub Queue] Uploaded to S3: ${s3Key}`);
         } catch (s3Err: any) {
            Log.error(`[Modaka-Hub Queue] S3 upload failed: ${s3Err.message}. Falling back to local storage.`);
            const targetAssetPath = path.join(assetsPath, originalFileName);
            await fs.mkdir(assetsPath, { recursive: true });
            await fs.writeFile(targetAssetPath, buffer);
            relativeAssetUri = `assets/documents/${originalFileName}`;
         }
      } else if (buffer) {
         // Local filesystem fallback
         const targetAssetPath = path.join(assetsPath, originalFileName);
         await fs.writeFile(targetAssetPath, buffer);
         relativeAssetUri = `assets/documents/${originalFileName}`;
         Log.info(`[Modaka-Hub Queue] Saved binary asset to ${targetAssetPath}`);
      } else {
         relativeAssetUri = `assets/documents/${originalFileName}`;
      }

      const slug = slugify(title) || crypto.randomUUID();
      const contentItem = await ContentItem.factory({
         id: slug,
         title,
         soa,
         revision: currentRev,
         type: aiResult?.type || 'document',
         category: deductedCategory,
         tags,
         thematics: task.thematics || [deductedCategory],
         soils,
         climates,
         latitudes,
         altitudes,
         itineraries,
         crops,
         properNouns,
         summary,
         description: summary,
         originalFileUri: relativeAssetUri,
         fileHash,
         source: task.source || 'Bradtech Modaka-Hub Hub',
         documentDate: aiResult?.deductedDate || new Date().toISOString().split('T')[0],
         // Bibliographic & Intellectual Property References
         authors: task.authors || aiResult?.authors || [],
         translators: task.translators || aiResult?.translators || [],
         publisher: task.publisher || aiResult?.publisher || undefined,
         edition: task.edition || aiResult?.edition || undefined,
         publicationYear: task.publicationYear || aiResult?.publicationYear || (aiResult?.deductedDate ? aiResult.deductedDate.split('-')[0] : undefined),
         language: task.language || aiResult?.language || 'fr',
         isbn: task.isbn || aiResult?.isbn || undefined,
         doi: task.doi || aiResult?.doi || undefined,
         copyright: task.copyright || aiResult?.copyright || undefined,
         originalTitle: task.originalTitle || aiResult?.originalTitle || undefined,
         originalLanguage: task.originalLanguage || aiResult?.originalLanguage || undefined,
         originalPublisher: task.originalPublisher || aiResult?.originalPublisher || undefined,
         originalYear: task.originalYear || aiResult?.originalYear || undefined,
         originalCopyright: task.originalCopyright || aiResult?.originalCopyright || undefined,
         citation: task.citation || aiResult?.citation || undefined,
         body: rawText || aiResult?.markdown || summary,
         createdAt: new Date().toISOString()
      });

      const categoryDir = path.join(gitLocalPath, 'content', deductedCategory);
      await fs.mkdir(categoryDir, { recursive: true });

      contentItem.dataObject.uri = new ObjectUri(`content/${slug}`);
      await contentItem.save();
      Log.info(`[Modaka-Hub Queue] Persisted OKF document "content/${deductedCategory}/${slug}.md" with SOA ${soa} and revision ${currentRev}`);

      // Concept auto-linking for top proper nouns
      if (properNouns.length > 0) {
         for (const noun of properNouns.slice(0, 3)) {
            searchAndCreateConcept(noun).catch(() => {});
         }
      }

      // Stage and commit to local Git repo (batch or individual)
      const commitFiles = [path.join('content', deductedCategory, `${slug}.md`)];
      // Only stage the binary asset path if it is local (not S3)
      if (!useS3) {
         commitFiles.push(relativeAssetUri);
      }

      if (this.batchCommitSize > 1) {
         // Batch commit mode: accumulate files
         this.pendingCommitFiles.push(...commitFiles);
         this.pendingCommitCount++;
         if (this.pendingCommitCount >= this.batchCommitSize) {
            await this.flushBatchCommit();
         }
      } else {
         await gitSync.stageAndCommit(
            `feat(curation): ingest document "${title}" into ${deductedCategory} [SOA: ${soa}]`,
            commitFiles
         );
      }

      await updateProgress(100);
   }
}

export const queueManager = new ModakaHubQueueManager();
