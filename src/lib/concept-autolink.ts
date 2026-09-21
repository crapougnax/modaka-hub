import { ContentItem } from './models/ContentItem';
import { Storage } from '@quatrain/storage';
import { Log } from '@quatrain/log';
import { ApiClient } from '@quatrain/api-client';
import { Readable } from 'node:stream';
import { slugify } from './utils';

const wikiFrClient = new ApiClient('https://fr.wikipedia.org/api/rest_v1', 'wiki-fr');
const wikiEnClient = new ApiClient('https://en.wikipedia.org/api/rest_v1', 'wiki-en');

/**
 * Searches Wikipedia for a given proper noun / botanical concept and creates a Concept OKF document
 * if it does not already exist in the target knowledge base.
 */
export async function searchAndCreateConcept(properNoun: string): Promise<void> {
   const slug = slugify(properNoun);
   if (!slug) return;

   try {
      const existing = await ContentItem.factory();
      existing.uri.uid = slug;
      await existing.read();
      Log.info(`[Concept Auto-Link] Concept "${properNoun}" already exists as document "${slug}". Skipping.`);
      return;
   } catch {
      // Concept doesn't exist, proceed
   }

   Log.info(`[Concept Auto-Link] Searching Wikipedia for concept "${properNoun}"...`);
   try {
      const pageSlug = encodeURIComponent(properNoun.replace(/ /g, '_'));
      const headers = { 'User-Agent': 'ModakaHubCurationAgent/1.0 (contact: developers@quatrain.com)' };

      let data: any = null;
      try {
         const res = await wikiFrClient.get(`/page/summary/${pageSlug}`, { headers });
         data = res.data;
      } catch {
         try {
            const res = await wikiEnClient.get(`/page/summary/${pageSlug}`, { headers });
            data = res.data;
         } catch {
            data = null;
         }
      }

      if (data && data.type === 'standard' && data.extract) {
         Log.info(`[Concept Auto-Link] Found Wikipedia entry for "${properNoun}". Creating OKF concept sheet.`);

         const summary = data.description || `Page Wikipédia de ${data.title}`;
         const body = `${data.extract}\n\n---\n*Source : [Wikipedia - ${data.title}](${data.content_urls.desktop.page})*`;

         const conceptItem = await ContentItem.factory({
            id: slug,
            title: data.title,
            type: 'concept',
            category: 'concepts',
            tags: ['wikipedia', 'concepts', slug],
            summary: summary,
            description: summary,
            body: body,
            originalFileUri: data.content_urls.desktop.page,
            createdAt: new Date().toISOString()
         });

         await conceptItem.save();
         Log.info(`[Concept Auto-Link] Successfully persisted concept document for "${data.title}"`);
      }
   } catch (err: any) {
      Log.warn(`[Concept Auto-Link] Error creating concept for "${properNoun}": ${err.message}`);
   }
}
