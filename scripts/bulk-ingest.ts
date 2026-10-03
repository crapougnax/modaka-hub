#!/usr/bin/env bun
/**
 * Bulk Ingestion CLI for Modaka-Hub.
 *
 * Powered by @quatrain/okf-ingest:
 * - Full text & multimodal PDF extraction
 * - Visual schema & Mermaid diagram transcription
 * - Exact token accounting and USD cost computation
 * - Open Knowledge Format (OKF v0.2) packaging
 *
 * @example
 *   yarn bulk-ingest --dry-run ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --concurrency 3 --batch-commit 50 ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --resume --skip-ai ~/DOCUMENTS/BRAD/RAG
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { execSync } from 'node:child_process';
import { Readable } from 'node:stream';
import dotenv from 'dotenv';
import { Log } from '@quatrain/log';
import { Storage } from '@quatrain/storage';
import { S3StorageAdapter } from '@quatrain/storage-s3';
import {
   extractPdfText,
   extractSemanticContent,
   writeOkfDocument,
   OkfDedupCache,
   OkfFrontmatterV2,
   ingestMonograph,
} from '@quatrain/okf-ingest';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// ─── Types ──────────────────────────────────────────────────────────────────────

interface CliOptions {
   sourceDir: string;
   category?: string;
   soa: string;
   concurrency: number;
   delayMs: number;
   batchCommit: number;
   extensions: string[];
   skipAi: boolean;
   dryRun: boolean;
   resume: boolean;
   limit?: number;
   minSizeBytes?: number;
   sortBy?: 'size' | 'name';
   splitThresholdChars?: number;
   noSplit?: boolean;
}

interface ScanResult {
   absolutePath: string;
   relativePath: string;
   extension: string;
   sizeBytes: number;
}

// ─── Path Resolution ───────────────────────────────────────────────────────────

function resolvePath(p: string): string {
   if (p.startsWith('~/')) {
      return path.join(os.homedir(), p.slice(2));
   }
   if (p === '~') {
      return os.homedir();
   }
   return path.resolve(p);
}

function parseSize(s: string): number {
   const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(b|kb|k|mb|m|gb|g)?$/i);
   if (!m) return parseInt(s, 10) || 0;
   const val = parseFloat(m[1]);
   const unit = (m[2] || '').toLowerCase();
   if (unit.startsWith('g')) return Math.round(val * 1024 * 1024 * 1024);
   if (unit.startsWith('m')) return Math.round(val * 1024 * 1024);
   if (unit.startsWith('k')) return Math.round(val * 1024);
   return Math.round(val);
}

// ─── Argument Parsing ───────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt'];

function printUsage(exitCode = 1): void {
   const print = exitCode === 0 ? console.log : console.error;
   print('Usage: bulk-ingest [options] <source-directory>');
   print('');
   print('Options:');
   print('  --category <cat>       Default OKF category');
   print('  --soa <soa>            Source of Authority (default: bradtech/world-agronomy)');
   print('  --concurrency <n>      Parallel tasks (default: 3)');
   print('  --delay <ms>           Delay between tasks (default: 500)');
   print('  --batch-commit <n>     Docs per Git commit (default: 50)');
   print('  --extensions <list>    Comma-separated extensions (default: pdf,doc,docx,txt)');
   print('  --skip-ai              Skip Gemini AI extraction');
   print('  --dry-run              List files without ingesting');
   print('  --resume               Skip already-ingested files (default: true)');
   print('  --no-resume, --force   Force re-ingestion of all files');
   print('  --limit <n>            Maximum documents to ingest');
   print('  --min-size <size>      Minimum file size filter (e.g. 5MB, 10M)');
   print('  --sort-by <size|name>  Sort scanned files before processing (descending for size)');
   print('  --split-threshold <n>  Split monographs (>N chars) into chapters (default: 80000)');
   print('  --no-split             Disable monograph chapter splitting');
   print('  --help, -h             Show this help message');
   process.exit(exitCode);
}

function parseArgs(argv: string[]): CliOptions {
   const args = argv.slice(2);
   const opts: CliOptions = {
      sourceDir: '',
      soa: process.env.DEFAULT_SOA || 'bradtech/world-agronomy',
      concurrency: 3,
      delayMs: 500,
      batchCommit: 50,
      extensions: DEFAULT_EXTENSIONS,
      skipAi: false,
      dryRun: false,
      resume: true,
   };

   for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
         case '--help':
         case '-h':
            printUsage(0);
            break;
         case '--category':
            opts.category = args[++i];
            break;
         case '--soa':
            opts.soa = args[++i];
            break;
         case '--concurrency':
            opts.concurrency = parseInt(args[++i], 10) || 3;
            break;
         case '--delay':
            opts.delayMs = parseInt(args[++i], 10) || 500;
            break;
         case '--batch-commit':
            opts.batchCommit = parseInt(args[++i], 10) || 50;
            break;
         case '--limit':
            opts.limit = parseInt(args[++i], 10);
            break;
         case '--min-size':
            opts.minSizeBytes = parseSize(args[++i]);
            break;
         case '--sort-by':
         case '--sort': {
            const sortVal = args[++i]?.toLowerCase();
            if (sortVal === 'size' || sortVal === 'name') {
               opts.sortBy = sortVal;
            }
            break;
         }
         case '--split-threshold':
            opts.splitThresholdChars = parseInt(args[++i], 10) || 80_000;
            break;
         case '--no-split':
            opts.noSplit = true;
            break;
         case '--extensions':
            opts.extensions = args[++i].split(',').map((e) => e.trim().toLowerCase());
            break;
         case '--skip-ai':
            opts.skipAi = true;
            break;
         case '--dry-run':
            opts.dryRun = true;
            break;
         case '--resume':
            opts.resume = true;
            break;
         case '--no-resume':
         case '--force':
            opts.resume = false;
            break;
         default:
            if (!args[i].startsWith('--')) {
               opts.sourceDir = resolvePath(args[i]);
            }
            break;
      }
   }

   if (!opts.sourceDir) {
      printUsage(1);
   }

   return opts;
}

// ─── Slugify ────────────────────────────────────────────────────────────────────

function slugify(text: string): string {
   return text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '')
      .slice(0, 80);
}

// ─── Category Mapper ────────────────────────────────────────────────────────────

const DIRECTORY_RULES: Array<{ pattern: string; category: string }> = [
   { pattern: 'biblio agro/couvert', category: 'cover-crops' },
   { pattern: 'couverts permanents', category: 'cover-crops' },
   { pattern: 'couvert', category: 'cover-crops' },
   { pattern: 'biblio agro/formations', category: 'formations' },
   { pattern: 'formations', category: 'formations' },
   { pattern: 'docs chambre _ ceta', category: 'soil-health' },
   { pattern: 'analyses sol', category: 'soil-health' },
   { pattern: 'compaction _ erosion', category: 'soil-health' },
   { pattern: 'guide culture', category: 'crops' },
   { pattern: 'phytos', category: 'plant-protection' },
   { pattern: 'fertilisation', category: 'soil-amendments' },
   { pattern: 'biostim', category: 'soil-amendments' },
   { pattern: 'elevage', category: 'livestock' },
   { pattern: 'arvalis', category: 'agriculture' },
   { pattern: 'biblio agro', category: 'soil-health' },
   { pattern: 'livres agronomie/compost', category: 'soil-amendments' },
   { pattern: 'livres agronomie', category: 'agronomie-livres' },
   { pattern: 'agriculture', category: 'agriculture' },
   { pattern: 'agroforesterie', category: 'agroforesterie' },
   { pattern: 'agronomy', category: 'agronomy' },
   { pattern: 'input', category: 'inbox' },
];

const FILENAME_RULES: Array<{ keywords: string[]; category: string }> = [
   { keywords: ['sol vivant', 'sol,', 'soil', 'pédolog', 'pedol', 'pedogen'], category: 'soil-health' },
   { keywords: ['viti', 'vignoble', 'vigne', 'vin ', 'wine', 'vineyard', 'oenolog'], category: 'viticulture' },
   { keywords: ['regenerat', 'régénérat'], category: 'regenerative-agriculture' },
   { keywords: ['couvert', 'cover crop', 'cover_crop', 'intercrop'], category: 'cover-crops' },
   { keywords: ['agroforest', 'arbre'], category: 'agroforesterie' },
   { keywords: ['compost', 'matière organique', 'fertiliz', 'engrais'], category: 'soil-amendments' },
   { keywords: ['microb', 'mycorhiz', 'glomalin', 'microbiome'], category: 'soil-biology' },
   { keywords: ['fao', 'alimentation', 'food security'], category: 'food-systems' },
   { keywords: ['climat', 'climate'], category: 'climate' },
   { keywords: ['irrigation', 'water', 'hydri'], category: 'water-management' },
   { keywords: ['allelopath'], category: 'allelopathy' },
   { keywords: ['maraîch', 'potager', 'garden', 'jardin'], category: 'market-gardening' },
];

function resolveCategory(absoluteFilePath: string, scanRoot: string): string {
   const relativePath = path.relative(scanRoot, absoluteFilePath);
   const relativeDir = path.dirname(relativePath).toLowerCase();
   const fullPathLower = absoluteFilePath.toLowerCase();
   const filename = path.basename(relativePath).toLowerCase();

   for (const rule of DIRECTORY_RULES) {
      if (
         relativeDir.startsWith(rule.pattern) ||
         relativeDir.includes(rule.pattern) ||
         fullPathLower.includes(rule.pattern)
      ) {
         return rule.category;
      }
   }
   for (const rule of FILENAME_RULES) {
      if (rule.keywords.some((kw) => filename.includes(kw))) {
         return rule.category;
      }
   }
   return 'inbox';
}

function buildS3Key(category: string, hash: string, filename: string): string {
   const ext = path.extname(filename).toLowerCase();
   const baseName = path.basename(filename, ext);
   const slug = slugify(baseName);
   const hash8 = hash.substring(0, 8);
   return `originals/${category}/${hash8}-${slug}${ext}`;
}

// ─── S3 Storage via @quatrain/storage-s3 ────────────────────────────────────────

async function initS3Storage(): Promise<boolean> {
   const endpoint = process.env.S3_ENDPOINT;
   const accessKey = process.env.S3_ACCESS_KEY;
   const secretKey = process.env.S3_SECRET_KEY;
   const region = process.env.S3_REGION || 'us-east-1';
   const bucket = process.env.S3_BUCKET || 'world-agronomy';

   if (!endpoint || !accessKey || !secretKey) {
      return false;
   }

   const adapter = new S3StorageAdapter({
      config: {
         bucket,
         endpoint,
         region,
         accesskey: accessKey,
         secret: secretKey,
      },
   });

   const connected = await adapter.test();
   if (!connected) {
      Log.warn('[Bulk Ingest] S3 test connection failed. Documents will be stored locally in Git.');
      return false;
   }

   Storage.addStorage(adapter, 'document-storage', true);
   return true;
}

async function uploadToS3(s3Key: string, buffer: Buffer, contentType: string): Promise<void> {
   const bucket = process.env.S3_BUCKET || 'world-agronomy';
   const storage = Storage.getStorage('document-storage');
   const stream = Readable.from(buffer);
   await storage.create(
      { ref: s3Key, bucket, contentType } as any,
      stream
   );
}

// ─── Git Operations ─────────────────────────────────────────────────────────────

function gitStageAndCommit(gitLocalPath: string, files: string[], message: string): void {
   try {
      for (const file of files) {
         execSync(`git add "${file}"`, { cwd: gitLocalPath, stdio: 'pipe' });
      }
      execSync(`git commit -m "${message.replace(/"/g, '\\"')}" --allow-empty`, {
         cwd: gitLocalPath,
         stdio: 'pipe',
      });
   } catch (err: any) {
      if (!err.stderr?.toString().includes('nothing to commit')) {
         Log.warn(`[Git] Commit warning: ${err.message}`);
      }
   }
}

function getGitRevision(gitLocalPath: string): string {
   try {
      const hash = execSync('git rev-parse --short HEAD', { cwd: gitLocalPath, stdio: 'pipe' })
         .toString()
         .trim();
      return `rev-${hash}`;
   } catch {
      return 'rev-1.0.0';
   }
}

async function scanDirectory(dir: string, extensions: Set<string>): Promise<ScanResult[]> {
   const stat = await fs.stat(dir);
   if (stat.isFile()) {
      const ext = path.extname(dir).toLowerCase().replace('.', '');
      if (extensions.has(ext)) {
         return [
            {
               absolutePath: dir,
               relativePath: path.basename(dir),
               extension: ext,
               sizeBytes: stat.size,
            },
         ];
      }
      return [];
   }

   const results: ScanResult[] = [];

   async function walk(current: string, root: string): Promise<void> {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
         const fullPath = path.join(current, entry.name);
         if (entry.isDirectory()) {
            if (entry.name.startsWith('.') || entry.name === '__MACOSX') continue;
            await walk(fullPath, root);
         } else if (entry.isFile()) {
            if (entry.name.startsWith('.')) continue;
            const ext = path.extname(entry.name).toLowerCase().replace('.', '');
            if (extensions.has(ext)) {
               const stat = await fs.stat(fullPath);
               results.push({
                  absolutePath: fullPath,
                  relativePath: path.relative(root, fullPath),
                  extension: ext,
                  sizeBytes: stat.size,
               });
            }
         }
      }
   }

   await walk(dir, dir);
   return results;
}

// ─── Progress Display ───────────────────────────────────────────────────────────

function printProgress(
   current: number,
   total: number,
   ingested: number,
   skipped: number,
   errors: number,
   totalTokens: number,
   totalCostUsd: number
): void {
   const pct = Math.round((current / total) * 100);
   const barLen = 25;
   const filled = Math.round((current / total) * barLen);
   const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
   const tokensStr = totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`;
   process.stdout.write(
      `\r  ${bar} ${pct}% (${current}/${total}) | ✓ ${ingested} | ⊘ ${skipped} | ✗ ${errors} | Tokens: ${tokensStr} ($${totalCostUsd.toFixed(4)})`
   );
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
   const opts = parseArgs(process.argv);

   // Validate source directory or file
   try {
      const stat = await fs.stat(opts.sourceDir);
      if (!stat.isDirectory() && !stat.isFile()) {
         console.error(`Error: ${opts.sourceDir} is neither a file nor a directory`);
         process.exit(1);
      }
   } catch {
      console.error(`Error: ${opts.sourceDir} does not exist`);
      process.exit(1);
   }

   const extensions = new Set(opts.extensions);

   console.log('');
   console.log('┌─────────────────────────────────────────────────────────┐');
   console.log('│          Modaka-Hub Bulk Ingestion CLI (OKF v0.2)       │');
   console.log('└─────────────────────────────────────────────────────────┘');
   console.log('');
   console.log(`  Source:       ${opts.sourceDir}`);
   console.log(`  Extensions:   ${opts.extensions.join(', ')}`);
   console.log(`  Concurrency:  ${opts.concurrency}`);
   console.log(`  Batch commit: ${opts.batchCommit}`);
   console.log(`  Skip AI:      ${opts.skipAi}`);
   console.log(`  Dry run:      ${opts.dryRun}`);
   console.log(`  Resume:       ${opts.resume}`);
   console.log('');

   // Phase 1: Scan
   console.log('  ⏳ Scanning files...');
   let files = await scanDirectory(opts.sourceDir, extensions);
   if (opts.minSizeBytes) {
      files = files.filter((f) => f.sizeBytes >= opts.minSizeBytes!);
   }
   if (opts.sortBy === 'size') {
      files.sort((a, b) => b.sizeBytes - a.sizeBytes);
   } else if (opts.sortBy === 'name') {
      files.sort((a, b) => a.absolutePath.localeCompare(b.absolutePath));
   }
   const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);
   const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
   console.log(`  ✓ Found ${files.length} matching files (${sizeMB} MB)`);
   console.log('');

   // Extension breakdown
   const extCounts = new Map<string, number>();
   for (const f of files) {
      extCounts.set(f.extension, (extCounts.get(f.extension) || 0) + 1);
   }
   for (const [ext, count] of extCounts.entries()) {
      console.log(`    .${ext}: ${count}`);
   }
   console.log('');

   // Dry run mode
   if (opts.dryRun) {
      const catCounts = new Map<string, number>();
      for (const f of files) {
         const cat = opts.category || resolveCategory(f.absolutePath, opts.sourceDir);
         catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
      }
      console.log('  Category mapping preview:');
      for (const [cat, count] of [...catCounts.entries()].sort((a, b) => b[1] - a[1])) {
         console.log(`    ${cat}: ${count}`);
      }
      console.log('');
      console.log('  ℹ Dry run complete. No files were ingested.');
      return;
   }

   // Phase 2: Validate environment
   const gitLocalPath = process.env.GIT_LOCAL_PATH;
   if (!gitLocalPath) {
      console.error('  ✗ Error: GIT_LOCAL_PATH is not set in .env');
      process.exit(1);
   }

   const useS3 = await initS3Storage();
   const s3Bucket = process.env.S3_BUCKET || 'world-agronomy';
   if (useS3) {
      Log.info(`[Bulk Ingest] S3 storage configured via @quatrain/storage-s3 (bucket: ${s3Bucket})`);
      console.log(`  ✓ S3 storage configured (bucket: ${s3Bucket})`);
   } else {
      console.log('  ℹ No S3 config — documents will be stored locally in Git repo');
   }

   const geminiApiKey = process.env.GEMINI_API_KEY;
   const useAi = !opts.skipAi && Boolean(geminiApiKey);
   const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

   if (useAi) {
      Log.info(`[Bulk Ingest] AI extraction enabled via @quatrain/okf-ingest (${model})`);
      console.log(`  ✓ AI extraction & Mermaid schema transcription enabled (${model})`);
   } else if (!opts.skipAi) {
      console.log('  ℹ No GEMINI_API_KEY found — falling back to heuristic extraction');
   }

   const revision = getGitRevision(gitLocalPath);
   console.log(`  ✓ Git repo: ${gitLocalPath} (${revision})`);
   console.log('');

   // Phase 3: Load dedup cache
   const cachePath = process.env.DEDUP_CACHE_PATH || path.resolve(process.cwd(), '.modaka-hub-hashes.json');
   const dedup = new OkfDedupCache(cachePath);
   await dedup.load();
   const syncedFromGit = await dedup.syncFromGitRepo(gitLocalPath);
   if (syncedFromGit > 0) {
      console.log(`  ✓ Synced ${syncedFromGit} existing documents from Git repository`);
   }
   if (dedup.size > 0) {
      console.log(`  ℹ Dedup index contains ${dedup.size} known documents`);
   }

   // Phase 4: Process files
   console.log('  ⏳ Processing files...');
   console.log('');

   let isTerminating = false;
   let cursor = 0;
   let completed = 0;
   let ingested = 0;
   let skipped = 0;
   let errors = 0;
   let runningTokens = 0;
   let runningCostUsd = 0;
   let totalDiagrams = 0;
   let totalTables = 0;

   const batchFiles: string[] = [];
   let batchCount = 0;
   let commitQueue = Promise.resolve();

   function scheduleBatchCommit(force = false): Promise<void> {
      commitQueue = commitQueue.then(async () => {
         if ((batchCount >= opts.batchCommit && batchFiles.length > 0) || (force && batchFiles.length > 0)) {
            const toCommit = [...batchFiles];
            batchFiles.length = 0;
            const count = batchCount;
            batchCount = 0;
            gitStageAndCommit(
               gitLocalPath,
               toCommit,
               `feat(curation): bulk ingest ${count} documents`
            );
            await dedup.save();
         }
      });
      return commitQueue;
   }

   const handleShutdown = async (signal: string) => {
      if (isTerminating) return;
      isTerminating = true;
      console.log(`\n\n  ⚠ Caught ${signal}. Gracefully flushing pending batch and saving cache...`);
      await scheduleBatchCommit(true);
      await dedup.save();
      console.log(`  ✓ State saved. ${ingested} ingested, ${skipped} skipped. Safe to resume anytime.`);
      process.exit(0);
   };

   process.on('SIGINT', () => handleShutdown('SIGINT'));
   process.on('SIGTERM', () => handleShutdown('SIGTERM'));

   async function processFile(file: ScanResult): Promise<void> {
      try {
         // Read and hash
         const buffer = await fs.readFile(file.absolutePath);
         const hash = crypto.createHash('sha256').update(buffer).digest('hex');

         // Dedup check
         if (opts.resume && dedup.isKnown(hash)) {
            skipped++;
            return;
         }

         // Extract text for PDF or text files
         let rawText = '';
         let isScanned = false;
         const isPdf = file.extension === 'pdf';

         if (isPdf) {
            const pdfResult = await extractPdfText(buffer);
            rawText = pdfResult.text;
            isScanned = pdfResult.isScanned;
         } else {
            try {
               rawText = buffer.toString('utf-8');
            } catch {
               rawText = '';
            }
         }

         // Clean filename for title fallback
         const rawTitle = path.basename(file.absolutePath, path.extname(file.absolutePath));
         const cleanTitle = rawTitle
            .replace(/ -- .*$/, '')
            .replace(/_/g, ' ')
            .trim();

         const splitThreshold = opts.splitThresholdChars || 80_000;
         const isMonograph = !opts.noSplit && rawText.length > splitThreshold && useAi && Boolean(geminiApiKey);

         // S3 Upload via @quatrain/storage-s3
         const preliminaryCategory = opts.category || resolveCategory(file.absolutePath, opts.sourceDir);
         const s3Key = buildS3Key(preliminaryCategory, hash, path.basename(file.absolutePath));
         let originalFileUri: string;

         if (useS3) {
            try {
               const contentType = isPdf ? 'application/pdf' : 'application/octet-stream';
               await uploadToS3(s3Key, buffer, contentType);
               originalFileUri = s3Key;
               Log.info(`[Bulk Ingest] Uploaded to S3: ${s3Key}`);
            } catch (s3Err: any) {
               Log.error(`[Bulk Ingest] S3 upload failed: ${s3Err.message}. Falling back to local.`);
               const assetsDir = path.join(gitLocalPath, 'assets', 'documents');
               await fs.mkdir(assetsDir, { recursive: true });
               await fs.writeFile(path.join(assetsDir, path.basename(file.absolutePath)), buffer);
               originalFileUri = `assets/documents/${path.basename(file.absolutePath)}`;
            }
         } else {
            const assetsDir = path.join(gitLocalPath, 'assets', 'documents');
            await fs.mkdir(assetsDir, { recursive: true });
            await fs.writeFile(path.join(assetsDir, path.basename(file.absolutePath)), buffer);
            originalFileUri = `assets/documents/${path.basename(file.absolutePath)}`;
         }

         if (isMonograph && geminiApiKey) {
            Log.info(
               `[Bulk Ingest] 📖 Large monograph detected (${(rawText.length / 1000).toFixed(0)}k chars): decomposing into chapters...`
            );
            const monographResult = await ingestMonograph(
               {
                  rawText,
                  filename: path.basename(file.absolutePath),
                  fileHash: hash,
                  originalFileUri,
                  gitLocalPath,
               },
               geminiApiKey,
               {
                  model,
                  soa: opts.soa,
                  revision,
                  defaultCategory: preliminaryCategory,
               }
            );

            runningTokens += monographResult.totalTokens.total;
            runningCostUsd += monographResult.totalTokens.costUsd;
            totalDiagrams += monographResult.totalDiagrams;
            totalTables += monographResult.totalTables;

            batchFiles.push(...monographResult.allCreatedFiles);
            batchCount += monographResult.allCreatedFiles.length;

            dedup.register(hash, {
               filename: path.basename(file.absolutePath),
               ingestedAt: new Date().toISOString(),
               category: monographResult.masterDoc.metadata.category || preliminaryCategory,
               s3Key: originalFileUri,
               tokens: monographResult.totalTokens,
            });

            ingested++;
            await scheduleBatchCommit();
            return;
         }

         // AI extraction via @quatrain/okf-ingest for standard documents
         let aiResult: any = null;
         if (useAi && geminiApiKey) {
            try {
               aiResult = await extractSemanticContent(
                  {
                     buffer,
                     rawText,
                     filename: path.basename(file.absolutePath),
                     isPdf,
                     isScanned,
                  },
                  geminiApiKey,
                  {
                     model,
                     soa: opts.soa,
                     defaultCategory: preliminaryCategory,
                  }
               );

               if (aiResult.usage) {
                  runningTokens += aiResult.usage.total;
                  runningCostUsd += aiResult.usage.costUsd;
               }
               totalDiagrams += aiResult.diagramsTranscribed || 0;
               totalTables += aiResult.tablesTranscribed || 0;
            } catch (aiErr: any) {
               Log.warn(`[Bulk Ingest] AI extraction warning on ${file.relativePath}: ${aiErr.message}`);
            }
         }

         const title = aiResult?.metadata?.title || cleanTitle;
         const slug = slugify(title) || hash.substring(0, 12);
         const category = opts.category || aiResult?.metadata?.category || preliminaryCategory;
         const description = aiResult?.metadata?.description || (rawText
            ? rawText.substring(0, 300).replace(/\s+/g, ' ').trim() + '...'
            : 'Document agronomique ingéré.');

         // Prepare OKF v0.2 metadata
         const metadata: OkfFrontmatterV2 = {
            type: aiResult?.metadata?.type || 'document',
            title,
            description,
            tags: aiResult?.metadata?.tags || ['agronomie', 'curation', category],
            status: 'draft',
            generated: {
               by: `quatrain/okf-ingest (${model})`,
               at: new Date().toISOString(),
               tokens: aiResult?.usage,
            },
            sources: [
               {
                  id: 'original-file',
                  resource: originalFileUri,
                  title: path.basename(file.absolutePath),
                  fileHash: hash,
               },
            ],
            soa: opts.soa,
            revision,
            category,
            thematics: aiResult?.metadata?.thematics || [category],
            soils: aiResult?.metadata?.soils,
            climates: aiResult?.metadata?.climates,
            itineraries: aiResult?.metadata?.itineraries,
            crops: aiResult?.metadata?.crops,
            authors: aiResult?.metadata?.authors,
            publisher: aiResult?.metadata?.publisher,
            publicationYear: aiResult?.metadata?.publicationYear,
            originalFileUri,
            fileHash: hash,
            source: `bulk-ingest:${file.relativePath}`,
            language: aiResult?.metadata?.language || 'fr',
            timestamp: new Date().toISOString(),
         };

         // Final document body: Extracted full text + transcribed Mermaid diagrams
         const bodyContent = aiResult?.body || (rawText.trim() ? `# ${title}\n\n${rawText.trim()}` : `# ${title}\n\n${description}`);

         // Write OKF v0.2 document
         const okfPath = await writeOkfDocument({
            gitLocalPath,
            category,
            slug,
            metadata,
            body: bodyContent,
         });

         // Batch Git tracking
         batchFiles.push(okfPath);
         if (!useS3) {
            batchFiles.push(originalFileUri);
         }
         batchCount++;

         // Register in dedup cache with token cost
         dedup.register(hash, {
            filename: path.basename(file.absolutePath),
            ingestedAt: new Date().toISOString(),
            category,
            s3Key,
            tokens: aiResult?.usage,
         });

         ingested++;
         await scheduleBatchCommit(false);
      } catch (err: any) {
         errors++;
         Log.error(`[Bulk Ingest] Error processing ${file.relativePath}: ${err.message}`);
      } finally {
         completed++;
         printProgress(completed, files.length, ingested, skipped, errors, runningTokens, runningCostUsd);
      }
   }

   const concurrency = Math.max(1, opts.concurrency);
   const workers = Array.from({ length: Math.min(concurrency, files.length) }, async () => {
      while (cursor < files.length && !isTerminating) {
         if (opts.limit && ingested >= opts.limit) {
            break;
         }
         const index = cursor++;
         const file = files[index];
         await processFile(file);
         if (opts.limit && ingested >= opts.limit) {
            break;
         }
         if (opts.delayMs > 0 && !isTerminating) {
            await sleep(opts.delayMs);
         }
      }
   });

   await Promise.all(workers);

   // Final batch commit & save
   await scheduleBatchCommit(true);
   await dedup.save();

   console.log('');
   console.log('');
   console.log('  ┌─────────────────────────────────────────────┐');
   console.log('  │  Bulk Ingestion Complete (OKF v0.2)         │');
   console.log('  └─────────────────────────────────────────────┘');
   console.log(`  ✓ Ingested:          ${ingested}`);
   console.log(`  ⊘ Skipped:           ${skipped}`);
   console.log(`  ✗ Errors:            ${errors}`);
   console.log(`  Total files:         ${files.length}`);
   console.log('  ---------------------------------------------');
   console.log(`  Total Tokens:        ${runningTokens.toLocaleString('fr-FR')}`);
   console.log(`  Total AI Cost:       $${runningCostUsd.toFixed(4)} USD`);
   if (totalDiagrams > 0 || totalTables > 0) {
      console.log(`  Transcribed Schemas: ${totalDiagrams} Mermaid diagrams, ${totalTables} Markdown tables`);
   }
   if (dedup.size > 0) {
      console.log(`  ℹ Dedup cache:       ${dedup.size} hashes saved`);
   }
   console.log('');
}

main().catch((err) => {
   console.error('Fatal error:', err);
   process.exit(1);
});
