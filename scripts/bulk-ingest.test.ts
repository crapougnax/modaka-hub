/**
 * Smoke tests for the bulk-ingest CLI script.
 *
 * These tests validate that the standalone CLI works correctly
 * without any @quatrain/* dependencies (which fail under tsx + PnP).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const CLI_PATH = path.resolve(__dirname, '../scripts/bulk-ingest.ts');
const TEST_DIR = path.resolve(__dirname, '../.test-bulk-ingest');

/** Helper to run the CLI and capture output */
function runCli(args: string): { stdout: string; exitCode: number } {
   try {
      const stdout = execSync(`npx tsx ${CLI_PATH} ${args}`, {
         cwd: path.resolve(__dirname, '..'),
         encoding: 'utf-8',
         timeout: 30_000,
         env: {
            ...process.env,
            GIT_LOCAL_PATH: TEST_DIR,
            DEFAULT_SOA: 'test/bulk-ingest',
         },
      });
      return { stdout, exitCode: 0 };
   } catch (err: any) {
      return { stdout: err.stdout || err.message, exitCode: err.status || 1 };
   }
}

describe('bulk-ingest CLI', () => {
   beforeAll(async () => {
      // Create test directory with sample files
      const sampleDir = path.join(TEST_DIR, 'samples');
      const soilDir = path.join(sampleDir, 'soil-health');
      const coverDir = path.join(sampleDir, 'cover-crops');
      const contentDir = path.join(TEST_DIR, 'content');

      await fs.mkdir(soilDir, { recursive: true });
      await fs.mkdir(coverDir, { recursive: true });
      await fs.mkdir(contentDir, { recursive: true });

      // Create sample text files
      await fs.writeFile(
         path.join(soilDir, 'sol-vivant-intro.txt'),
         'Le sol vivant est un écosystème complexe composé de micro-organismes, de champignons mycorhiziens et de faune endogée.'
      );
      await fs.writeFile(
         path.join(soilDir, 'pedologie-bases.txt'),
         'La pédologie étudie la formation, la classification et la cartographie des sols.'
      );
      await fs.writeFile(
         path.join(coverDir, 'guide-couverts.txt'),
         'Les couverts végétaux protègent le sol contre l\'érosion et favorisent la fixation d\'azote par les légumineuses.'
      );
      await fs.writeFile(
         path.join(sampleDir, 'regenerative-agriculture-overview.txt'),
         'Regenerative agriculture focuses on improving soil health through minimal tillage and cover cropping.'
      );
      await fs.writeFile(
         path.join(sampleDir, 'viticulture-bio-aoc.txt'),
         'La viticulture biologique en AOC Ventoux combine enherbement permanent et faible utilisation d\'intrants.'
      );

      // Initialize a Git repo for commit tests
      execSync('git init && git add -A && git commit -m "init" --allow-empty', {
         cwd: TEST_DIR,
         stdio: 'pipe',
      });
   });

   afterAll(async () => {
      await fs.rm(TEST_DIR, { recursive: true, force: true });
   });

   it('should print usage when no arguments provided', () => {
      const result = runCli('');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('Usage: bulk-ingest');
   });

   it('should fail on non-existent directory', () => {
      const result = runCli('/nonexistent/path');
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('does not exist');
   });

   it('should perform dry-run and detect correct categories', () => {
      const samplesDir = path.join(TEST_DIR, 'samples');
      const result = runCli(`--dry-run --extensions txt ${samplesDir}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Dry run complete');
      expect(result.stdout).toContain('.txt: 5');
      // Category detection from directory names
      expect(result.stdout).toContain('soil-health:');
      expect(result.stdout).toContain('cover-crops:');
   });

   it('should ingest files and create OKF documents', async () => {
      const samplesDir = path.join(TEST_DIR, 'samples');
      const result = runCli(`--extensions txt --batch-commit 10 --delay 0 --skip-ai ${samplesDir}`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Ingested:');

      // Check OKF files were created
      const contentDir = path.join(TEST_DIR, 'content');
      const categories = await fs.readdir(contentDir);
      expect(categories.length).toBeGreaterThan(0);

      // At least one .md file should exist
      let foundMd = false;
      for (const cat of categories) {
         const catDir = path.join(contentDir, cat);
         const catStat = await fs.stat(catDir);
         if (!catStat.isDirectory()) continue;
         const files = await fs.readdir(catDir);
         for (const f of files) {
            if (f.endsWith('.md')) {
               foundMd = true;
               // Verify OKF frontmatter
               const content = await fs.readFile(path.join(catDir, f), 'utf-8');
               expect(content).toContain('---');
               expect(content).toContain('soa: test/bulk-ingest');
               expect(content).toContain('type: document');
            }
         }
      }
      expect(foundMd).toBe(true);
   });

   it('should skip already-ingested files in resume mode', async () => {
      const samplesDir = path.join(TEST_DIR, 'samples');
      const result = runCli(`--resume --extensions txt --delay 0 --skip-ai ${samplesDir}`);
      expect(result.exitCode).toBe(0);
      // All files should be skipped since they were ingested in the previous test
      expect(result.stdout).toContain('Skipped:');
      // Extract the skipped count
      const skippedMatch = result.stdout.match(/Skipped:\s+(\d+)/);
      expect(skippedMatch).not.toBeNull();
      expect(parseInt(skippedMatch![1], 10)).toBe(5);
   });

   it('should commit in batches', async () => {
      // Check git log for batch commits
      const log = execSync('git log --oneline', { cwd: TEST_DIR, encoding: 'utf-8' });
      expect(log).toContain('bulk ingest');
   });
});
