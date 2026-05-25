export interface PHashResult {
  hash: string; // JSON string representing hash details or array of hashes
  hashType: 'phash' | 'dhash' | 'ahash';
  computedAt: string;
}

export interface SimilarityMatch {
  matchedAssetId: string | null;
  matchedUrl: string | null;
  similarity: number; // 0-100
  matchType: 'exact' | 'near_duplicate' | 'similar' | 'derivative';
  matchedOrg: string | null;
}

export interface ContentSearchResult {
  url: string;
  title: string;
  similarity: number;
  foundVia: 'hash_index' | 'web_search' | 'reverse_image';
  capturedAt: string;
}

export interface DMCADraft {
  recipientType: 'platform' | 'host' | 'registrar';
  subject: string;
  body: string;
  infringingUrl: string;
  originalAssetDescription: string;
  generatedAt: string;
}

export interface StolenContentResult {
  score: number;
  verdict: string;
  confidence: number;
  flags: string[];
  details: {
    inputHash: PHashResult;
    exactMatches: SimilarityMatch[];
    nearMatches: SimilarityMatch[];
    webMatches: ContentSearchResult[];
    brandAssetMatches: SimilarityMatch[];
    dmcaDraft: DMCADraft | null;
    totalMatchesFound: number;
  };
}
