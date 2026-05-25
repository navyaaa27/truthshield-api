import axios from 'axios';
import { env } from '../../../config/env.js';
import { DMCADraft } from './stolen.types.js';
import { logger } from '../../../utils/logger.js';

export class DMCAGenerator {
  /**
   * Generates a complete, legally sound DMCA takedown draft if the match similarity exceeds 85%.
   * Note: Never present DMCA drafts as legal advice. Always include the disclaimer.
   */
  async generateDMCADraft(params: {
    infringingUrl: string;
    originalAssetDescription: string;
    orgName: string;
    orgContact: string;
    matchSimilarity: number;
  }): Promise<DMCADraft | null> {
    const { infringingUrl, originalAssetDescription, orgName, orgContact, matchSimilarity } = params;

    // Strict compliance check: only draft notices when similarity is greater than 85%
    if (matchSimilarity <= 85) {
      logger.info(`Similarity score (${matchSimilarity}%) is too low to trigger automatic DMCA drafting.`);
      return null;
    }

    const defaultSubject = `URGENT: Copyright Infringement Takedown Notice (17 U.S.C. § 512) - ${orgName}`;
    const defaultBody = `
Dear Sir/Madam,

I, the undersigned, hereby state under penalty of perjury that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.

1. Identifcation of Infringement:
We have detected unauthorized duplication of our proprietary visual digital assets.
Original Work Description: ${originalAssetDescription}
Similarity Match Index: ${matchSimilarity}%

2. Location of Infringing Material:
Infringing URL: ${infringingUrl}

3. Claimant Contact Information:
Owner Organization: ${orgName}
Contact Address/Details: ${orgContact}

We have a good faith belief that use of the material in the manner complained of is not authorized by the copyright owner, its agent, or the law.

Please remove or disable access to the infringing material immediately.

Sincerely,
Representative of ${orgName}

DISCLAIMER: This is an AI-generated draft. Review by qualified legal counsel is strongly recommended before sending.
`.trim();

    const recipientType: 'platform' | 'host' | 'registrar' = 'platform';

    const generatedAt = new Date().toISOString();

    if (!env.ANTHROPIC_API_KEY) {
      return {
        recipientType,
        subject: defaultSubject,
        body: defaultBody,
        infringingUrl,
        originalAssetDescription,
        generatedAt,
      };
    }

    const systemPrompt = `You are a legal document assistant specializing in DMCA takedown notices. Generate professional, legally-sound DMCA takedown notice text. Include all required elements under 17 U.S.C. § 512(c)(3). Return ONLY valid JSON matching the schema provided. Do not enclose the output in markdown code blocks like \`\`\`json.`;

    const userPrompt = `
Generate a DMCA takedown notice with:
- Infringing URL: ${infringingUrl}
- Original work description: ${originalAssetDescription}
- Claimant organization: ${orgName}
- Claimant Contact details: ${orgContact}
- Similarity score: ${matchSimilarity}%

Return JSON:
{
  "subject": "email subject line",
  "body": "full notice text with all DMCA elements",
  "recipientType": "platform" | "host" | "registrar"
}
`;

    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          temperature: 0.2,
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
          timeout: 5000,
        }
      );

      const content = response.data.content[0].text;
      const cleanedJson = content.trim().replace(/^```json/, '').replace(/```$/, '').trim();
      const parsed = JSON.parse(cleanedJson);

      let body = parsed.body || defaultBody;
      
      // Ensure the mandatory disclaimer is appended at all costs
      if (!body.includes('DISCLAIMER:')) {
        body += '\n\nDISCLAIMER: This is an AI-generated draft. Review by qualified legal counsel is strongly recommended before sending.';
      }

      return {
        recipientType: parsed.recipientType || recipientType,
        subject: parsed.subject || defaultSubject,
        body,
        infringingUrl,
        originalAssetDescription,
        generatedAt,
      };
    } catch (err: any) {
      logger.warn(`Claude DMCA notice drafting failed: ${err.message}. Emitting boilerplate template instead.`);
      return {
        recipientType,
        subject: defaultSubject,
        body: defaultBody,
        infringingUrl,
        originalAssetDescription,
        generatedAt,
      };
    }
  }
}
