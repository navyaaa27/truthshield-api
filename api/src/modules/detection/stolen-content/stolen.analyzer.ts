import fs from 'fs/promises';
import * as path from 'path';
import { query } from '../../../shared/database/pool.js';
import { S3Service } from '../../../shared/storage/s3.service.js';
import { createTempDir, cleanupTempDir } from '../../../utils/tempFiles.js';
import { PHashService } from './phash.service.js';
import { ContentSearcher } from './content.searcher.js';
import { DMCAGenerator } from './dmca.generator.js';
import { StolenContentResult, DMCADraft } from './stolen.types.js';
import { logger } from '../../../utils/logger.js';

export class StolenContentAnalyzer {
  private pHashService = new PHashService();
  private searcher = new ContentSearcher();
  private dmcaGenerator = new DMCAGenerator();

  /**
   * Evaluates if a media asset (image or video) has been duplicated or stolen.
   */
  async analyze(job: any): Promise<StolenContentResult> {
    const s3Key = job.s3_key;
    const orgId = job.org_id;
    const contentType = job.content_type;

    if (!s3Key) {
      throw new Error(
        `Job ${job.id} does not contain a valid s3_key required for stolen content checks.`,
      );
    }

    const tempDir = await createTempDir('stolen-analysis');
    const filePath = path.join(tempDir, path.basename(s3Key));

    try {
      // 1. Download file from S3 using pre-signed GET URL
      logger.info(`[StolenContent] Fetching file from S3: ${s3Key}`);
      const downloadUrl = await S3Service.getPresignedDownloadUrl(s3Key);

      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download file from S3: ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);
      await fs.writeFile(filePath, fileBuffer);

      // 2. Compute visual perceptual hash
      const hashResult = await this.pHashService.computeHash(filePath, contentType as any);

      // 3. Perform catalog and reverse image searches
      const webMatches = await this.searcher.searchForContent(hashResult, orgId, s3Key);

      // Resolve brand asset DB matches separately for detailed mapping
      const brandAssetMatches = await this.pHashService.findSimilarInDatabase(
        orgId,
        hashResult.hash,
        60,
      );

      const exactMatches = brandAssetMatches.filter((m) => m.matchType === 'exact');
      const nearMatches = brandAssetMatches.filter((m) => m.matchType === 'near_duplicate');

      // 4. Calculate final forensic score
      let score = 5; // Default score if no matches are found
      if (exactMatches.length > 1) {
        score = 100;
      } else if (exactMatches.length === 1) {
        score = 95;
      } else if (nearMatches.length > 0) {
        score = 75;
      } else {
        const highWebMatch = webMatches.find((m) => m.similarity > 80);
        const medWebMatch = webMatches.find((m) => m.similarity > 60);
        if (highWebMatch) {
          score = 65;
        } else if (medWebMatch) {
          score = 45;
        }
      }

      // Calculate confidence index
      let confidence = 60; // Base if hash is computed successfully
      confidence += 15; // Web search completed (+15)
      confidence += 15; // DB brand catalogs checked (+15)

      if (exactMatches.length > 0) {
        confidence = 95;
      } else if (exactMatches.length === 0 && nearMatches.length === 0 && webMatches.length === 0) {
        confidence = 50;
      }

      // Map Verdict
      let verdict = 'clean';
      if (score >= 95) {
        verdict = 'stolen';
      } else if (score >= 75) {
        verdict = 'manipulated';
      } else if (score >= 45) {
        verdict = 'suspicious';
      }

      // 5. Query Org name for DMCA Drafting
      const orgRes = await query(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      const orgName = orgRes.rows[0]?.name || 'TruthShield Client';
      const orgContact = 'legal@truthshield.ai';

      // 6. Generate conditional DMCA draft
      let dmcaDraft: DMCADraft | null = null;

      const highestMatch = [
        ...brandAssetMatches,
        ...webMatches.map((w) => ({
          matchedAssetId: null,
          matchedUrl: w.url,
          similarity: w.similarity,
          matchType:
            w.similarity >= 95 ? 'exact' : w.similarity >= 85 ? 'near_duplicate' : 'similar',
          matchedOrg: null,
        })),
      ].sort((a, b) => b.similarity - a.similarity)[0];

      if (highestMatch && highestMatch.similarity > 85) {
        dmcaDraft = await this.dmcaGenerator.generateDMCADraft({
          infringingUrl: highestMatch.matchedUrl || 'https://infringing-web-asset.com',
          originalAssetDescription: 'Proprietary digital media asset registered on TruthShield',
          orgName,
          orgContact,
          matchSimilarity: highestMatch.similarity,
        });
      }

      // 7. Map Flags
      const flags: string[] = [];
      if (exactMatches.length > 0) flags.push('exact_duplicate_found');
      if (nearMatches.length > 0) flags.push('near_duplicate_found');
      if (webMatches.length > 0) flags.push('found_on_web');
      if (dmcaDraft) flags.push('dmca_draft_generated');

      // Execute cleanups prior to returning
      await cleanupTempDir(tempDir).catch(() => {});

      return {
        score,
        verdict,
        confidence,
        flags,
        details: {
          inputHash: hashResult,
          exactMatches,
          nearMatches,
          webMatches,
          brandAssetMatches,
          dmcaDraft,
          totalMatchesFound: brandAssetMatches.length + webMatches.length,
        },
      };
    } catch (err: any) {
      // Guarantee cleanup of temporary directories under error conditions
      await cleanupTempDir(tempDir).catch(() => {});
      throw err;
    }
  }
}
