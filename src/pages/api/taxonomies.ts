import type { APIRoute } from 'astro';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { initBackend } from '../../lib/backend';
import { slugify } from '../../lib/utils';
import { gitSync } from '../../lib/git-sync';
import { getGitLocalPath, getDefaultSoa, loadHubConfig } from '../../lib/config';

export const GET: APIRoute = async () => {
  await initBackend();
  const gitLocalPath = getGitLocalPath();
  const contentDir = path.join(gitLocalPath, 'content');
  const configPath = path.join(gitLocalPath, 'modaka-hub.config.json');

  try {
    await fs.mkdir(contentDir, { recursive: true });

    let config: any = loadHubConfig();
    if (!config.axes || config.axes.length === 0) {
      config = {
        ...config,
        soa: getDefaultSoa(),
        name: config.appTitle || 'Modaka Authority',
        axes: [
          { id: 'soils', label: 'Sols & Typologies Pédologiques', folder: 'soils', color: 'amber' },
          { id: 'climates', label: 'Climats & Zones Agro-Climatiques', folder: 'climates', color: 'cyan' },
          { id: 'crops', label: 'Productions Végétales & Filières', folder: 'crops', color: 'lime' },
          { id: 'itineraries', label: 'Itinéraires Techniques & Pratiques', folder: 'itineraries', color: 'green' }
        ]
      };
    }

    try {
      const configRaw = await fs.readFile(configPath, 'utf-8');
      config = { ...config, ...JSON.parse(configRaw) };
    } catch {}

    const axesResult: any[] = [];
    const thematics: any[] = [];

    // Scan each configured axis
    for (const axis of config.axes || []) {
      const axisFolder = axis.folder || axis.id;
      const axisDirPath = path.join(contentDir, axisFolder);
      await fs.mkdir(axisDirPath, { recursive: true });

      const files = await fs.readdir(axisDirPath);
      const items: any[] = [];

      for (const file of files) {
        if (file.endsWith('.md') && file !== 'index.md') {
          const filePath = path.join(axisDirPath, file);
          const raw = await fs.readFile(filePath, 'utf-8');
          let meta: any = { id: file.replace('.md', ''), title: file.replace('.md', '') };

          if (raw.startsWith('---')) {
            const parts = raw.split('---');
            if (parts.length >= 3) {
              try {
                meta = { ...meta, ...parseYaml(parts[1]) };
              } catch {}
            }
          }

          items.push({
            id: meta.id || file.replace('.md', ''),
            slug: file.replace('.md', ''),
            label: meta.title || file.replace('.md', ''),
            title: meta.title || file.replace('.md', ''),
            description: meta.description || '',
            tags: meta.tags || [],
            path: path.join('content', axisFolder, file)
          });
        }
      }

      const axisData = {
        id: axis.id,
        label: axis.label || axis.id,
        folder: axisFolder,
        color: axis.color || 'blue',
        icon: axis.icon,
        description: axis.description || '',
        count: items.length,
        items
      };

      axesResult.push(axisData);
      thematics.push({
        id: axis.id,
        label: axis.label || axis.id,
        description: axis.description || '',
        color: axis.color,
        count: items.length,
        items
      });
    }

    return new Response(JSON.stringify({
      soa: config.soa || getDefaultSoa(),
      config,
      axes: axesResult,
      thematics
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};

export const POST: APIRoute = async ({ request }) => {
  await initBackend();
  const gitLocalPath = getGitLocalPath();
  const body = await request.json();
  const label = body.label?.trim();
  const description = body.description?.trim() || '';

  if (!label) {
    return new Response(JSON.stringify({ error: 'Label is required' }), { status: 400 });
  }

  const slug = slugify(label);
  const thematicDir = path.join(gitLocalPath, 'content', slug);

  try {
    await fs.mkdir(thematicDir, { recursive: true });
    const indexPath = path.join(thematicDir, 'index.md');

    const indexContent = `---
type: category
title: "${label.replace(/"/g, '\\"')}"
description: "${description.replace(/"/g, '\\"')}"
tags:
  - ${slug}
  - agronomy
timestamp: "${new Date().toISOString()}"
---

# ${label}

${description || `Référentiel thématique pour ${label}.`}
`;

    await fs.writeFile(indexPath, indexContent, 'utf-8');
    await gitSync.stageAndCommit(`feat(thematic): create thematic category "${label}"`, [
      path.join('content', slug, 'index.md')
    ]);

    return new Response(JSON.stringify({ success: true, thematic: { id: slug, label, description, count: 0 } }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
