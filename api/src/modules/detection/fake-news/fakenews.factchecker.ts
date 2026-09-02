import axios from 'axios';
import * as cheerio from 'cheerio';
import { env } from '../../../config/env.js';
import {
  ExtractedClaim,
  FactCheckResult,
  GoogleFactCheck,
  ClaudeVerdict,
  SourceCorroboration,
} from './fakenews.types.js';
import { logger } from '../../../utils/logger.js';
import { recordExternalApi } from '../../../shared/metrics/metrics.service.js';

export class FactChecker {
  private readonly CREDIBLE_RSS_FEEDS = [
    'https://feeds.reuters.com/reuters/topNews',
    'https://rss.apnews.com/apnews/topnews',
    'https://feeds.bbci.co.uk/news/rss.xml',
  ];

  private readonly STOP_WORDS = new Set([
    'the',
    'a',
    'an',
    'is',
    'of',
    'and',
    'to',
    'in',
    'on',
    'at',
    'for',
    'with',
    'by',
    'that',
    'this',
    'it',
    'was',
    'were',
    'be',
    'are',
    'about',
    'from',
  ]);

  /**
   * Evaluates a list of claims with a maximum concurrency limit of 3.
   */
  async checkClaims(claims: ExtractedClaim[]): Promise<FactCheckResult[]> {
    const results: FactCheckResult[] = [];
    const chunks: ExtractedClaim[][] = [];

    // Chunk claims into groups of 3
    for (let i = 0; i < claims.length; i += 3) {
      chunks.push(claims.slice(i, i + 3));
    }

    for (const chunk of chunks) {
      const chunkResults = await Promise.all(chunk.map((c) => this.checkSingleClaim(c)));
      results.push(...chunkResults);
    }

    return results;
  }

  /**
   * Runs all sub-verification engines in parallel for a single claim.
   */
  private async checkSingleClaim(claim: ExtractedClaim): Promise<FactCheckResult> {
    // Implement standard 200ms rate-limit throttling before triggering lookups
    await new Promise((resolve) => setTimeout(resolve, 200));

    const [googleChecks, claudeVerdict, corroboration] = await Promise.all([
      this.checkGoogleFactCheck(claim.text),
      this.checkWithClaude(claim),
      this.checkSourceCorroboration(claim.text),
    ]);

    // Heuristics veracity scoring (Base value starts at 50)
    let finalVeracity = 50;

    // 1. Evaluate Google Fact Check ratings
    const hasFalseCheck = googleChecks.some((c) =>
      /false|incorrect|untrue|fake|misleading/i.test(c.rating),
    );
    const hasTrueCheck = googleChecks.some((c) => /true|correct|accurate/i.test(c.rating));

    if (hasFalseCheck) {
      finalVeracity -= 40;
    } else if (hasTrueCheck) {
      finalVeracity += 30;
    }

    // 2. Evaluate Claude analysis
    if (claudeVerdict.verdict === 'false' && claudeVerdict.confidence > 0.7) {
      finalVeracity -= 35;
    } else if (claudeVerdict.verdict === 'true' && claudeVerdict.confidence > 0.7) {
      finalVeracity += 25;
    }

    // 3. Evaluate RSS News Source Corroboration
    if (corroboration.corroboratingCount === 0) {
      finalVeracity -= 10;
    } else if (corroboration.corroboratingCount >= 2) {
      finalVeracity += 15;
    }

    // Clamp score strictly between 0 and 100
    finalVeracity = Math.max(0, Math.min(100, finalVeracity));

    return {
      claimId: claim.id,
      claimText: claim.text,
      googleFactChecks: googleChecks,
      claudeVerdict,
      sourceCorroboration: corroboration,
      finalVeracity,
    };
  }

  /**
   * Queries the Google Fact Check Tools API for matching claims.
   */
  private async checkGoogleFactCheck(claimText: string): Promise<GoogleFactCheck[]> {
    if (!env.GOOGLE_FACT_CHECK_API_KEY) {
      return [];
    }

    const query = claimText.slice(0, 100);
    const url = env.GOOGLE_FACT_CHECK_API_URL;

    try {
      const response = await recordExternalApi('GoogleFactCheck', 'claims_search', () =>
        axios.get(url, {
          params: {
            query,
            key: env.GOOGLE_FACT_CHECK_API_KEY,
          },
          timeout: 5000,
        }),
      );

      const checks: GoogleFactCheck[] = [];
      if (response.data && response.data.claims) {
        for (const claimRecord of response.data.claims) {
          if (claimRecord.claimReview) {
            for (const review of claimRecord.claimReview) {
              checks.push({
                claimText: claimRecord.text || query,
                publisher: review.publisher ? review.publisher.name : 'Unknown',
                rating: review.textRating || 'Unknown',
                url: review.url || '',
              });
            }
          }
        }
      }
      return checks;
    } catch (err: any) {
      logger.warn(`Google Fact Check API query failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Leverages Claude to locally evaluate the credibility of a claim.
   */
  private async checkWithClaude(claim: ExtractedClaim): Promise<ClaudeVerdict> {
    if (!env.ANTHROPIC_API_KEY) {
      return {
        verdict: 'uncertain',
        confidence: 0.5,
        reasoning: 'Anthropic API key is missing. Unable to assess veracity via Claude.',
      };
    }

    const systemPrompt = `You are a fact-checker. Given a claim, assess its veracity based on your knowledge. Be conservative — only mark as false if clearly incorrect. Return ONLY valid JSON matching the schema provided. Do not enclose the output in markdown code blocks like \`\`\`json.`;

    const userPrompt = `
Claim: ${claim.text}
Context: ${claim.sentences.join(' ')}

Assess the veracity of the claim.
Return a valid JSON object matching this schema:
{
  "verdict": "true" | "false" | "uncertain" | "opinion",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation under 100 words",
  "caveats": "knowledge limitations if any"
}
`;

    try {
      const response = await recordExternalApi('Anthropic', 'messages_create', () =>
        axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1000,
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
          },
        ),
      );

      const content = response.data?.content?.[0]?.text || '{}';
      let cleanedJson = content.trim();
      const jsonMatch = cleanedJson.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        cleanedJson = jsonMatch[1].trim();
      } else {
        const firstBrace = cleanedJson.indexOf('{');
        const lastBrace = cleanedJson.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
          cleanedJson = cleanedJson.slice(firstBrace, lastBrace + 1);
        }
      }
      const parsed = JSON.parse(cleanedJson);


      return {
        verdict: parsed.verdict || 'uncertain',
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning || 'No details provided.',
        caveats: parsed.caveats,
      };
    } catch (err: any) {
      logger.warn(`Claude veracity assessment failed: ${err.message}`);
      return {
        verdict: 'uncertain',
        confidence: 0.5,
        reasoning: `Claude veracity assessment failed: ${err.message}`,
      };
    }
  }

  /**
   * Crawls credible RSS feeds for real-time keyword overlap corroboration.
   */
  private async checkSourceCorroboration(claimText: string): Promise<SourceCorroboration> {
    const claimKeywords = this.getKeywords(claimText);
    const corroboratedSources: { title: string; link: string; matchConfidence: number }[] = [];

    if (claimKeywords.length === 0) {
      return {
        sourcesChecked: this.CREDIBLE_RSS_FEEDS,
        corroboratingCount: 0,
        sources: [],
      };
    }

    try {
      const feedPromises = this.CREDIBLE_RSS_FEEDS.map(async (feedUrl) => {
        try {
          const res = await recordExternalApi('RSSFeed', feedUrl, () =>
            axios.get(feedUrl, { timeout: 3000 }),
          );
          const $ = cheerio.load(res.data, { xmlMode: true });

          $('item').each((_, item) => {
            const headline = $(item).find('title').text() || '';
            const link = $(item).find('link').text() || '';

            if (headline) {
              const headlineKeywords = this.getKeywords(headline);
              const overlap = claimKeywords.filter((w) => headlineKeywords.includes(w));

              if (overlap.length >= 2) {
                const matchConfidence = overlap.length / claimKeywords.length;
                corroboratedSources.push({
                  title: headline,
                  link,
                  matchConfidence: Math.min(1.0, matchConfidence),
                });
              }
            }
          });
        } catch (e: any) {
          logger.warn(`RSS feed scrape failed for ${feedUrl}: ${e.message}`);
        }
      });

      await Promise.all(feedPromises);

      // Sort corroborating stories by match confidence levels
      const sortedSources = corroboratedSources
        .sort((a, b) => b.matchConfidence - a.matchConfidence)
        .slice(0, 5);

      return {
        sourcesChecked: this.CREDIBLE_RSS_FEEDS,
        corroboratingCount: sortedSources.length,
        sources: sortedSources,
      };
    } catch (err: any) {
      logger.warn(`Source corroboration failed: ${err.message}`);
      return {
        sourcesChecked: this.CREDIBLE_RSS_FEEDS,
        corroboratingCount: 0,
        sources: [],
      };
    }
  }

  /**
   * Helper extracting normalized keywords, filtering standard English stop words.
   */
  private getKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !this.STOP_WORDS.has(w));
  }
}
