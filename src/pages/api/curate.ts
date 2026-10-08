import type { APIRoute } from 'astro';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ObjectUri } from '@quatrain/types';
import { initBackend } from '../../lib/backend';
import { ContentItem } from '../../lib/models/ContentItem';
import { gitSync } from '../../lib/git-sync';
import { slugify } from '../../lib/utils';
import { getGitLocalPath, getDefaultSoa } from '../../lib/config';

export const GET: APIRoute = async ({ url }) => {
  await initBackend();
  const gitLocalPath = getGitLocalPath();
  const contentDir = path.join(gitLocalPath, 'content');
  const targetCategory = url.searchParams.get('category');
  const soilFilter = url.searchParams.get('soil');
  const climateFilter = url.searchParams.get('climate');
  const itineraryFilter = url.searchParams.get('itinerary');
  const cropFilter = url.searchParams.get('crop');

  try {
    const items = [];
    const categories = await fs.readdir(contentDir, { withFileTypes: true });

    for (const catEntry of categories) {
      if (catEntry.isDirectory()) {
        const catSlug = catEntry.name;
        if (targetCategory && targetCategory !== 'all' && targetCategory !== catSlug) {
          continue;
        }

        const catDirPath = path.join(contentDir, catSlug);
        const files = await fs.readdir(catDirPath);

        for (const file of files) {
          if (file.endsWith('.md') && file !== 'index.md') {
            const filePath = path.join(catDirPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            let metadata: any = { id: file.replace('.md', ''), category: catSlug };
            let body = content;

            if (content.startsWith('---')) {
              const parts = content.split('---');
              if (parts.length >= 3) {
                try {
                  metadata = { ...metadata, ...parseYaml(parts[1]) };
                  body = parts.slice(2).join('---').trim();
                } catch {}
              }
            }

            // Dynamic axis query parameters matching
            let matches = true;
            for (const [paramKey, paramVal] of url.searchParams.entries()) {
              if (paramKey === 'category' || !paramVal) continue;
              
              const singularKey = paramKey.endsWith('s') ? paramKey.slice(0, -1) : paramKey;
              const pluralKey = paramKey.endsWith('s') ? paramKey : `${paramKey}s`;
              
              const itemVals = metadata[pluralKey] || metadata[singularKey] || metadata.axes?.[pluralKey] || metadata.axes?.[singularKey] || [];
              if (!Array.isArray(itemVals) || !itemVals.includes(paramVal)) {
                matches = false;
                break;
              }
            }
            if (!matches) continue;

            items.push({
              soa: metadata.soa || getDefaultSoa(),
              revision: metadata.revision || 'rev-1.0.0',
              ...metadata,
              id: metadata.id || file.replace('.md', ''),
              category: catSlug,
              body
            });
          }
        }
      }
    }

    return new Response(JSON.stringify({ items }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request, locals }) => {
  await initBackend();
  const rawBody = await request.json();
  const sanitized = locals.rbac ? (locals.rbac.sanitizeWrite('document', rawBody) as any) : rawBody;
  // Merge sanitized fields with raw body to retain unconfigured fields while enforcing FLS
  const body = { ...rawBody, ...sanitized };
  const rawId = body.id || slugify(body.title || 'document');
  const id = slugify(rawId);
  const category = body.category || 'soil-health';

  if (!id) {
    return new Response(JSON.stringify({ error: 'Document ID is required' }), { status: 400 });
  }

  try {
    const gitStatus = await gitSync.getStatus();
    const currentRev = gitStatus.lastCommit ? `rev-${gitStatus.lastCommit.split(' ')[0]}` : 'rev-1.0.0';
    // If soa or revision were stripped by FLS for non-admin, fallback to canonical values
    const soa = (sanitized.soa) || getDefaultSoa();
    const revision = (sanitized.revision) || currentRev;

    const contentItem = await ContentItem.factory({
      id,
      title: body.title,
      type: body.type || 'document',
      category,
      tags: body.tags || [],
      thematics: body.thematics || [category],
      soils: body.soils || [],
      climates: body.climates || [],
      latitudes: body.latitudes || [],
      altitudes: body.altitudes || [],
      itineraries: body.itineraries || [],
      crops: body.crops || [],
      soa,
      revision,
      properNouns: body.properNouns || [],
      summary: body.description || body.summary,
      description: body.description || body.summary,
      source: body.source,
      documentDate: body.documentDate,
      originalFileUri: body.originalFileUri,
      fileHash: body.fileHash,
      // Bibliographic & Intellectual Property References
      authors: body.authors || [],
      translators: body.translators || [],
      publisher: body.publisher,
      edition: body.edition,
      publicationYear: body.publicationYear,
      language: body.language || 'fr',
      isbn: body.isbn,
      doi: body.doi,
      license: body.license,
      copyright: body.copyright,
      originalTitle: body.originalTitle,
      originalLanguage: body.originalLanguage,
      originalPublisher: body.originalPublisher,
      originalYear: body.originalYear,
      originalCopyright: body.originalCopyright,
      citation: body.citation,
      body: body.body || '',
      createdAt: body.timestamp || new Date().toISOString()
    });

    const categoryDir = path.join(gitLocalPath, 'content', category);
    await fs.mkdir(categoryDir, { recursive: true });

    contentItem.dataObject.uri = new ObjectUri(`content/${id}`);
    await contentItem.save();

    await gitSync.stageAndCommit(
      `feat(curation): curate document "${body.title || id}" in ${category} [SOA: ${soa}]`,
      [path.join('content', category, `${id}.md`)]
    );

    return new Response(JSON.stringify({ success: true, item: { ...body, id, soa, revision } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
