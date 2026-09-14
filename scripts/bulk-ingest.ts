#!/usr/bin/env node
/**
 * Bulk Ingestion CLI for Modaka-Hub.
 *
 * Scans a local directory recursively for documents (PDF, DOC, DOCX, TXT),
 * deduplicates via SHA-256, maps subdirectories to OKF categories, uploads
 * binaries to Supabase S3 storage, and submits tasks to the ingestion queue.
 *
 * @example
 *   yarn bulk-ingest --dry-run ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --concurrency 3 --batch-commit 50 ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --resume --skip-ai ~/DOCUMENTS/BRAD/RAG
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

// Dynamic imports after dotenv so env vars are available
const SUPPORTED_EXTENSIONS = new Set<string>();
const DEFAULT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt'];

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
}

interface ScanResult {
   absolutePath: string;
   relativePath: string;
   extension: string;
   sizeBytes: number;
}

// ─── Argument Parsing ──────────────────────────────────────────────────────────

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
      resume: false,
   };

   for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
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
         default:
            if (!args[i].startsWith('--')) {
               opts.sourceDir = path.resolve(args[i]);
            }
            break;
      }
   }

   if (!opts.sourceDir) {
      console.error('Usage: bulk-ingest [options] <source-directory>');
      console.error('');
      console.error('Options:');
      console.error('  --category <cat>       Default OKF category');
      console.error('  --soa <soa>            Source of Authority');
      console.error('  --concurrency <n>      Parallel queue tasks (default: 3)');
      console.error('  --delay <ms>           Delay between submissions (default: 500)');
      console.error('  --batch-commit <n>     Docs per git commit (default: 50)');
      console.error('  --extensions <list>    Comma-separated extensions (default: pdf,doc,docx,txt)');
      console.error('  --skip-ai              Skip Gemini AI extraction');
      console.error('  --dry-run              List files without ingesting');
      console.error('  --resume               Skip already-ingested files');
      process.exit(1);
   }

   return opts;
}

// ─── Directory Scanner ─────────────────────────────────────────────────────────

async function scanDirectory(dir: string, extensions: Set<string>): Promise<ScanResult[]> {
   const results: ScanResult[] = [];

   async function walk(current: string, root: string): Promise<void> {
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
         const fullPath = path.join(current, entry.name);
         if (entry.isDirectory()) {
            // Skip hidden directories and macOS metadata
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

// ─── SHA-256 Hashing ────────────────────────────────────────────────────────────

async function hashFile(filePath: string): Promise<string> {
   const buffer = await fs.readFile(filePath);
   return crypto.createHash('sha256').update(buffer).digest('hex');
}

// ─── File Type Detection ────────────────────────────────────────────────────────

function detectFileType(ext: string): 'pdf' | 'text' | 'image' {
   switch (ext) {
      case 'pdf':
         return 'pdf';
      case 'doc':
      case 'docx':
      case 'txt':
         return 'text';
      default:
         return 'text';
   }
}

// ─── Progress Display ───────────────────────────────────────────────────────────

function printProgress(current: number, total: number, ingested: number, skipped: number, errors: number): void {
   const pct = Math.round((current / total) * 100);
   const barLen = 30;
   const filled = Math.round((current / total) * barLen);
   const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
   process.stdout.write(
      `\r  ${bar} ${pct}% (${current}/${total}) | ✓ ${ingested} | ⊘ ${skipped} | ✗ ${errors}`
   );
}

// ─── Sleep Utility ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
   const opts = parseArgs(process.argv);

   // Validate source directory exists
   try {
      const stat = await fs.stat(opts.sourceDir);
      if (!stat.isDirectory()) {
         console.error(`Error: ${opts.sourceDir} is not a directory`);
         process.exit(1);
      }
   } catch {
      console.error(`Error: ${opts.sourceDir} does not exist`);
      process.exit(1);
   }

   // Build extensions set
   for (const ext of opts.extensions) {
      SUPPORTED_EXTENSIONS.add(ext);
   }

   console.log('');
   console.log('┌─────────────────────────────────────────────────────────┐');
   console.log('│          Modaka-Hub Bulk Ingestion CLI                  │');
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
   console.log('  ⏳ Scanning directory...');
   const files = await scanDirectory(opts.sourceDir, SUPPORTED_EXTENSIONS);
   const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);
   const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
   console.log(`  ✓ Found ${files.length} files (${sizeMB} MB)`);
   console.log('');

   // Show extension breakdown
   const extCounts = new Map<string, number>();
   for (const f of files) {
      extCounts.set(f.extension, (extCounts.get(f.extension) || 0) + 1);
   }
   for (const [ext, count] of [...extCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    .${ext}: ${count}`);
   }
   console.log('');

   if (opts.dryRun) {
      // Dry-run: show category mapping
      const { resolveCategory } = await import('../src/lib/category-mapper.js');
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

   // Phase 2: Initialize backend
   console.log('  ⏳ Initializing backend...');
   const { initBackend } = await import('../src/lib/backend.js');
   await initBackend();

   const { DedupCache } = await import('../src/lib/dedup-cache.js');
   const { resolveCategory, buildS3Key } = await import('../src/lib/category-mapper.js');
   const { queueManager } = await import('../src/lib/queue.js');

   // Phase 3: Load dedup cache
   const cachePath = path.resolve(process.cwd(), '.modaka-hub-hashes.json');
   const dedup = new DedupCache(cachePath);
   await dedup.load();

   // Phase 4: Process files
   console.log('  ⏳ Processing files...');
   console.log('');

   let ingested = 0;
   let skipped = 0;
   let errors = 0;
   const tempDir = path.resolve(process.cwd(), '.modaka-hub-temp');
   await fs.mkdir(tempDir, { recursive: true });

   for (let i = 0; i < files.length; i++) {
      const file = files[i];
      printProgress(i + 1, files.length, ingested, skipped, errors);

      try {
         // Hash the file
         const hash = await hashFile(file.absolutePath);

         // Deduplication check
         if (opts.resume && dedup.isKnown(hash)) {
            skipped++;
            continue;
         }

         // Resolve category
         const category = opts.category || resolveCategory(file.absolutePath, opts.sourceDir);

         // Build S3 key
         const s3Key = buildS3Key(category, hash, path.basename(file.absolutePath));

         // Copy to temp directory for queue processing
         const tempFileName = `${Date.now()}-${path.basename(file.absolutePath)}`;
         const tempFilePath = path.join(tempDir, tempFileName);
         await fs.copyFile(file.absolutePath, tempFilePath);

         // Submit to queue
         await queueManager.addTask({
            name: path.basename(file.absolutePath),
            type: detectFileType(file.extension),
            tempFilePath,
            category,
            source: `bulk-ingest:${file.relativePath}`,
            fileHash: hash,
            soa: opts.soa,
            s3Key,
            skipAi: opts.skipAi,
         } as any);

         // Register in dedup cache
         dedup.register(hash, {
            filename: path.basename(file.absolutePath),
            ingestedAt: new Date().toISOString(),
            category,
            s3Key,
         });

         ingested++;

         // Throttle between submissions
         if (opts.delayMs > 0 && i < files.length - 1) {
            await sleep(opts.delayMs);
         }

         // Periodic cache saves (every 25 files)
         if (ingested % 25 === 0) {
            await dedup.save();
         }
      } catch (err: any) {
         errors++;
         console.error(`\n  ✗ Error processing ${file.relativePath}: ${err.message}`);
      }
   }

   // Final save
   await dedup.save();

   console.log('');
   console.log('');
   console.log('  ┌─────────────────────────────────────────────┐');
   console.log('  │  Bulk Ingestion Complete                    │');
   console.log('  └─────────────────────────────────────────────┘');
   console.log(`  ✓ Ingested:  ${ingested}`);
   console.log(`  ⊘ Skipped:   ${skipped}`);
   console.log(`  ✗ Errors:    ${errors}`);
   console.log(`  Total:       ${files.length}`);
   console.log('');
   console.log('  Queue tasks submitted. Documents will be processed asynchronously.');
   console.log('  Monitor progress via the Modaka-Hub UI or queue API.');
   console.log('');
}

main().catch((err) => {
   console.error('Fatal error:', err);
   process.exit(1);
});
