import * as path from 'node:path';
import * as fs from 'node:fs';

export interface ModakaHubConfig {
  appTitle?: string;
  appSubtitle?: string;
  badgeLabel?: string;
  soa?: string;
  gitLocalPath?: string;
  gitRepoOwner?: string;
  gitRepoName?: string;
  gitBranch?: string;
  gitMode?: string;
  storageType?: string;
  documentStoragePath?: string;
  aiProvider?: string;
  allowedEmailDomains?: string[];
  axes?: Array<{
    id: string;
    label: string;
    folder?: string;
    color?: string;
    description?: string;
  }>;
}

let cachedConfig: ModakaHubConfig | null = null;

export function loadHubConfig(): ModakaHubConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  const rootConfigPath = path.resolve(process.cwd(), 'modaka-hub.config.json');
  let config: ModakaHubConfig = {};

  try {
    if (fs.existsSync(rootConfigPath)) {
      const raw = fs.readFileSync(rootConfigPath, 'utf-8');
      config = JSON.parse(raw);
    }
  } catch (err: any) {
    console.warn(`[Config] Failed to load modaka-hub.config.json: ${err.message}`);
  }

  cachedConfig = config;
  return config;
}

export function getGitLocalPath(): string {
  const config = loadHubConfig();
  if (process.env.GIT_LOCAL_PATH) {
    return process.env.GIT_LOCAL_PATH;
  }
  if (config.gitLocalPath) {
    return path.isAbsolute(config.gitLocalPath)
      ? config.gitLocalPath
      : path.resolve(process.cwd(), config.gitLocalPath);
  }
  return path.resolve(process.cwd(), './data/okf');
}

export function getDefaultSoa(): string {
  const config = loadHubConfig();
  return process.env.DEFAULT_SOA || config.soa || 'modaka/authority';
}

export function getAllowedEmailDomains(): string[] {
  const config = loadHubConfig();
  const envVal = import.meta.env?.ALLOWED_EMAIL_DOMAINS || process.env.ALLOWED_EMAIL_DOMAINS;
  if (envVal) {
    return envVal.split(',').map((d: string) => d.trim()).filter(Boolean);
  }
  return config.allowedEmailDomains || ['*'];
}

export function isEmailDomainAllowed(email: string): boolean {
  const allowed = getAllowedEmailDomains();
  if (allowed.includes('*') || allowed.includes('@*')) {
    return true;
  }
  const lower = email.toLowerCase().trim();
  return allowed.some(domain => {
    const d = domain.toLowerCase().trim();
    if (d.startsWith('@')) {
      return lower.endsWith(d);
    }
    return lower.endsWith(`@${d}`) || lower.endsWith(d);
  });
}
