import { promises as fs } from 'fs';
import * as path from 'path';

const TEMP_ROOT = path.join(process.cwd(), 'temp_files_dir');

/**
 * Creates a unique workspace-confined temporary directory.
 */
export async function createTempDir(prefix: string): Promise<string> {
  // Ensure the root temp folder exists inside the workspace
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const uniqueSubdir = `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  const tempDirPath = path.join(TEMP_ROOT, uniqueSubdir);
  await fs.mkdir(tempDirPath, { recursive: true });
  return tempDirPath;
}

/**
 * Clean up a temporary directory recursively, safeguarding against accidental out-of-bounds deletions.
 */
export async function cleanupTempDir(dirPath: string): Promise<void> {
  try {
    // Safety check: ensure we only delete within TEMP_ROOT
    const resolvedPath = path.resolve(dirPath);
    const resolvedRoot = path.resolve(TEMP_ROOT);

    if (resolvedPath.startsWith(resolvedRoot) && resolvedPath !== resolvedRoot) {
      await fs.rm(resolvedPath, { recursive: true, force: true });
    }
  } catch (err) {
    // Suppress deletion failures to avoid breaking primary business flow but log
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TempFiles] Failed to clean up temp directory ${dirPath}: ${errMsg}`);
  }
}
