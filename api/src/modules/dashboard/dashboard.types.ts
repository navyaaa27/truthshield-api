export interface DashboardOverview {
  org: {
    id: string;
    name: string;
    planTier: string;
    memberCount: number;
  };
  stats: {
    totalJobsAllTime: number;
    jobsThisPeriod: number;
    threatsDetected: number;
    threatsTrend: number; // % change vs prev period
    avgDetectionScore: number;
    cleanContentPct: number;
    reviewsPending: number;
    criticalAlerts: number;
  };
  quotaUsage: {
    jobsUsed: number;
    jobsLimit: number;
    uploadsUsed: number;
    uploadsLimit: number;
    resetAt: string;
  };
}

export interface ThreatFeedItem {
  jobId: string;
  detectedAt: string;
  contentType: string;
  riskLevel: string;
  dominantThreat: string | null;
  overallScore: number;
  verdict: string;
  moduleResults: {
    module: string;
    score: number;
    verdict: string;
  }[];
  alertId: string | null;
  alertSeverity: string | null;
  requiresReview: boolean;
  thumbnailUrl: string | null;
}

export interface TrendDataPoint {
  date: string;
  jobsRun: number;
  threatsFound: number;
  avgScore: number;
  byModule: {
    deepfake: number;
    fake_news: number;
    stolen_content: number;
    metadata_tampering: number;
  };
}

export interface ModuleBreakdown {
  module: string;
  totalRuns: number;
  threatsFound: number;
  avgScore: number;
  verdictDistribution: {
    clean: number;
    suspicious: number;
    requires_review: number;
    manipulated: number;
  };
}
