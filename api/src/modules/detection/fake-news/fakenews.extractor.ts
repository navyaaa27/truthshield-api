import axios from 'axios';
import { env } from '../../../config/env.js';
import { ClaimExtraction, ExtractedClaim } from './fakenews.types.js';
import { ArticleScraper } from './fakenews.scraper.js';
import { logger } from '../../../utils/logger.js';

export class ClaimExtractor {
  private scraper = new ArticleScraper();

  /**
   * Leverages Claude Sonnet to extract specific, verifiable claims from the scraped text.
   */
  async extractClaims(
    text: string,
    sourceUrl: string,
    title: string,
    author: string | null,
    publishDate: string | null
  ): Promise<ClaimExtraction> {
    const parsedUrl = new URL(sourceUrl);
    const domain = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
    const isHttps = parsedUrl.protocol === 'https:';

    // 1. Resolve domain credibility baseline
    const domainInfo = await this.scraper.checkDomainCredibility(domain, isHttps);

    const first6000 = text.slice(0, 6000);

    const systemPrompt = `You are a fact-checking assistant. Extract specific, verifiable factual claims from the article text provided. Focus on claims that can be checked against reality: statistics, events, quotes attributed to people, scientific claims, and historical assertions. Exclude opinions and predictions unless stated as fact. Return ONLY valid JSON matching the schema provided. Do not enclose the output in markdown code blocks like \`\`\`json.`;

    const userPrompt = `
Article Title: ${title}
Author: ${author || 'Unknown'}
Publish Date: ${publishDate || 'Unknown'}
Source URL: ${sourceUrl}

Article Content (Snippet):
${first6000}

Analyze the above text and extract up to 10 verifiable claims.
Return a valid JSON object matching this schema:
{
  "claims": [
    {
      "id": "claim_1",
      "text": "the specific claim text",
      "claimType": "factual" | "opinion" | "prediction" | "statistic",
      "confidence": 0.95,
      "sentences": ["matching sentence 1 from context"]
    }
  ],
  "articleSummary": "Brief two-sentence summary of the article."
}
`;

    try {
      // Return fallback empty result if ANTHROPIC_API_KEY is not configured
      if (!env.ANTHROPIC_API_KEY) {
        logger.warn('ANTHROPIC_API_KEY is not configured, returning fallback empty claims extraction.');
        return {
          claims: [],
          sourceUrl,
          articleTitle: title,
          authorInfo: author,
          publishDate,
          domainInfo,
        };
      }

      // 2. Perform direct HTTP POST call to Claude Message endpoint
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          temperature: 0,
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
        }
      );

      const content = response.data.content[0].text;
      
      // Clean potential JSON markdown wrapper if Claude returned any
      const cleanedJson = content.trim().replace(/^```json/, '').replace(/```$/, '').trim();

      const parsedResponse = JSON.parse(cleanedJson);

      let claims: ExtractedClaim[] = parsedResponse.claims || [];

      // Sort and take the top 10 claims with highest confidence levels
      claims = claims
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10);

      return {
        claims,
        sourceUrl,
        articleTitle: title,
        authorInfo: author,
        publishDate,
        domainInfo,
      };
    } catch (err: any) {
      logger.error(`Claude API Claim Extraction failed: ${err.message}`);
      // Graceful fallback return to keep the worker running
      return {
        claims: [],
        sourceUrl,
        articleTitle: title,
        authorInfo: author,
        publishDate,
        domainInfo,
      };
    }
  }
}
