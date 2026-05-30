import { Organization } from '../organizations/organization.types.js';
import { User } from '../auth/auth.types.js';
import { TrendDataPoint, ModuleBreakdown } from '../dashboard/dashboard.types.js';

export interface ReportRequest {
  orgId: string;
  requestedBy: string;
  reportType: 'threat_summary' | 'job_detail' | 'compliance_audit' | 'dmca_bundle';
  dateRange: { startDate: string; endDate: string };
  jobIds?: string[];
  includeModules?: string[];
  includeScreenshots: boolean;
  format: 'pdf' | 'json';
}

export interface ReportMetadata {
  id: string;
  orgId: string;
  reportType: string;
  generatedAt: string;
  generatedBy: string;
  dateRange: { startDate: string; endDate: string };
  totalPages: number;
  s3Key: string;
  downloadUrl: string;
  expiresAt: string;
  fileSizeBytes: number;
}

export interface DMCADraft {
  jobId: string;
  infringingUrl: string;
  matchType: string;
  similarityScore: number;
  originalAssetDescription: string;
  dmcaNoticeText: string;
}

export interface JobWithFullResults {
  job_id: string;
  content_type: string;
  overall_score: number;
  verdict: string;
  risk_level: string;
  detected_at: string;
  s3_key: string | null;
  alert_id: string | null;
  alert_severity: string | null;
  review_id: string | null;
  module_results: Array<{
    module: string;
    score: number;
    verdict: string;
  }>;
}

export interface ReportData {
  org: Organization;
  generatedAt: string;
  generatedBy: User;
  dateRange: { startDate: string; endDate: string };
  summary: {
    totalJobs: number;
    threatsDetected: number;
    criticalAlerts: number;
    avgScore: number;
    cleanPct: number;
    pendingReviews: number;
  };
  jobs: JobWithFullResults[];
  trends: TrendDataPoint[];
  moduleBreakdown: ModuleBreakdown[];
  dmcaDrafts: DMCADraft[];
  reportId: string;
}

export interface Report {
  id: string;
  orgId: string;
  requestedBy: string;
  reportType: string;
  status: 'generating' | 'ready' | 'failed' | 'expired';
  dateRangeStart: Date;
  dateRangeEnd: Date;
  s3Key?: string;
  fileSizeBytes?: number;
  totalPages?: number;
  downloadUrl?: string;
  expiresAt?: Date;
  errorMessage?: string;
  jobCount?: number;
  createdAt: Date;
}
