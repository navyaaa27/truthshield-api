export interface ExifAnalysis {
  flags: string[];
  software?: string;
  cameraModel?: string;
  createDate?: string;
  modifyDate?: string;
  gpsData?: {
    latitude?: number;
    longitude?: number;
  };
}

export interface ELAAnalysis {
  suspiciousRegions: boolean;
  meanDiff: number;
  stdDev: number;
  elaScore: number;
  skipped?: boolean;
  reason?: string;
}

export interface HashVerification {
  sha256: string;
  previousHash?: string;
  hashChanged: boolean;
}

export interface MetadataTamperingResult {
  score: number;
  verdict: 'clean' | 'suspicious' | 'manipulated' | 'requires_review';
  confidence: number;
  flags: string[];
  details: {
    exifAnalysis: ExifAnalysis;
    elaAnalysis: ELAAnalysis;
    hashVerification: HashVerification;
    inconsistencies: string[];
  };
}
