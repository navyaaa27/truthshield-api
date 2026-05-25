import { jest } from '@jest/globals';

// Mock logger
jest.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { aggregateResults } from '../../src/modules/jobs/job.aggregator.js';

describe('Job Result Aggregator', () => {
  // --- Single result tests ---

  describe('Single result', () => {
    it('overallScore equals the single result score', () => {
      const results = [
        { module: 'metadata_tampering', score: 42, confidence: 85, verdict: 'suspicious' },
      ];

      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(42);
    });

    it('uses the single module as dominant threat when score >= 16', () => {
      const results = [
        { module: 'deepfake', score: 75, confidence: 90, verdict: 'requires_review' },
      ];

      const agg = aggregateResults(results);
      expect(agg.dominantThreat).toBe('deepfake');
    });

    it('no dominant threat when score < 16', () => {
      const results = [
        { module: 'metadata_tampering', score: 5, confidence: 99, verdict: 'clean' },
      ];

      const agg = aggregateResults(results);
      expect(agg.dominantThreat).toBeNull();
    });
  });

  // --- Multiple results / weighted average tests ---

  describe('Multiple results', () => {
    it('weighted average is calculated correctly', () => {
      // deepfake (weight 1.5) = 80, metadata_tampering (weight 1.0) = 20
      // weighted = (80*1.5 + 20*1.0) / (1.5 + 1.0) = (120+20)/2.5 = 56
      const results = [
        { module: 'deepfake', score: 80, confidence: 90, verdict: 'manipulated' },
        { module: 'metadata_tampering', score: 20, confidence: 95, verdict: 'clean' },
      ];

      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(56);
    });

    it('deepfake module gets 1.5x weight', () => {
      // deepfake=100 (w=1.5), fake_news=0 (w=1.3)
      // weighted = (100*1.5 + 0*1.3) / (1.5+1.3) = 150/2.8 ≈ 54
      const results = [
        { module: 'deepfake', score: 100, confidence: 90, verdict: 'manipulated' },
        { module: 'fake_news', score: 0, confidence: 80, verdict: 'clean' },
      ];

      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(54); // Math.round(150/2.8) = 54
    });

    it('all four modules with equal scores produce correctly weighted result', () => {
      // All modules score 50
      // deepfake=50*1.5=75, fake_news=50*1.3=65, stolen_content=50*1.2=60, metadata_tampering=50*1.0=50
      // total weight = 5.0, weighted sum = 250, average = 250/5 = 50
      const results = [
        { module: 'deepfake', score: 50, confidence: 80, verdict: 'suspicious' },
        { module: 'fake_news', score: 50, confidence: 80, verdict: 'suspicious' },
        { module: 'stolen_content', score: 50, confidence: 80, verdict: 'suspicious' },
        { module: 'metadata_tampering', score: 50, confidence: 80, verdict: 'suspicious' },
      ];

      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(50);
    });
  });

  // --- dominantThreat tests ---

  describe('dominantThreat', () => {
    it('correctly identifies highest scorer', () => {
      const results = [
        { module: 'deepfake', score: 30, confidence: 80, verdict: 'suspicious' },
        { module: 'fake_news', score: 85, confidence: 90, verdict: 'manipulated' },
        { module: 'metadata_tampering', score: 10, confidence: 95, verdict: 'clean' },
      ];

      const agg = aggregateResults(results);
      expect(agg.dominantThreat).toBe('fake_news');
    });

    it('returns null when all scores below 16', () => {
      const results = [
        { module: 'deepfake', score: 5, confidence: 80, verdict: 'clean' },
        { module: 'metadata_tampering', score: 10, confidence: 95, verdict: 'clean' },
      ];

      const agg = aggregateResults(results);
      expect(agg.dominantThreat).toBeNull();
    });
  });

  // --- riskLevel threshold tests ---

  describe('riskLevel thresholds', () => {
    it('0-15 = none', () => {
      const results = [{ module: 'metadata_tampering', score: 10, confidence: 99 }];
      expect(aggregateResults(results).riskLevel).toBe('none');
    });

    it('16-35 = low', () => {
      const results = [{ module: 'metadata_tampering', score: 25, confidence: 85 }];
      expect(aggregateResults(results).riskLevel).toBe('low');
    });

    it('36-60 = medium', () => {
      const results = [{ module: 'fake_news', score: 50, confidence: 80 }];
      expect(aggregateResults(results).riskLevel).toBe('medium');
    });

    it('61-80 = high', () => {
      const results = [{ module: 'deepfake', score: 75, confidence: 90 }];
      expect(aggregateResults(results).riskLevel).toBe('high');
    });

    it('81-100 = critical', () => {
      const results = [{ module: 'deepfake', score: 95, confidence: 95 }];
      expect(aggregateResults(results).riskLevel).toBe('critical');
    });

    it('boundary: score 15 = none', () => {
      const results = [{ module: 'metadata_tampering', score: 15, confidence: 99 }];
      expect(aggregateResults(results).riskLevel).toBe('none');
    });

    it('boundary: score 35 = low', () => {
      const results = [{ module: 'metadata_tampering', score: 35, confidence: 85 }];
      expect(aggregateResults(results).riskLevel).toBe('low');
    });

    it('boundary: score 60 = medium', () => {
      const results = [{ module: 'fake_news', score: 60, confidence: 80 }];
      expect(aggregateResults(results).riskLevel).toBe('medium');
    });

    it('boundary: score 80 = high', () => {
      const results = [{ module: 'deepfake', score: 80, confidence: 90 }];
      expect(aggregateResults(results).riskLevel).toBe('high');
    });
  });

  // --- summary tests ---

  describe('summary string', () => {
    it('mentions number of modules when none risk', () => {
      const results = [
        { module: 'deepfake', score: 5, confidence: 90 },
        { module: 'metadata_tampering', score: 3, confidence: 95 },
      ];

      const agg = aggregateResults(results);
      expect(agg.summary).toContain('2');
      expect(agg.summary).toContain('module');
    });

    it('mentions dominant threat for high risk', () => {
      const results = [
        { module: 'deepfake', score: 85, confidence: 90 },
        { module: 'metadata_tampering', score: 10, confidence: 95 },
      ];

      const agg = aggregateResults(results);
      expect(agg.summary.toLowerCase()).toContain('deepfake');
    });
  });

  // --- Edge cases ---

  describe('Edge cases', () => {
    it('empty results array returns safe defaults', () => {
      const agg = aggregateResults([]);
      expect(agg.overallScore).toBe(0);
      expect(agg.riskLevel).toBe('none');
      expect(agg.dominantThreat).toBeNull();
    });

    it('handles string scores by parsing them', () => {
      const results = [
        { module: 'deepfake', score: '72', confidence: '90' },
      ];

      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(72);
    });

    it('handles unknown module names with default weight', () => {
      const results = [
        { module: 'custom_module', score: 60, confidence: 80 },
        { module: 'metadata_tampering', score: 40, confidence: 90 },
      ];

      // custom_module weight defaults to 1.0, metadata_tampering is 1.0
      // weighted = (60*1.0 + 40*1.0) / (1.0 + 1.0) = 50
      const agg = aggregateResults(results);
      expect(agg.overallScore).toBe(50);
    });
  });
});
