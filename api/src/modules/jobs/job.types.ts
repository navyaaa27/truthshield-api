export interface DetectionJob {
  id: string;
  org_id: string;
  created_by: string;
  content_type: 'video' | 'image' | 'article' | 'url' | 'file';
  detection_modules: Array<'deepfake' | 'fake_news' | 'stolen_content' | 'metadata_tampering'>;
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  s3_key: string | null;
  source_url: string | null;
  source_metadata: Record<string, unknown> | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  queued_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateJobDTO {
  contentType: 'video' | 'image' | 'article' | 'url' | 'file';
  detectionModules: Array<'deepfake' | 'fake_news' | 'stolen_content' | 'metadata_tampering'>;
  sourceUrl?: string;
  priority?: number;
}

export interface JobStatusUpdate {
  status: 'pending' | 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';
  errorMessage?: string;
  s3Key?: string;
}

export interface DetectionResult {
  id: string;
  job_id: string;
  org_id: string;
  module: 'deepfake' | 'fake_news' | 'stolen_content' | 'metadata_tampering';
  score: number;
  verdict: 'clean' | 'suspicious' | 'manipulated' | 'requires_review';
  confidence: number;
  model_version: string;
  processing_time_ms: number | null;
  result_data: Record<string, unknown> | null;
  flags: string[];
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_notes: string | null;
  created_at: Date;
}

export interface JobWithResults extends DetectionJob {
  results: DetectionResult[];
}
