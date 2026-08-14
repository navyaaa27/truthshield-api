import fs from 'fs/promises';
import * as path from 'path';
import { query } from '../../shared/database/pool.js';
import { PHashService } from '../detection/stolen-content/phash.service.js';
import { S3Service } from '../../shared/storage/s3.service.js';
import { createTempDir, cleanupTempDir } from '../../utils/tempFiles.js';
import { logger } from '../../utils/logger.js';

export class AssetIndexer {
  private pHashService = new PHashService();

  /**
   * Registers a newly uploaded confirmed asset in the brand_assets table,
   * computes its visual fingerprint (pHash), and caches it in the fast lookup index.
   */
  async indexUploadedAsset(
    orgId: string,
    userId: string,
    s3Key: string,
    assetName: string,
    assetType: string,
  ): Promise<any> {
    // 1. Insert base asset into the database
    const dbInsert = await query(
      `INSERT INTO brand_assets (org_id, created_by, name, file_path, status)
       VALUES ($1, $2, $3, $4, 'active')
       RETURNING *`,
      [orgId, userId, assetName, s3Key],
    );
    const asset = dbInsert.rows[0];

    const isVisual = assetType.toLowerCase() === 'image' || assetType.toLowerCase() === 'video';
    if (!isVisual) {
      return asset;
    }

    const tempDir = await createTempDir('indexing');
    const filePath = path.join(tempDir, path.basename(s3Key));

    try {
      // 2. Download visual file from storage
      const downloadUrl = await S3Service.getPresignedDownloadUrl(s3Key);
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download visual asset for indexing: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);
      await fs.writeFile(filePath, fileBuffer);

      // 3. Compute visual fingerprint (pHash)
      const hashResult = await this.pHashService.computeHash(filePath, assetType as any);

      // 4. Update the DB and populate Redis fast lookup index
      await this.pHashService.storeHashInIndex(asset.id, orgId, hashResult.hash);

      const finalAsset = await query(`SELECT * FROM brand_assets WHERE id = $1`, [asset.id]);

      await cleanupTempDir(tempDir).catch(() => {});
      return finalAsset.rows[0];
    } catch (err: any) {
      logger.error(`Failed to compute pHash visual signature for asset indexing: ${err.message}`);
      await cleanupTempDir(tempDir).catch(() => {});
      return asset;
    }
  }
}
