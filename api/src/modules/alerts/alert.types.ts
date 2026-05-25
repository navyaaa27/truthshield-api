export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface Alert {
  id: string;
  org_id: string;
  result_id: string;
  job_id: string;
  severity: AlertSeverity;
  title: string;
  summary: string;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  notification_sent: boolean;
  notification_channels: string[] | null;
  created_at: Date;
  updated_at: Date;
}

export interface AlertFilters {
  severity?: AlertSeverity;
  acknowledged?: boolean;
  page: number;
  limit: number;
}

export interface AlertStats {
  total: number;
  bySeverity: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
  unread: number;
}
