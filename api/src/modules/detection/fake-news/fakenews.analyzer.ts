import axios from 'axios';
import { env } from '../../../config/env.js';
import { FakeNewsResult, DomainInfo } from './fakenews.types.js';
import { ArticleScraper } from './fakenews.scraper.js';
import { ClaimExtractor } from './fakenews.extractor.js';
import { FactChecker } from './fakenews.factchecker.js';
import { logger } from '../../../utils/logger.js';

export class FakeNewsAnalyzer {
  private scraper = new ArticleScraper();
  private extractor = new ClaimExtractor();
  private checker = new FactChecker();

  /**
   * Main analysis entrypoint parsing either a scraped URL or raw input text.
   */
  async analyze(
    input: { sourceUrl?: string; rawText?: string },
    contentType: 'url' | 'article',
  ): Promise<FakeNewsResult> {
    let title = 'Raw Input Text Analysis';
    let textToAnalyze = input.rawText || '';
    let url = input.sourceUrl || 'https://truthshield.ai/raw-text';
    let author: string | null = 'Unknown';
    let publishDate: string | null = new Date().toISOString();
    let domain = 'raw-text';
    let domainInfo: DomainInfo;

    // 1. Scrape if URL is provided
    if (contentType === 'url' && input.sourceUrl) {
      const scraped = await this.scraper.scrapeUrl(input.sourceUrl);
      title = scraped.title;
      textToAnalyze = scraped.bodyText;
      url = scraped.url;
      author = scraped.author;
      publishDate = scraped.publishDate;
      domain = scraped.domain;
      domainInfo = await this.scraper.checkDomainCredibility(domain, true);
    } else {
      domainInfo = await this.scraper.checkDomainCredibility(domain, true);
    }

    // 2. Extract Claims
    const extraction = await this.extractor.extractClaims(
      textToAnalyze,
      url,
      title,
      author,
      publishDate,
    );

    // 3. Verify Claims
    const claimResults = await this.checker.checkClaims(extraction.claims);

    // 4. Calculate Claims score
    let claimScore = 50;
    let confidence = 30;

    if (extraction.claims.length === 0) {
      claimScore = 50;
      confidence = 25;
    } else {
      let totalWeightedVeracity = 0;
      let totalWeight = 0;

      for (const res of claimResults) {
        const matchingClaim = extraction.claims.find((c) => c.id === res.claimId);
        const weight =
          matchingClaim?.claimType === 'factual' || matchingClaim?.claimType === 'statistic'
            ? 2
            : 1;

        totalWeightedVeracity += res.finalVeracity * weight;
        totalWeight += weight;
      }

      const averageVeracity = totalWeight > 0 ? totalWeightedVeracity / totalWeight : 50;

      // claimScore represents MISINFORMATION probability (100 = completely false, 0 = completely true)
      claimScore = 100 - averageVeracity;

      // Apply penalty for multiple false claims (Veracity < 35)
      const falseClaimsFound = claimResults.filter((r) => r.finalVeracity < 35).length;
      if (falseClaimsFound >= 3) {
        claimScore += 20;
      }

      claimScore = Math.max(0, Math.min(100, claimScore));

      // Dynamic confidence calculation based on count
      const count = extraction.claims.length;
      if (count <= 2) {
        confidence = 50;
      } else if (count <= 5) {
        confidence = 70;
      } else {
        confidence = 85;
      }
    }

    // 5. Calculate Domain score
    let domainScore = 0;
    if (domainInfo.isKnownMisinfo) {
      domainScore += 40;
      confidence = 95; // Forced absolute high confidence for flagged misinfo outlets
    }
    if (domainInfo.isKnownSatire) {
      domainScore += 25;
    }
    if (domainInfo.credibilityScore < 30) {
      domainScore += 15;
    }

    // Weighted final score calculation
    let score = claimScore * 0.6 + domainScore * 0.4;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // 6. Map Verdict
    let verdict: 'clean' | 'suspicious' | 'requires_review' | 'manipulated' = 'clean';
    if (score > 75) {
      verdict = 'manipulated';
    } else if (score > 50) {
      verdict = 'requires_review';
    } else if (score > 25) {
      verdict = 'suspicious';
    }

    const flags: string[] = [];
    if (domainInfo.isKnownSatire) flags.push('KNOWN_SATIRE_OUTLET');
    if (domainInfo.isKnownMisinfo) flags.push('KNOWN_MISINFORMATION_OUTLET');
    if (!domainInfo.httpsEnabled) flags.push('INSECURE_CONNECTION');
    const falseCount = claimResults.filter((r) => r.finalVeracity < 35).length;
    if (falseCount >= 3) flags.push('MULTIPLE_FALSE_CLAIMS_DETECTED');

    // 7. Synthesize Overall Review Summary
    const overallSummary = await this.generateOverallSummary(
      score,
      domainInfo,
      claimResults.length,
      falseCount,
    );

    return {
      score,
      verdict,
      confidence,
      flags,
      details: {
        claimsAnalyzed: claimResults.length,
        falseClaimsFound: falseCount,
        sourceCredibility: domainInfo.credibilityScore,
        domainInfo,
        claimResults,
        overallSummary,
      },
    };
  }

  /**
   * Convenience wrapper analyzing raw textual content directly.
   */
  async analyzeText(text: string): Promise<FakeNewsResult> {
    return this.analyze({ rawText: text }, 'article');
  }

  /**
   * Generates a neutral, concise summary explaining the misinformation probability verdict.
   */
  private async generateOverallSummary(
    score: number,
    domainInfo: DomainInfo,
    claimsCount: number,
    falseCount: number,
  ): Promise<string> {
    const defaultSummary = `This content received a misinformation score of ${score}/100. Analysis evaluated ${claimsCount} extracted claim(s), identifying ${falseCount} verified false statement(s) alongside a domain credibility index of ${domainInfo.credibilityScore}.`;

    if (!env.ANTHROPIC_API_KEY) {
      return defaultSummary;
    }

    const systemPrompt = `You are a fact-checking summary assistant. Summarize in 2 sentences why this content scored ${score}/100 for misinformation probability. Be factual, neutral, and objective. Do not express personal opinion or include links.`;

    const userPrompt = `
Misinformation Score: ${score}/100
Domain Credibility Score: ${domainInfo.credibilityScore} (Known Misinfo: ${domainInfo.isKnownMisinfo}, Known Satire: ${domainInfo.isKnownSatire})
Total Claims Analyzed: ${claimsCount}
Verified False Claims Found: ${falseCount}
`;

    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          temperature: 0.5,
          system: systemPrompt,
          messages: [
            {
              role: 'user',
              content: userPrompt,
            },
          ],
        },
        {
          headers: {
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 4000,
        },
      );

      return response.data.content[0].text.trim() || defaultSummary;
    } catch (err: any) {
      logger.warn(`Failed to generate Claude summary analysis: ${err.message}`);
      return defaultSummary;
    }
  }
}
