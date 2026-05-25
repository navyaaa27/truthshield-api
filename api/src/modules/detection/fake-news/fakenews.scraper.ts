import axios from 'axios';
import * as cheerio from 'cheerio';
import { validateUrlSafety } from '../../../utils/urlSafety.js';
import { ScrapedArticle, DomainInfo } from './fakenews.types.js';

export class ArticleScraper {
  private readonly KNOWN_SATIRE_SITES = [
    'theonion.com',
    'babylonbee.com',
    'clickhole.com',
    'thedailymash.co.uk',
    'waterfordwhispersnews.com',
    'satirewire.com',
    'thespoof.com',
    'newsbiscuits.com',
    'theshovel.com.au',
    'chaser.com.au',
    'thebeaverton.com',
    'duffelblog.com',
    'gomerblog.com',
    'theburrardstreetjournal.com',
    'der-postillon.com',
    'elmundotoday.com',
    'private-eye.co.uk',
    'thepeele.com',
    'satireworld.com',
    'dailycurrant.com'
  ];

  private readonly KNOWN_MISINFO_SITES = [
    'naturalnews.com',
    'infowars.com',
    'breitbart.com',
    'zerohedge.com',
    'thegatewaypundit.com',
    'activistpost.com',
    'beforeitsnews.com',
    'lewrockwell.com',
    'redstate.com',
    'wnd.com',
    'dcclothesline.com',
    'freedomoutpost.com',
    'newspunch.com',
    'yournewswire.com',
    'disclose.tv',
    'americandailypatriot.com',
    'worldnewsdailyreport.com',
    'conservativetribune.com',
    'sputniknews.com',
    'rt.com'
  ];

  /**
   * Scrapes an HTTPS article, extracts textual content and metadata,
   * and enforces strict security and SSRF boundaries.
   */
  async scrapeUrl(url: string): Promise<ScrapedArticle> {
    // 1. Enforce critical SSRF validation before network call
    await validateUrlSafety(url);

    const parsedUrl = new URL(url);
    const domain = parsedUrl.hostname.toLowerCase().replace(/^www\./, '');

    // 2. Perform safe HTTP request with User-Agent and Timeout limits
    const response = await axios.get(url, {
      timeout: 10000, // 10 seconds
      headers: {
        'User-Agent': 'TruthShieldBot/1.0',
      },
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // 3. Extract title: og:title -> title tag -> first h1
    let title = $('meta[property="og:title"]').attr('content') || '';
    if (!title) {
      title = $('title').text() || '';
    }
    if (!title) {
      title = $('h1').first().text() || '';
    }
    title = title.trim();

    // 4. Extract author: meta tags -> byline text patterns
    let author: string | null = $('meta[name="author"]').attr('content') || 
                 $('meta[property="article:author"]').attr('content') || '';
    if (!author) {
      author = $('.author, [class*="author"], .byline, [class*="byline"]').first().text() || '';
    }
    author = author.trim() || null;

    // 5. Extract publish date
    let publishDate: string | null = $('meta[property="article:published_time"]').attr('content') || 
                      $('meta[name="publish-date"]').attr('content') || '';
    if (!publishDate) {
      publishDate = $('time').attr('datetime') || $('time').first().text() || '';
    }
    publishDate = publishDate.trim() || null;

    // 6. Extract and clean body text: remove scripts, style, ads, nav, footer
    $('script, style, nav, footer, iframe, ads, .ads, #ads, header').remove();

    let bodyContainer = $('article').first();
    if (!bodyContainer.length) {
      bodyContainer = $('main').first();
    }
    if (!bodyContainer.length) {
      bodyContainer = $('body').first();
    }

    // Strip HTML elements and extract clean textual corpus
    let bodyText = bodyContainer.text() || '';
    bodyText = bodyText.replace(/\s+/g, ' ').trim();

    // Limit extracted text body to maximum 8000 characters
    if (bodyText.length > 8000) {
      bodyText = bodyText.slice(0, 8000);
    }

    return {
      title: title || 'Untitled Scraped Article',
      bodyText: bodyText || 'Empty content scraped from source.',
      author,
      publishDate,
      domain,
      url,
    };
  }

  /**
   * Assesses site-wide credibility metrics based on known seed domains
   * and security transport protocols.
   */
  async checkDomainCredibility(domain: string, isHttps = true): Promise<DomainInfo> {
    const cleanDomain = domain.toLowerCase().trim().replace(/^www\./, '');
    let credibilityScore = 70; // Starting baseline

    const isKnownSatire = this.KNOWN_SATIRE_SITES.includes(cleanDomain);
    const isKnownMisinfo = this.KNOWN_MISINFO_SITES.includes(cleanDomain);

    if (isKnownSatire) {
      credibilityScore = 20;
    } else if (isKnownMisinfo) {
      credibilityScore = 5;
    }

    // HTTPS penalty
    if (!isHttps) {
      credibilityScore -= 15;
    }

    // Default mock age constraints (no external WHOIS queries in Phase 3)
    const domainAge = '5 years'; 

    return {
      domain: cleanDomain,
      credibilityScore: Math.max(0, credibilityScore),
      isKnownSatire,
      isKnownMisinfo,
      httpsEnabled: isHttps,
      domainAge,
    };
  }
}
