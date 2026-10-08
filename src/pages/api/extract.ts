import type { APIRoute } from 'astro';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { initBackend } from '../../lib/backend';
import { gitSync } from '../../lib/git-sync';
import { slugify } from '../../lib/utils';
import { Log } from '@quatrain/log';
import { getGitLocalPath, getDefaultSoa } from '../../lib/config';

export interface ExtractRequest {
  userId: string;
  userName?: string;
  soils?: string[];
  climates?: string[];
  latitude?: number;
  altitude?: number;
  itineraries?: string[];
  destinationPath?: string;
}

export const POST: APIRoute = async ({ request }) => {
  await initBackend();
  const body: ExtractRequest = await request.json();

  const sourceRepoPath = getGitLocalPath();
  const targetDestination = body.destinationPath || path.resolve(process.cwd(), `.user-exports/${body.userId}`);

  try {
    Log.info(`[Contextual Extract] Starting extraction for user "${body.userId}" (Target: ${targetDestination})...`);

    const gitStatus = await gitSync.getStatus();
    const currentRev = gitStatus.lastCommit ? `rev-${gitStatus.lastCommit.split(' ')[0]}` : 'rev-1.0.0';
    const soa = getDefaultSoa();

    // 1. Scan source repository
    const sourceContentDir = path.join(sourceRepoPath, 'content');
    const matchedItems: Array<{
      id: string;
      title: string;
      category: string;
      score: number;
      metadata: any;
      body: string;
      sourceFilePath: string;
    }> = [];

    const categories = await fs.readdir(sourceContentDir, { withFileTypes: true });

    for (const catEntry of categories) {
      if (catEntry.isDirectory()) {
        const catSlug = catEntry.name;
        const catDirPath = path.join(sourceContentDir, catSlug);
        const files = await fs.readdir(catDirPath);

        for (const file of files) {
          if (file.endsWith('.md') && file !== 'index.md') {
            const filePath = path.join(catDirPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            let metadata: any = { id: file.replace('.md', ''), category: catSlug };
            let bodyText = content;

            if (content.startsWith('---')) {
              const parts = content.split('---');
              if (parts.length >= 3) {
                try {
                  metadata = { ...metadata, ...parseYaml(parts[1]) };
                  bodyText = parts.slice(2).join('---').trim();
                } catch {}
              }
            }

            // 2. Score relevance based on multi-axial criteria
            let score = 10; // Baseline relevance

            const itemSoils: string[] = metadata.soils || [];
            const itemClimates: string[] = metadata.climates || [];
            const itemItineraries: string[] = metadata.itineraries || [];
            const itemCrops: string[] = metadata.crops || [];

            if (body.soils && body.soils.length > 0) {
              const soilOverlap = body.soils.some(s => itemSoils.includes(s) || content.toLowerCase().includes(s.toLowerCase()));
              if (soilOverlap) score += 25;
            }

            if (body.climates && body.climates.length > 0) {
              const climateOverlap = body.climates.some(c => itemClimates.includes(c) || content.toLowerCase().includes(c.toLowerCase()));
              if (climateOverlap) score += 25;
            }

            if (body.itineraries && body.itineraries.length > 0) {
              const itiOverlap = body.itineraries.some(it => itemItineraries.includes(it) || content.toLowerCase().includes(it.toLowerCase()));
              if (itiOverlap) score += 30;
            }

            if (body.crops && body.crops.length > 0) {
              const cropOverlap = body.crops.some(cr => itemCrops.includes(cr) || content.toLowerCase().includes(cr.toLowerCase()));
              if (cropOverlap) score += 30;
            }

            matchedItems.push({
              id: metadata.id || file.replace('.md', ''),
              title: metadata.title || file.replace('.md', ''),
              category: catSlug,
              score,
              metadata,
              body: bodyText,
              sourceFilePath: filePath
            });
          }
        }
      }
    }

    // Sort by relevance score descending
    matchedItems.sort((a, b) => b.score - a.score);

    // 3. Generate destination OKF directory tree
    const targetContentDir = path.join(targetDestination, 'content');
    const targetAssetsDir = path.join(targetDestination, 'assets', 'documents');
    await fs.mkdir(targetContentDir, { recursive: true });
    await fs.mkdir(targetAssetsDir, { recursive: true });

    const exportedCategories = new Set<string>();

    for (const item of matchedItems) {
      const catTargetDir = path.join(targetContentDir, item.category);
      await fs.mkdir(catTargetDir, { recursive: true });
      exportedCategories.add(item.category);

      // Copy referenced asset if present
      if (item.metadata.originalFileUri) {
        const sourceAssetPath = path.join(sourceRepoPath, item.metadata.originalFileUri);
        if (fsSync.existsSync(sourceAssetPath)) {
          const fileName = path.basename(item.metadata.originalFileUri);
          const targetAssetPath = path.join(targetAssetsDir, fileName);
          await fs.copyFile(sourceAssetPath, targetAssetPath);
        }
      }

      // Prepare updated OKF frontmatter with verified SOA and revision
      const finalMetadata = {
        ...item.metadata,
        soa,
        revision: item.metadata.revision || currentRev,
        extractedFor: body.userId,
        extractedAt: new Date().toISOString()
      };

      const finalMarkdown = `---\n${stringifyYaml(finalMetadata)}---\n\n${item.body}\n`;
      const targetDocPath = path.join(catTargetDir, `${item.id}.md`);
      await fs.writeFile(targetDocPath, finalMarkdown, 'utf-8');
    }

    // 4. Generate OKF category and root index files
    for (const catSlug of exportedCategories) {
      const catIndexContent = `# ${catSlug.replace(/-/g, ' ').toUpperCase()}\n\nCatégorie agronomique extraite pour ${body.userName || body.userId}.\n`;
      await fs.writeFile(path.join(targetContentDir, catSlug, 'index.md'), catIndexContent, 'utf-8');
    }

    const rootIndexContent = `# Base Agronomique Personnalisée — ${body.userName || body.userId}\n\n` +
      `> **Source d'Autorité (SOA)** : \`${soa}\` (Révision : \`${currentRev}\`)\n` +
      `> **Généré pour** : ${body.userName || body.userId} (${body.userId})\n\n` +
      `## Catégories\n\n` +
      Array.from(exportedCategories).map(cat => `* [${cat}](content/${cat}/index.md)`).join('\n') + '\n';

    await fs.writeFile(path.join(targetDestination, 'index.md'), rootIndexContent, 'utf-8');

    Log.info(`[Contextual Extract] Successfully exported ${matchedItems.length} documents to ${targetDestination}`);

    return new Response(JSON.stringify({
      success: true,
      soa,
      revision: currentRev,
      extractedCount: matchedItems.length,
      destinationPath: targetDestination,
      categories: Array.from(exportedCategories),
      items: matchedItems.map(m => ({ id: m.id, title: m.title, category: m.category, score: m.score }))
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    Log.error(`[Contextual Extract] Failed extraction: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
