import type { APIRoute } from 'astro';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getGitLocalPath, loadHubConfig } from '../../../lib/config';

function maskKey(val?: string): string {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return `${val.substring(0, 4)}••••••••${val.substring(val.length - 4)}`;
}

export const GET: APIRoute = async ({ locals }) => {
  const userRoles = locals.user?.roles || [];
  const isAdmin = userRoles.includes('admin') || userRoles.includes('admin-brad');

  if (!isAdmin) {
    return new Response(
      JSON.stringify({ error: 'Forbidden', message: 'Admin role required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const hubConfig = loadHubConfig();
  const gitLocalPath = getGitLocalPath();

  const config = {
    llm: {
      provider: process.env.LLM_PROVIDER || hubConfig.aiProvider || 'gemini',
      model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
      apiKey: maskKey(process.env.GEMINI_API_KEY),
      hasApiKey: Boolean(process.env.GEMINI_API_KEY)
    },
    storage: {
      type: process.env.STORAGE_TYPE || hubConfig.storageType || 'local',
      documentStoragePath:
        process.env.DOCUMENT_STORAGE_PATH ||
        hubConfig.documentStoragePath ||
        path.join(gitLocalPath, 'assets'),
      s3Bucket: process.env.S3_BUCKET || 'documents',
      s3Region: process.env.S3_REGION || 'us-east-1',
      s3Endpoint: process.env.S3_ENDPOINT || '',
      s3AccessKey: maskKey(process.env.S3_ACCESS_KEY),
      hasSecretKey: Boolean(process.env.S3_SECRET_KEY)
    },
    git: {
      localPath: gitLocalPath,
      repoOwner: process.env.GIT_REPO_OWNER || hubConfig.gitRepoOwner || 'Quatrain',
      repoName: process.env.GIT_REPO_NAME || hubConfig.gitRepoName || 'knowledge',
      branch: process.env.GIT_BRANCH || hubConfig.gitBranch || 'develop',
      mode: process.env.GIT_MODE || hubConfig.gitMode || 'local'
    },
    auth: {
      supabaseUrl: process.env.PUBLIC_SUPABASE_URL || 'https://qthlhrtxnuzibnzimoao.supabase.co',
      allowedDomain: process.env.ALLOWED_EMAIL_DOMAINS || (hubConfig.allowedEmailDomains || ['*']).join(', ')
    }
  };

  return new Response(JSON.stringify(config), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const userRoles = locals.user?.roles || [];
  const isAdmin = userRoles.includes('admin') || userRoles.includes('admin-brad');

  if (!isAdmin) {
    return new Response(
      JSON.stringify({ error: 'Forbidden', message: 'Admin role required' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const updates = await request.json();

    // Update in-memory process.env if new plain values are supplied
    if (updates.llm?.model) process.env.GEMINI_MODEL = updates.llm.model;
    if (updates.llm?.apiKey && !updates.llm.apiKey.includes('••••')) {
      process.env.GEMINI_API_KEY = updates.llm.apiKey;
    }

    if (updates.storage?.type) process.env.STORAGE_TYPE = updates.storage.type;
    if (updates.storage?.documentStoragePath) process.env.DOCUMENT_STORAGE_PATH = updates.storage.documentStoragePath;
    if (updates.storage?.s3Bucket) process.env.S3_BUCKET = updates.storage.s3Bucket;
    if (updates.storage?.s3Region) process.env.S3_REGION = updates.storage.s3Region;
    if (updates.storage?.s3Endpoint) process.env.S3_ENDPOINT = updates.storage.s3Endpoint;
    if (updates.storage?.s3AccessKey && !updates.storage.s3AccessKey.includes('••••')) {
      process.env.S3_ACCESS_KEY = updates.storage.s3AccessKey;
    }
    if (updates.storage?.s3SecretKey && !updates.storage.s3SecretKey.includes('••••')) {
      process.env.S3_SECRET_KEY = updates.storage.s3SecretKey;
    }

    if (updates.git?.localPath) process.env.GIT_LOCAL_PATH = updates.git.localPath;
    if (updates.git?.branch) process.env.GIT_BRANCH = updates.git.branch;

    // Persist to user settings file
    const settingsPath = path.resolve(process.cwd(), 'src/config/admin_settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(
      settingsPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          updatedBy: locals.user?.email,
          ...updates
        },
        null,
        2
      )
    );

    return new Response(JSON.stringify({ success: true, message: 'Settings saved' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
