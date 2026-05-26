import { logger } from '../../utils/logger.js';
import { env } from '../../config/env.js';

export interface JobAggregation {
  overallScore: number;
  overallVerdict: string;
  overallConfidence: number;
  moduleScores: { [module: string]: number };
  dominantThreat: string | null;
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  flags?: string[];
}

// Module weights for weighted average calculation
const MODULE_WEIGHTS: Record<string, number> = {
  deepfake: 1.5,
  fake_news: 1.3,
  stolen_content: 1.2,
  metadata_tampering: 1.0,
};

/**
 * Aggregates detection results from multiple modules into a single unified assessment.
 */
export function aggregateResults(results: any[]): JobAggregation {
  if (!results || results.length === 0) {
    return {
      overallScore: 0,
      overallVerdict: 'clean',
      overallConfidence: 0,
      moduleScores: {},
      dominantThreat: null,
      riskLevel: 'none',
      summary: 'No detection results available',
    };
  }

  // Build module scores map
  const moduleScores: { [module: string]: number } = {};
  for (const r of results) {
    const mod = r.module || 'unknown';
    const score = typeof r.score === 'number' ? r.score : Number(r.score) || 0;
    moduleScores[mod] = score;
  }

  let overallScore: number;

  if (results.length === 1) {
    // Single result: use its score directly
    overallScore = Number(results[0].score) || 0;
  } else {
    // Multiple results: weighted average
    let weightedSum = 0;
    let totalWeight = 0;

    for (const r of results) {
      const mod = r.module || 'unknown';
      const score = typeof r.score === 'number' ? r.score : Number(r.score) || 0;
      const weight = MODULE_WEIGHTS[mod] || 1.0;

      weightedSum += score * weight;
      totalWeight += weight;
    }

    overallScore = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
  }

  // Determine dominant threat (module with highest score)
  let dominantThreat: string | null = null;
  let highestScore = 0;

  for (const [mod, score] of Object.entries(moduleScores)) {
    if (score > highestScore) {
      highestScore = score;
      dominantThreat = mod;
    }
  }

  // If highest score is below 16, no dominant threat
  if (highestScore < 16) {
    dominantThreat = null;
  }

  // Determine risk level from overallScore
  const riskLevel = calculateRiskLevel(overallScore);

  // Determine overall verdict
  let overallVerdict = calculateVerdict(overallScore);

  // Check if human review is required (only for unreviewed results)
  const min = env.HUMAN_REVIEW_SCORE_MIN || 40;
  const max = env.HUMAN_REVIEW_SCORE_MAX || 70;

  const unreviewedResults = results.filter(
    (r) => !r.reviewed_by && !(r.flags && r.flags.includes('human_review_override'))
  );

  const verdicts = unreviewedResults.map((r) => r.verdict);
  const hasClean = verdicts.includes('clean');
  const hasManipulated = verdicts.includes('manipulated');
  const hasConflicting = hasClean && hasManipulated;
  const hasRequiresReview = verdicts.includes('requires_review');

  const anyTriggersRange = unreviewedResults.some((r) => {
    const s = typeof r.score === 'number' ? r.score : Number(r.score) || 0;
    return s >= min && s <= max;
  });

  const humanReviewRequired = anyTriggersRange || hasRequiresReview || hasConflicting;
  const flags: string[] = [];

  if (humanReviewRequired) {
    flags.push('human_review_required');
    overallVerdict = 'requires_review';
  }

  // If there are human overrides, they represent the absolute ground truth
  const humanOverrides = results.filter(
    (r) => r.reviewed_by || (r.flags && r.flags.includes('human_review_override'))
  );
  if (humanOverrides.length > 0) {
    const overriddenVerdicts = humanOverrides.map((o) => o.verdict);
    if (overriddenVerdicts.includes('manipulated')) {
      overallVerdict = 'manipulated';
    } else if (overriddenVerdicts.includes('suspicious')) {
      overallVerdict = 'suspicious';
    } else {
      overallVerdict = 'clean';
    }
  }

  // Calculate overall confidence as average of module confidences
  const confidences = results
    .map((r) => (typeof r.confidence === 'number' ? r.confidence : Number(r.confidence) || 0))
    .filter((c) => c > 0);
  const overallConfidence =
    confidences.length > 0
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 0;

  // Build human-readable summary
  const summary = buildSummary(results.length, riskLevel, dominantThreat, moduleScores);

  logger.info(
    `[Aggregator] Score: ${overallScore}, Verdict: ${overallVerdict}, Risk: ${riskLevel}, Dominant: ${dominantThreat || 'none'}`
  );

  return {
    overallScore,
    overallVerdict,
    overallConfidence,
    moduleScores,
    dominantThreat,
    riskLevel,
    summary,
    flags,
  };
}

function calculateRiskLevel(score: number): 'none' | 'low' | 'medium' | 'high' | 'critical' {
  if (score <= 15) return 'none';
  if (score <= 35) return 'low';
  if (score <= 60) return 'medium';
  if (score <= 80) return 'high';
  return 'critical';
}

function calculateVerdict(score: number): string {
  if (score <= 25) return 'clean';
  if (score <= 50) return 'suspicious';
  if (score <= 75) return 'requires_review';
  return 'manipulated';
}

function buildSummary(
  moduleCount: number,
  riskLevel: string,
  dominantThreat: string | null,
  moduleScores: Record<string, number>
): string {
  const moduleName = (mod: string): string => {
    const names: Record<string, string> = {
      deepfake: 'deepfake indicators',
      fake_news: 'misinformation signals',
      stolen_content: 'stolen content match',
      metadata_tampering: 'metadata tampering',
    };
    return names[mod] || mod;
  };

  if (riskLevel === 'none') {
    return `No threats detected across ${moduleCount} module${moduleCount > 1 ? 's' : ''}`;
  }

  if (riskLevel === 'low') {
    const indicators = dominantThreat ? moduleName(dominantThreat) : 'minor indicators';
    return `Low risk: minor indicators in ${indicators}`;
  }

  if (riskLevel === 'medium') {
    const modList = Object.entries(moduleScores)
      .filter(([, s]) => s > 35)
      .map(([m]) => moduleName(m));
    return `Medium risk: elevated signals in ${modList.join(', ') || 'analyzed content'}`;
  }

  // High or critical — list the top threats
  const topThreats = Object.entries(moduleScores)
    .filter(([, s]) => s > 50)
    .sort(([, a], [, b]) => b - a)
    .map(([m]) => moduleName(m));

  const label = riskLevel === 'critical' ? 'Critical' : 'High risk';

  if (topThreats.length > 1) {
    return `${label}: ${topThreats.join(' + ')} detected`;
  }

  if (topThreats.length === 1) {
    return `${label}: ${topThreats[0]} detected`;
  }

  return `${label}: multiple elevated signals detected across ${moduleCount} modules`;
}
