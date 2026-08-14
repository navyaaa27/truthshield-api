export type ReviewStatus =
  | 'pending'
  | 'assigned'
  | 'in_review'
  | 'completed'
  | 'escalated'
  | 'auto_resolved';
export type ReviewPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ReviewerVerdict =
  | 'clean'
  | 'suspicious'
  | 'manipulated'
  | 'requires_escalation'
  | 'inconclusive';

export interface HumanReview {
  id: string;
  result_id: string;
  job_id: string;
  org_id: string;
  assigned_to: string | null;
  status: ReviewStatus;
  priority: ReviewPriority;
  ai_score: number;
  ai_verdict: string;
  reviewer_verdict: ReviewerVerdict | null;
  reviewer_notes: string | null;
  reviewer_confidence: number | null;
  override_reason: string | null;
  sla_deadline: Date;
  assigned_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateReviewDTO {
  resultId: string;
  jobId: string;
  orgId: string;
  aiScore: number;
  aiVerdict: string;
}

export interface SubmitReviewDTO {
  reviewerVerdict: ReviewerVerdict;
  reviewerNotes: string;
  reviewerConfidence: 1 | 2 | 3 | 4 | 5;
  overrideReason?: string;
}

export interface ReviewerWorkload {
  reviewerId: string;
  reviewerEmail: string;
  activeCount: number;
}

export interface ReviewQueueStats {
  pending: number;
  assigned: number;
  inReview: number;
  overdueCount: number;
  avgResolutionHours: number;
  reviewerWorkloads: ReviewerWorkload[];
}
