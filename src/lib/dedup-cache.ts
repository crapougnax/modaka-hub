import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Log } from '@quatrain/log';

/**
 * Metadata associated with a deduplicated file entry.
 */
export interface DedupEntry {
   filename: string;
   ingestedAt: string;
   category: string;
   s3Key?: string;
}

/**
 * Persistent SHA-256 deduplication cache.
 *
 * Stores file hashes in a JSON file to prevent re-ingestion of
 * already-processed documents across CLI invocations (--resume mode).
 */
export class DedupCache {
   protected cache: Map<string, DedupEntry> = new Map();
   protected dirty = false;

   constructor(protected readonly filePath: string) {}

   /**
    * Loads the cache from disk. If the file does not exist, starts empty.
    */
   async load(): Promise<void> {
      try {
         const raw = await fs.readFile(this.filePath, 'utf-8');
         const data = JSON.parse(raw) as Record<string, DedupEntry>;
         this.cache = new Map(Object.entries(data));
         Log.info(`[DedupCache] Loaded ${this.cache.size} known hashes from ${this.filePath}`);
      } catch {
         this.cache = new Map();
         Log.info(`[DedupCache] No existing cache found at ${this.filePath}, starting fresh`);
      }
   }

   /**
    * Checks whether a given SHA-256 hash has already been ingested.
    */
   isKnown(hash: string): boolean {
      return this.cache.has(hash);
   }

   /**
    * Retrieves metadata for a previously ingested hash.
    */
   get(hash: string): DedupEntry | undefined {
      return this.cache.get(hash);
   }

   /**
    * Registers a newly ingested file hash with its metadata.
    */
   register(hash: string, entry: DedupEntry): void {
      this.cache.set(hash, entry);
      this.dirty = true;
   }

   /**
    * Persists the cache to disk if it has been modified.
    */
   async save(): Promise<void> {
      if (!this.dirty) return;
      const data: Record<string, DedupEntry> = Object.fromEntries(this.cache);
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
      Log.info(`[DedupCache] Saved ${this.cache.size} hashes to ${this.filePath}`);
   }

   /**
    * Returns the total number of known hashes.
    */
   get size(): number {
      return this.cache.size;
   }
}
