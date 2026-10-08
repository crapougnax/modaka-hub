import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import { Log } from '@quatrain/log';
import { getGitLocalPath } from './config';

const execPromise = promisify(exec);

export interface GitStatusResult {
  branch: string;
  isClean: boolean;
  uncommittedFiles: string[];
  lastCommit?: string;
  repoPath: string;
}

export class GitSyncService {
  protected repoPath: string;

  constructor(repoPath?: string) {
    this.repoPath = repoPath || getGitLocalPath();
  }

  public async getStatus(): Promise<GitStatusResult> {
    try {
      const { stdout: branchOut } = await execPromise('git branch --show-current', { cwd: this.repoPath });
      const branch = branchOut.trim() || 'unknown';

      const { stdout: statusOut } = await execPromise('git status --porcelain', { cwd: this.repoPath });
      const lines = statusOut.trim().split('\n').filter(Boolean);
      const uncommittedFiles = lines.map(l => l.trim());

      let lastCommit: string | undefined;
      try {
        const { stdout: logOut } = await execPromise('git log -1 --pretty=format:"%h - %s (%cd)" --date=relative', { cwd: this.repoPath });
        lastCommit = logOut.trim();
      } catch {}

      return {
        branch,
        isClean: uncommittedFiles.length === 0,
        uncommittedFiles,
        lastCommit,
        repoPath: this.repoPath
      };
    } catch (err: any) {
      Log.warn(`[GitSync] Failed to inspect git status: ${err.message}`);
      return {
        branch: 'error',
        isClean: true,
        uncommittedFiles: [],
        repoPath: this.repoPath
      };
    }
  }

  public async stageAndCommit(message: string, filePaths: string[] = []): Promise<boolean> {
    try {
      if (filePaths.length > 0) {
        for (const file of filePaths) {
          await execPromise(`git add "${file}"`, { cwd: this.repoPath });
        }
      } else {
        await execPromise('git add -A', { cwd: this.repoPath });
      }

      const escapedMessage = message.replace(/"/g, '\\"');
      await execPromise(`git commit -m "${escapedMessage}"`, { cwd: this.repoPath });
      Log.info(`[GitSync] Committed changes with message: "${message}"`);
      return true;
    } catch (err: any) {
      Log.warn(`[GitSync] Commit skipped or failed: ${err.message}`);
      return false;
    }
  }

  public async push(): Promise<boolean> {
    try {
      const { stdout: branchOut } = await execPromise('git branch --show-current', { cwd: this.repoPath });
      const branch = branchOut.trim();
      await execPromise(`git push origin ${branch}`, { cwd: this.repoPath });
      Log.info(`[GitSync] Pushed branch ${branch} to origin`);
      return true;
    } catch (err: any) {
      Log.warn(`[GitSync] Push failed: ${err.message}`);
      return false;
    }
  }
}

export const gitSync = new GitSyncService();
