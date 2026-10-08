#!/usr/bin/env bun
/**
 * Modaka-Hub Catalog & Encyclopedic Ingestion CLI
 *
 * Ingests encyclopedic catalogs, floras, and dictionaries into ordered atomic OKF v0.2 fiches
 * powered by @quatrain/okf-ingest-catalog.
 *
 * Usage:
 *   bun scripts/ingest-catalog.ts [options] <pdf-path>
 */

import { AbstractAiAdapter } from '@quatrain/ai';
import { GeminiAdapter } from '@quatrain/ai-gemini';
import { AgroecologyTaxonomyProfile, extractPdfPages } from '@quatrain/okf-ingest';
import {
   CatalogEntryChunk,
   CatalogIngestionOptions,
   CatalogMonographInput,
   ingestCatalogMonograph,
   slugify,
} from '@quatrain/okf-ingest-catalog';
import { OpenAiAdapter } from '@quatrain/ai-openai';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface CliOptions {
   pdfPath: string;
   category: string;
   limit?: number;
   offset?: number;
   introOnly?: boolean;
   entriesOnly?: boolean;
   dryRun?: boolean;
   languages?: string[];
   adapter?: 'gemini' | 'lmstudio';
   model?: string;
   lmStudioUrl?: string;
}

function parseCliArgs(): CliOptions {
   const args = process.argv.slice(2);
   const opts: CliOptions = {
      pdfPath: '',
      category: 'bio-indication',
      offset: 0,
      dryRun: false,
      lmStudioUrl: process.env.LM_STUDIO_URL || 'http://localhost:1234/v1',
   };

   for (let i = 0; i < args.length; i++) {
      switch (args[i]) {
         case '--category':
            opts.category = args[++i];
            break;
         case '--limit':
            opts.limit = parseInt(args[++i], 10);
            break;
         case '--offset':
            opts.offset = parseInt(args[++i], 10);
            break;
         case '--languages':
            opts.languages = args[++i].split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            break;
         case '--adapter':
            opts.adapter = args[++i].toLowerCase() as 'gemini' | 'lmstudio';
            break;
         case '--model':
            opts.model = args[++i];
            break;
         case '--lm-studio-url':
            opts.lmStudioUrl = args[++i];
            break;
         case '--intro-only':
            opts.introOnly = true;
            break;
         case '--entries-only':
            opts.entriesOnly = true;
            break;
         case '--dry-run':
            opts.dryRun = true;
            break;
         default:
            if (!args[i].startsWith('--')) {
               opts.pdfPath = path.resolve(args[i]);
            }
            break;
      }
   }

   if (!opts.pdfPath) {
      console.error('Usage: bun scripts/ingest-catalog.ts [options] <pdf-path>');
      process.exit(1);
   }

   return opts;
}

async function computeSha256(filePath: string): Promise<string> {
   const buf = await fs.readFile(filePath);
   return createHash('sha256').update(buf).digest('hex');
}

async function main(): Promise<void> {
   const opts = parseCliArgs();
   const selectedAdapterType = opts.adapter || (process.env.GEMINI_API_KEY ? 'gemini' : 'lmstudio');
   let aiAdapter: AbstractAiAdapter;
   let modelName: string;

   if (selectedAdapterType === 'lmstudio') {
      modelName = opts.model || 'gemma-4-e4b-it';
      console.log(`\n🤖 AI Adapter: Local LM Studio`);
      console.log(`  Endpoint:    ${opts.lmStudioUrl}`);
      console.log(`  Model:       ${modelName}`);
      aiAdapter = OpenAiAdapter.forLmStudio(opts.lmStudioUrl, modelName);
      aiAdapter.init();
   } else {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
         console.error('Error: GEMINI_API_KEY environment variable is required when using Gemini adapter');
         process.exit(1);
      }
      modelName = opts.model || process.env.GEMINI_MODEL || 'gemini-2.5-flash';
      console.log(`\n🤖 AI Adapter: Google Gemini`);
      console.log(`  Model:       ${modelName}`);
      aiAdapter = new GeminiAdapter(apiKey);
      aiAdapter.init();
   }

   const gitLocalPath = process.env.GIT_LOCAL_PATH || path.resolve(process.cwd(), './data/okf');
   console.log(`\n📚 Modaka-Hub Encyclopedic Catalog Ingestion`);
   console.log(`  File:        ${opts.pdfPath}`);
   console.log(`  Category:    ${opts.category}`);
   console.log(`  Target Git:  ${gitLocalPath}`);
   if (opts.limit) console.log(`  Limit:       ${opts.limit} entries`);
   if (opts.offset) console.log(`  Offset:      ${opts.offset}`);

   const fileHash = await computeSha256(opts.pdfPath);
   const filename = path.basename(opts.pdfPath);
   const pdfBuffer = await fs.readFile(opts.pdfPath);

   console.log(`\n⏳ Extracting pages from PDF...`);
   const pagesText = await extractPdfPages(pdfBuffer);

   console.log(`✓ Parsed ${pagesText.length} pages.`);

   // --- 1. Introductory Methodology Chapters (p. 8 à 47) ---
   const introChapters: CatalogMonographInput['introChapters'] = [];

   if (!opts.entriesOnly) {
      console.log(`\n📑 Building Introductory Methodology Chapters (pages 8-47)...`);

      // Section 1: Bases de la vie, CAH, pH et rétention (p. 8 à 18)
      const ch1Text = pagesText.slice(7, 18).join('\n\n');
      introChapters.push({
         index: 1,
         title: 'Comprendre les bases de la vie, le CAH et les blocages minéraux',
         slug: '01-comprendre-les-bases-de-la-vie-le-cah-et-les-blocages-mineraux',
         text: ch1Text,
         summary: 'Rôle fondamental du complexe argilo-humique (CAH), aérobiose vs anaérobiose, C/N, capacité de rétention et levées de dormance liées aux blocages du phosphore et de la potasse.',
      });

      // Section 2: Irrigation, climat et méthane (p. 19 à 25)
      const ch2Text = pagesText.slice(18, 25).join('\n\n');
      introChapters.push({
         index: 2,
         title: 'Irrigation, changement climatique et production de méthane',
         slug: '02-irrigation-changement-climatique-et-production-de-methane',
         text: ch2Text,
         summary: 'Analyse agronomique de l irrigation des vignobles, décomposition anaérobie des effluents d élevage et émissions agricoles de gaz à effet de serre.',
      });

      // Section 3: Contradictions apparentes des plantes bio-indicatrices (p. 26 à 31)
      const ch3Text = pagesText.slice(25, 31).join('\n\n');
      introChapters.push({
         index: 3,
         title: 'Contradictions apparentes des plantes bio-indicatrices',
         slug: '03-contradictions-apparentes-des-plantes-bio-indicatrices',
         text: ch3Text,
         summary: 'Résolution des paradoxes agronomiques : chardons du voisin, lamier pourpre sur murets secs, plantes calcicoles sur arènes granitiques et espèces des terrains pollués.',
      });

      // Section 4: Biodiversité, pollinisateurs et Capitulaire de Villis (p. 32 à 49)
      const ch4Text = pagesText.slice(31, 49).join('\n\n');
      introChapters.push({
         index: 4,
         title: 'Biodiversité, abeilles et présentation de la méthode de diagnostic',
         slug: '04-biodiversite-abeilles-et-methode-de-diagnostic',
         text: ch4Text,
         summary: 'Causes de la disparition des pollinisateurs, Capitulaire de Villis et grille d analyse des nouveaux logos couleur écologie et agronomie.',
      });
   }

   // --- 2. Slicing Catalog Entries (Pages 50 à 319) ---
   const allEntries: CatalogEntryChunk[] = [];
   const plantCatalogStartPage = 50;
   const plantCatalogEndPage = Math.min(319, pagesText.length);

   console.log(`\n🌱 Detecting plant fiches from page ${plantCatalogStartPage} to ${plantCatalogEndPage}...`);

   for (let p = plantCatalogStartPage; p <= plantCatalogEndPage; p++) {
      const pageIdx = p - 1;
      const text = pagesText[pageIdx] || '';
      if (text.trim().length < 200) continue;

      // Extract entry title from first lines
      const lines = text.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      const headerSample = text.slice(0, 300);

      // Guess name from text header
      let entryTitle = `Plante Page ${p}`;
      const titleMatch = headerSample.match(/([A-ZÀ-Ÿ][a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)*)\s*(?:\((?:[A-ZÀ-Ÿa-zà-ÿ\s]+)\))?/);
      if (titleMatch && titleMatch[1] && titleMatch[1].length > 3) {
         entryTitle = titleMatch[1];
      }

      const seq = allEntries.length + 1;
      const slug = `${String(seq).padStart(3, '0')}-${slugify(entryTitle)}`;

      allEntries.push({
         sequence: seq,
         rawTitle: entryTitle,
         slug,
         pageRange: `${p}`,
         text: text.trim(),
      });
   }

   console.log(`✓ Detected ${allEntries.length} individual plant entry pages.`);

   // Apply offset & limit
   const offset = opts.offset || 0;
   let entriesToProcess = allEntries.slice(offset);
   if (opts.limit && opts.limit > 0) {
      entriesToProcess = entriesToProcess.slice(0, opts.limit);
   }

   console.log(`👉 Selected ${entriesToProcess.length} entries for processing.`);

   if (opts.dryRun) {
      console.log('\n[Dry Run] Entries detected :');
      for (const e of entriesToProcess.slice(0, 10)) {
         console.log(`  - #${e.sequence} [p.${e.pageRange}] ${e.rawTitle} -> ${e.slug}`);
      }
      if (entriesToProcess.length > 10) {
         console.log(`  ... and ${entriesToProcess.length - 10} more entries.`);
      }
      return;
   }

   // --- 3. Execute Catalog Ingestion ---
   const bookInput: CatalogMonographInput = {
      bookTitle: "L'encyclopédie des plantes bio-indicatrices alimentaires et médicinales - Volume 3",
      description: "Guide de diagnostic des sols par les plantes bio-indicatrices, leurs caractéristiques agronomiques, causes de levée de dormance et propriétés alimentaires et médicinales par Gérard Ducerf.",
      category: opts.category,
      authors: ['Gérard Ducerf'],
      publisher: 'Éditions Promonature',
      publicationYear: '2008',
      edition: 'Volume 3',
      language: 'fr',
      originalLanguage: 'fr',
      tags: ['bio-indication', 'plantes-bio-indicatrices', 'diagnostic-du-sol', 'adventices', 'gerard-ducerf'],
      introChapters: opts.entriesOnly ? undefined : introChapters,
      entries: entriesToProcess,
   };

   const summary = await ingestCatalogMonograph(bookInput, {
      adapter: aiAdapter,
      model: modelName,
      gitLocalPath,
      originalFileUri: `originals/agronomie-livres/${path.basename(opts.pdfPath)}`,
      fileHash,
      filename,
      defaultCategory: opts.category,
      entryType: 'catalog-entry',
      taxonomyProfile: new AgroecologyTaxonomyProfile(),
      targetLanguages: opts.languages,
      onProgress: (current, total, title) => {
         process.stdout.write(`\r  Processing entry ${current}/${total} : ${title.slice(0, 40).padEnd(40)}`);
      },
   });

   console.log(`\n\n🎉 Ingestion Complete!`);
   console.log(`  Master Index:    ${summary.masterIndexPath}`);
   console.log(`  Intro Chapters:  ${summary.totalChapters}`);
   console.log(`  Catalog Entries: ${summary.totalEntries}`);
   console.log(`  Total Files:     ${summary.createdFiles.length}`);
   console.log(`  Tokens:          ${summary.usage.total.toLocaleString()} ($${summary.usage.costUsd} USD)`);
}

main().catch((err) => {
   console.error('\nFatal error:', err);
   process.exit(1);
});
