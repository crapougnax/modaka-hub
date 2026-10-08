import type { APIRoute } from 'astro';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { initBackend } from '../../lib/backend';
import { Log } from '@quatrain/log';
import { getGitLocalPath, getDefaultSoa } from '../../lib/config';

export const GET: APIRoute = async () => {
  await initBackend();
  const gitLocalPath = getGitLocalPath();
  const telemetryDir = path.join(gitLocalPath, 'telemetry');

  try {
    const documentStats: Record<string, {
      documentUid: string;
      soa: string;
      revision: string;
      totalUsages: number;
      helpfulVotes: number;
      unhelpfulVotes: number;
      keywords: string[];
    }> = {};

    let totalInteractions = 0;

    if (fsSync.existsSync(telemetryDir)) {
      const dates = await fs.readdir(telemetryDir, { withFileTypes: true });

      for (const d of dates) {
        if (d.isDirectory()) {
          const usageDir = path.join(telemetryDir, d.name, 'usage');
          if (fsSync.existsSync(usageDir)) {
            const files = await fs.readdir(usageDir);
            for (const file of files) {
              if (file.endsWith('.json')) {
                try {
                  const content = await fs.readFile(path.join(usageDir, file), 'utf-8');
                  const data = JSON.parse(content);
                  const items = Array.isArray(data.telemetryBatch) ? data.telemetryBatch : [data];

                  for (const entry of items) {
                    const uid = entry.documentUid || 'unknown';
                    if (!documentStats[uid]) {
                      documentStats[uid] = {
                        documentUid: uid,
                        soa: entry.soa || getDefaultSoa(),
                        revision: entry.revision || 'rev-1.0.0',
                        totalUsages: 0,
                        helpfulVotes: 0,
                        unhelpfulVotes: 0,
                        keywords: []
                      };
                    }

                    documentStats[uid].totalUsages += (entry.usageCount || 1);
                    documentStats[uid].helpfulVotes += (entry.helpfulVotes || 0);
                    documentStats[uid].unhelpfulVotes += (entry.unhelpfulVotes || 0);
                    totalInteractions += (entry.usageCount || 1);

                    if (Array.isArray(entry.contextKeywords)) {
                      documentStats[uid].keywords = Array.from(new Set([...documentStats[uid].keywords, ...entry.contextKeywords]));
                    }
                  }
                } catch {}
              }
            }
          }
        }
      }
    }

    const sortedStats = Object.values(documentStats).sort((a, b) => b.totalUsages - a.totalUsages);

    return new Response(JSON.stringify({
      totalInteractions,
      recordedDocuments: sortedStats.length,
      stats: sortedStats
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

  try {
    const payload = await request.json();
    const batch = Array.isArray(payload.telemetryBatch) ? payload.telemetryBatch : [payload];

    const today = new Date().toISOString().split('T')[0];
    const telemetryDir = path.join(gitLocalPath, 'telemetry', today, 'usage');
    await fs.mkdir(telemetryDir, { recursive: true });

    const reportId = crypto.randomUUID();
    const filePath = path.join(telemetryDir, `${Date.now()}-${reportId}.json`);

    const record = {
      type: 'telemetry',
      category: 'usage',
      clientVersion: payload.clientVersion || 'modaka-client-v1.0.0',
      timestamp: new Date().toISOString(),
      telemetryBatch: batch
    };

    await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
    Log.info(`[Telemetry] Stored anonymized usage report at ${filePath}`);

    return new Response(JSON.stringify({ success: true, count: batch.length, reportId }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    Log.error(`[Telemetry] Ingestion error: ${err.message}`);
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
