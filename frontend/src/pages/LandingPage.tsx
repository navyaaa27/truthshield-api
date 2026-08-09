import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import './LandingPage.css';

/* ── Animated scan-line ticker ─────────────────────────── */
const TICKER_ITEMS = [
  'DEEPFAKE DETECTED · 94.2% CONFIDENCE',
  'FACT CHECK COMPLETE · SOURCE VERIFIED',
  'METADATA TAMPERING · EXIF MISMATCH',
  'VIDEO ANALYSIS · 847 FRAMES PROCESSED',
  'DMCA MATCH · 3 SOURCES IDENTIFIED',
  'AI-GENERATED IMAGE · GAN SIGNATURE FOUND',
];

function Ticker() {
  return (
    <div className="ticker-wrap">
      <div className="ticker-track">
        {[...TICKER_ITEMS, ...TICKER_ITEMS].map((item, i) => (
          <span key={i} className="ticker-item">
            <span className="ticker-dot" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── Animated grid background ──────────────────────────── */
function GridBg() {
  return <div className="grid-bg" aria-hidden="true" />;
}

/* ── Forensic analysis mockup card ─────────────────────── */
function AnalysisCard() {
  return (
    <div className="analysis-card">
      <div className="analysis-card__header">
        <span className="analysis-card__dot red" />
        <span className="analysis-card__dot amber" />
        <span className="analysis-card__dot green" />
        <span className="mono analysis-card__label">forensic_analysis.ts</span>
      </div>

      <div className="analysis-card__body">
        <div className="analysis-row">
          <span className="mono ar-label">facial_artifacts</span>
          <div className="ar-bar-wrap">
            <div className="ar-bar" style={{ width: '92%', '--bar-color': 'var(--red)' } as React.CSSProperties} />
          </div>
          <span className="mono ar-val red">92%</span>
        </div>
        <div className="analysis-row">
          <span className="mono ar-label">lighting_delta</span>
          <div className="ar-bar-wrap">
            <div className="ar-bar" style={{ width: '61%', '--bar-color': 'var(--amber)' } as React.CSSProperties} />
          </div>
          <span className="mono ar-val amber">61%</span>
        </div>
        <div className="analysis-row">
          <span className="mono ar-label">compression_noise</span>
          <div className="ar-bar-wrap">
            <div className="ar-bar" style={{ width: '18%', '--bar-color': 'var(--green)' } as React.CSSProperties} />
          </div>
          <span className="mono ar-val green">18%</span>
        </div>
        <div className="analysis-row">
          <span className="mono ar-label">gan_signature</span>
          <div className="ar-bar-wrap">
            <div className="ar-bar" style={{ width: '88%', '--bar-color': 'var(--red)' } as React.CSSProperties} />
          </div>
          <span className="mono ar-val red">88%</span>
        </div>
      </div>

      <div className="analysis-card__verdict">
        <span className="tag tag-red">⚠ DEEPFAKE DETECTED</span>
        <span className="mono" style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>3.2s · claude-3.5 · hive-v2</span>
      </div>
    </div>
  );
}

/* ── Stat counter ───────────────────────────────────────── */
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-item">
      <span className="stat-value mono">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/* ── Feature card ───────────────────────────────────────── */
function FeatureCard({ index, title, desc, tag }: { index: string; title: string; desc: string; tag: string }) {
  return (
    <div className="feat-card">
      <span className="mono feat-index">{index}</span>
      <div className="feat-card__inner">
        <span className="tag tag-acid">{tag}</span>
        <h3 className="feat-title">{title}</h3>
        <p className="feat-desc">{desc}</p>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────── */
export default function LandingPage() {
  return (
    <div className="landing">
      <GridBg />

      {/* ── Nav ─────────────────────────────────────────── */}
      <nav className="landing-nav">
        <div className="nav-logo">
          <span className="nav-logo__mark" aria-hidden="true">◈</span>
          <span className="nav-logo__text">TruthShield</span>
          <span className="tag tag-acid" style={{ fontSize: '10px' }}>BETA</span>
        </div>
        <div className="nav-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
        </div>
        <div className="nav-actions">
          <Link to="/login" className="btn-ghost">Sign in</Link>
          <Link to="/login" className="btn-acid">Start free →</Link>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────── */}
      <section className="hero">
        <div className="hero-eyebrow">
          <span className="tag tag-acid">
            <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--acid)', animation: 'pulse 2s infinite' }} />
            LIVE DETECTION ENGINE
          </span>
        </div>

        <h1 className="hero-heading">
          The truth is<br />
          <em className="hero-heading__em">verifiable.</em>
        </h1>

        <p className="hero-sub">
          Multimodal AI forensics for deepfakes, misinformation, and stolen content.
          Built for teams that can't afford to be wrong.
        </p>

        <div className="hero-cta">
          <Link to="/login" className="btn-acid btn-acid--lg">Run a scan →</Link>
          <a href="#how-it-works" className="btn-ghost btn-ghost--lg">See how it works</a>
        </div>

        <div className="hero-stats">
          <Stat value="99.1%" label="Detection accuracy" />
          <div className="stat-sep" />
          <Stat value="3.2s" label="Avg analysis time" />
          <div className="stat-sep" />
          <Stat value="50MB" label="Max file size" />
          <div className="stat-sep" />
          <Stat value="6" label="AI models fused" />
        </div>
      </section>

      {/* ── Ticker ──────────────────────────────────────── */}
      <Ticker />

      {/* ── Visual demo ─────────────────────────────────── */}
      <section className="demo-section" id="how-it-works">
        <div className="demo-layout">
          <div className="demo-text">
            <span className="tag tag-acid">FORENSIC ENGINE</span>
            <h2 className="demo-heading">
              Every pixel.<br />Every claim.<br />Verified.
            </h2>
            <p className="demo-para">
              Upload any image, video, or paste a text claim. Our multi-model pipeline runs
              facial artifact detection, GAN signature analysis, error-level analysis, and
              cross-source fact checking — simultaneously.
            </p>
            <ul className="demo-checklist">
              {['Hive Moderation + AWS Rekognition fusion', 'Claude 3.5 for semantic fact-checking', 'EXIF & metadata forensics', 'Perceptual hash for stolen content'].map(item => (
                <li key={item}>
                  <span className="check-icon">✓</span>
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="demo-card-wrap">
            <AnalysisCard />
          </div>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────── */}
      <section className="features-section" id="features">
        <div className="features-header">
          <span className="tag tag-acid">CAPABILITIES</span>
          <h2 className="features-heading">One platform. Every threat.</h2>
        </div>
        <div className="features-grid">
          <FeatureCard index="01" tag="IMAGE · VIDEO" title="Deepfake Detection" desc="Multi-model AI scans for facial artifacts, GAN signatures, lighting inconsistencies and compression noise." />
          <FeatureCard index="02" tag="TEXT · URL" title="Fact Verification" desc="Cross-reference claims against thousands of verified news sources using Claude + Google Fact Check API." />
          <FeatureCard index="03" tag="HASH · DMCA" title="Stolen Content Radar" desc="Perceptual hash matching identifies copied or reposted media across the open web. Auto-generate DMCA notices." />
          <FeatureCard index="04" tag="WEBHOOK · EMAIL" title="Real-time Alerts" desc="Get notified the moment dangerous content is detected. Webhooks, Slack, and email — all configurable." />
          <FeatureCard index="05" tag="REST API" title="API Integration" desc="Embed our forensics engine directly into your platform. Rate-limited, key-authenticated, fully documented." />
          <FeatureCard index="06" tag="PDF · JSON" title="Forensic Reports" desc="Auto-generated reports with confidence scores, evidence breakdown, and recommended actions." />
        </div>
      </section>

      {/* ── Pricing ────────────────────────────────────────── */}
      <section className="pricing-section" id="pricing">
        <div className="features-header">
          <span className="tag tag-acid">TIERS & PLANS</span>
          <h2 className="features-heading">Simple, predictable pricing.</h2>
        </div>
        <div className="pricing-grid">
          
          <div className="pricing-card">
            <div className="pricing-card__header">
              <span className="mono plan-name">free_analyst</span>
              <p className="plan-price">$0<span className="plan-period">/mo</span></p>
              <p className="plan-desc">For individual researchers and journalists starting out.</p>
            </div>
            <ul className="plan-features">
              <li>10 scans / day limit</li>
              <li>Standard queue priority</li>
              <li>Core Deepfake & GAN checks</li>
            </ul>
            <Link to="/login" className="btn-ghost" style={{ width: '100%', textAlign: 'center', marginTop: 'auto' }}>
              Access Console
            </Link>
          </div>

          <div className="pricing-card featured">
            <div className="pricing-card__header">
              <span className="mono plan-name" style={{ color: 'var(--acid)' }}>pro_investigator</span>
              <p className="plan-price">$89<span className="plan-period">/mo</span></p>
              <p className="plan-desc">For active investigators and fast-paced digital newsrooms.</p>
            </div>
            <ul className="plan-features">
              <li>1,000 scans / day limit</li>
              <li>Priority processing queue</li>
              <li>Advanced EXIF & metadata forensics</li>
              <li>Downloadable PDF audit reports</li>
            </ul>
            <Link to="/login" className="btn-acid" style={{ width: '100%', textAlign: 'center', marginTop: 'auto' }}>
              Upgrade Workspace
            </Link>
          </div>

          <div className="pricing-card">
            <div className="pricing-card__header">
              <span className="mono plan-name">enterprise_newsroom</span>
              <p className="plan-price">Custom</p>
              <p className="plan-desc">For large networks requiring bulk processing and custom SLAs.</p>
            </div>
            <ul className="plan-features">
              <li>Unlimited scans / API queries</li>
              <li>Dedicated custom inference hosts</li>
              <li>Full Webhook & Slack integration</li>
              <li>24/7 dedicated engineering support</li>
            </ul>
            <Link to="/login" className="btn-ghost" style={{ width: '100%', textAlign: 'center', marginTop: 'auto' }}>
              Contact Team
            </Link>
          </div>

        </div>
      </section>

      {/* ── CTA Band ────────────────────────────────────── */}
      <section className="cta-band">
        <div className="cta-band__inner">
          <div>
            <h2 className="cta-heading">Don't publish.<br />Verify first.</h2>
            <p className="cta-sub">Free to start. No credit card required.</p>
          </div>
          <Link to="/login" className="btn-acid btn-acid--lg">Open the dashboard →</Link>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────── */}
      <footer className="landing-footer">
        <span className="mono" style={{ color: 'var(--text-dim)', fontSize: '12px' }}>
          © 2026 TruthShield AI · Built to protect the information layer
        </span>
      </footer>
    </div>
  );
}
