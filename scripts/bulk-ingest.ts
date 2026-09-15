#!/usr/bin/env node
/**
 * Bulk Ingestion CLI for Modaka-Hub — Standalone Edition.
 *
 * Runs outside Vite/Astro with ZERO dependency on @quatrain/* packages.
 * Uses @aws-sdk/client-s3 directly for Supabase S3 upload and writes
 * OKF markdown files directly to the Git repo on disk.
 *
 * @example
 *   yarn bulk-ingest --dry-run ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --concurrency 3 --batch-commit 50 ~/DOCUMENTS/BRAD/RAG
 *   yarn bulk-ingest --resume --skip-ai ~/DOCUMENTS/BRAD/RAG
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import dotenv from 'dotenv';

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
}

interface ScanResult {
   absolutePath: string;
   relativePath: string;
   extension: string;
   sizeBytes: number;
}

interface DedupEntry {
   filename: string;
   ingestedAt: string;
   category: string;
   s3Key?: string;
}

// ─── Argument Parsing ───────────────────────────────────────────────────────────

const DEFAULT_EXTENSIONS = ['pdf', 'doc', 'docx', 'txt'];

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
      console.error('  --concurrency <n>      Parallel tasks (default: 3)');
      console.error('  --delay <ms>           Delay between tasks (default: 500)');
      console.error('  --batch-commit <n>     Docs per Git commit (default: 50)');
      console.error('  --extensions <list>    Comma-separated extensions (default: pdf,doc,docx,txt)');
      console.error('  --skip-ai              Skip Gemini AI extraction');
      console.error('  --dry-run              List files without ingesting');
      console.error('  --resume               Skip already-ingested files');
      process.exit(1);
   }

   return opts;
}

// ─── Slugify ────────────────────────────────────────────────────────────────────

function slugify(text: string): string {
   if (!text) return '';
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
   { pattern: 'biblio agro/formations', category: 'formations' },
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
   const filename = path.basename(relativePath).toLowerCase();

   for (const rule of DIRECTORY_RULES) {
      if (relativeDir.startsWith(rule.pattern) || relativeDir.includes(rule.pattern)) {
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

// ─── Dedup Cache ────────────────────────────────────────────────────────────────

class DedupCache {
   private cache: Map<string, DedupEntry> = new Map();
   private dirty = false;

   constructor(private readonly filePath: string) {}

   async load(): Promise<void> {
      try {
         const raw = await fs.readFile(this.filePath, 'utf-8');
         const data = JSON.parse(raw) as Record<string, DedupEntry>;
         this.cache = new Map(Object.entries(data));
         console.log(`  ℹ Dedup cache loaded: ${this.cache.size} known hashes`);
      } catch {
         this.cache = new Map();
      }
   }

   isKnown(hash: string): boolean {
      return this.cache.has(hash);
   }

   register(hash: string, entry: DedupEntry): void {
      this.cache.set(hash, entry);
      this.dirty = true;
   }

   async save(): Promise<void> {
      if (!this.dirty) return;
      const data: Record<string, DedupEntry> = Object.fromEntries(this.cache);
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
   }

   get size(): number {
      return this.cache.size;
   }
}

// ─── S3 Uploader (direct @aws-sdk, no Quatrain) ────────────────────────────────

async function createS3Client() {
   const endpoint = process.env.S3_ENDPOINT;
   const accessKey = process.env.S3_ACCESS_KEY;
   const secretKey = process.env.S3_SECRET_KEY;
   const region = process.env.S3_REGION || 'us-east-1';

   if (!endpoint || !accessKey || !secretKey) {
      return null;
   }

   const { S3Client } = await import('@aws-sdk/client-s3');
   return new S3Client({
      forcePathStyle: true,
      region,
      endpoint,
      credentials: {
         accessKeyId: accessKey,
         secretAccessKey: secretKey,
      },
   });
}

async function uploadToS3(
   s3: any,
   bucket: string,
   key: string,
   buffer: Buffer,
   contentType: string
): Promise<void> {
   const { PutObjectCommand } = await import('@aws-sdk/client-s3');
   await s3.send(
      new PutObjectCommand({
         Bucket: bucket,
         Key: key,
         Body: buffer,
         ContentType: contentType,
      })
   );
}

// ─── OKF Document Writer ────────────────────────────────────────────────────────

function buildOkfFrontmatter(fields: Record<string, any>): string {
   const lines: string[] = ['---'];
   for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
         if (value.length === 0) continue;
         lines.push(`${key}:`);
         for (const item of value) {
            lines.push(`  - ${item}`);
         }
      } else {
         lines.push(`${key}: ${value}`);
      }
   }
   lines.push('---');
   return lines.join('\n');
}

async function writeOkfDocument(
   gitLocalPath: string,
   category: string,
   slug: string,
   metadata: Record<string, any>,
   body: string
): Promise<string> {
   const categoryDir = path.join(gitLocalPath, 'content', category);
   await fs.mkdir(categoryDir, { recursive: true });

   const frontmatter = buildOkfFrontmatter(metadata);
   const content = `${frontmatter}\n\n${body}\n`;
   const filePath = path.join(categoryDir, `${slug}.md`);
   await fs.writeFile(filePath, content, 'utf-8');
   return `content/${category}/${slug}.md`;
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
      // Silently ignore if nothing to commit
      if (!err.stderr?.toString().includes('nothing to commit')) {
         console.error(`  ⚠ Git commit warning: ${err.message}`);
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

// ─── PDF Text Extraction ────────────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer): Promise<string> {
   try {
      const pdfParse = (await import('pdf-parse')).default;
      const parsed = await pdfParse(buffer);
      return parsed.text || '';
   } catch {
      return '';
   }
}

// ─── Directory Scanner ──────────────────────────────────────────────────────────

async function scanDirectory(dir: string, extensions: Set<string>): Promise<ScanResult[]> {
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

function printProgress(current: number, total: number, ingested: number, skipped: number, errors: number): void {
   const pct = Math.round((current / total) * 100);
   const barLen = 30;
   const filled = Math.round((current / total) * barLen);
   const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
   process.stdout.write(
      `\r  ${bar} ${pct}% (${current}/${total}) | ✓ ${ingested} | ⊘ ${skipped} | ✗ ${errors}`
   );
}

function sleep(ms: number): Promise<void> {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
   const opts = parseArgs(process.argv);

   // Validate source directory
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

   const extensions = new Set(opts.extensions);

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
   const files = await scanDirectory(opts.sourceDir, extensions);
   const totalSize = files.reduce((sum, f) => sum + f.sizeBytes, 0);
   const sizeMB = (totalSize / (1024 * 1024)).toFixed(1);
   console.log(`  ✓ Found ${files.length} files (${sizeMB} MB)`);
   console.log('');

   // Extension breakdown
   const extCounts = new Map<string, number>();
   for (const f of files) {
      extCounts.set(f.extension, (extCounts.get(f.extension) || 0) + 1);
   }
   for (const [ext, count] of [...extCounts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    .${ext}: ${count}`);
   }
   console.log('');

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

   const s3Client = await createS3Client();
   const s3Bucket = process.env.S3_BUCKET || 'world-agronomy';
   if (s3Client) {
      console.log(`  ✓ S3 storage configured (bucket: ${s3Bucket})`);
   } else {
      console.log('  ℹ No S3 config — documents will be stored locally in Git repo');
   }

   const revision = getGitRevision(gitLocalPath);
   console.log(`  ✓ Git repo: ${gitLocalPath} (${revision})`);
   console.log('');

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
   const batchFiles: string[] = [];
   let batchCount = 0;

   for (let i = 0; i < files.length; i++) {
      const file = files[i];
      printProgress(i + 1, files.length, ingested, skipped, errors);

      try {
         // Read and hash
         const buffer = await fs.readFile(file.absolutePath);
         const hash = crypto.createHash('sha256').update(buffer).digest('hex');

         // Dedup check
         if (opts.resume && dedup.isKnown(hash)) {
            skipped++;
            continue;
         }

         // Resolve category
         const category = opts.category || resolveCategory(file.absolutePath, opts.sourceDir);

         // Build title from filename
         const rawTitle = path.basename(file.absolutePath, path.extname(file.absolutePath));
         // Clean up Anna's Archive style filenames
         const title = rawTitle
            .replace(/ -- .*$/, '') // Remove everything after first " -- "
            .replace(/_/g, ' ')
            .trim();
         const slug = slugify(title) || hash.substring(0, 12);

         // Extract text for PDF
         let rawText = '';
         const isPdf = file.extension === 'pdf';
         if (isPdf) {
            rawText = await extractPdfText(buffer);
         } else {
            try {
               rawText = buffer.toString('utf-8');
            } catch {
               rawText = '';
            }
         }

         const summary = rawText
            ? rawText.substring(0, 300).replace(/\s+/g, ' ').trim() + '...'
            : 'Document agronomique ingéré.';

         // S3 Upload
         const s3Key = buildS3Key(category, hash, path.basename(file.absolutePath));
         let originalFileUri: string;

         if (s3Client) {
            try {
               const contentType = isPdf ? 'application/pdf' : 'application/octet-stream';
               await uploadToS3(s3Client, s3Bucket, s3Key, buffer, contentType);
               originalFileUri = s3Key;
            } catch (s3Err: any) {
               console.error(`\n  ⚠ S3 upload failed for ${file.relativePath}: ${s3Err.message}`);
               // Fallback: store locally
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

         // Write OKF document
         const okfPath = await writeOkfDocument(gitLocalPath, category, slug, {
            soa: opts.soa,
            revision,
            type: 'document',
            title,
            category,
            tags: ['agronomie', 'curation', category],
            thematics: [category],
            originalFileUri,
            fileHash: hash,
            source: `bulk-ingest:${file.relativePath}`,
            language: 'fr',
            timestamp: new Date().toISOString(),
         }, summary);

         // Batch Git commit tracking
         batchFiles.push(okfPath);
         if (!s3Client) {
            batchFiles.push(originalFileUri);
         }
         batchCount++;

         if (batchCount >= opts.batchCommit) {
            gitStageAndCommit(
               gitLocalPath,
               batchFiles,
               `feat(curation): bulk ingest ${batchCount} documents`
            );
            batchFiles.length = 0;
            batchCount = 0;
         }

         // Register in dedup cache
         dedup.register(hash, {
            filename: path.basename(file.absolutePath),
            ingestedAt: new Date().toISOString(),
            category,
            s3Key,
         });

         ingested++;

         // Throttle
         if (opts.delayMs > 0 && i < files.length - 1) {
            await sleep(opts.delayMs);
         }

         // Periodic cache saves
         if (ingested % 25 === 0) {
            await dedup.save();
         }
      } catch (err: any) {
         errors++;
         console.error(`\n  ✗ Error processing ${file.relativePath}: ${err.message}`);
      }
   }

   // Final batch commit
   if (batchCount > 0) {
      gitStageAndCommit(
         gitLocalPath,
         batchFiles,
         `feat(curation): bulk ingest ${batchCount} documents`
      );
   }

   // Final cache save
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
   if (dedup.size > 0) {
      console.log(`  ℹ Dedup cache: ${dedup.size} hashes saved`);
   }
   console.log('');
}

main().catch((err) => {
   console.error('Fatal error:', err);
   process.exit(1);
});
