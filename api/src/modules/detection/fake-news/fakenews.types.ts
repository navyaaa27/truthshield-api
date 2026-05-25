export interface ExtractedClaim {
  id: string;
  text: string;
  claimType: 'factual' | 'opinion' | 'prediction' | 'statistic';
  confidence: number;
  sentences: string[];
}

export interface DomainInfo {
  domain: string;
  credibilityScore: number;
  isKnownSatire: boolean;
  isKnownMisinfo: boolean;
  httpsEnabled: boolean;
  domainAge: string | null;
}

export interface ClaimExtraction {
  claims: ExtractedClaim[];
  sourceUrl: string;
  articleTitle: string;
  authorInfo: string | null;
  publishDate: string | null;
  domainInfo: DomainInfo;
}

export interface GoogleFactCheck {
  claimText: string;
  publisher: string;
  rating: string;
  url: string;
}

export interface ClaudeVerdict {
  verdict: 'true' | 'false' | 'uncertain' | 'opinion';
  confidence: number;
  reasoning: string;
  caveats?: string;
}

export interface SourceCorroboration {
  sourcesChecked: string[];
  corroboratingCount: number;
  sources: { title: string; link: string; matchConfidence: number }[];
}

export interface FactCheckResult {
  claimId: string;
  claimText: string;
  googleFactChecks: GoogleFactCheck[];
  claudeVerdict: ClaudeVerdict;
  sourceCorroboration: SourceCorroboration;
  finalVeracity: number; // 0-100 (0=false, 100=true)
}

export interface FakeNewsResult {
  score: number; // Misinformation probability (0-100)
  verdict: 'clean' | 'suspicious' | 'requires_review' | 'manipulated';
  confidence: number; // (0-100)
  flags: string[];
  details: {
    claimsAnalyzed: number;
    falseClaimsFound: number;
    sourceCredibility: number;
    domainInfo: DomainInfo;
    claimResults: FactCheckResult[];
    overallSummary: string;
  };
}

export interface ScrapedArticle {
  title: string;
  bodyText: string;
  author: string | null;
  publishDate: string | null;
  domain: string;
  url: string;
}
