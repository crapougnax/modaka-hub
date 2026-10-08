import type { APIRoute } from 'astro';
import { gitSync } from '../../../lib/git-sync';

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const message = body.message || 'feat(curation): sync curated knowledge base';
    const doPush = Boolean(body.push);

    // Git push to remote authority repository is restricted to administrators
    if (doPush) {
      const userRoles = locals.user?.roles || [];
      const isAdmin = userRoles.includes('admin') || userRoles.includes('admin-brad');

      if (!isAdmin) {
        return new Response(
          JSON.stringify({
            error: 'Forbidden',
            message: 'Pushing to remote authority repository requires administrator role.'
          }),
          { status: 403, headers: { 'Content-Type': 'application/json' } }
        );
      }
    }

    const committed = await gitSync.stageAndCommit(message);
    let pushed = false;
    if (doPush) {
      pushed = await gitSync.push();
    }

    const status = await gitSync.getStatus();
    return new Response(JSON.stringify({ success: committed, pushed, status }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
