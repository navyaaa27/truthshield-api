import React from 'react';
import { Link } from 'react-router-dom';
import { Shield, ShieldAlert, FileSearch, Fingerprint } from 'lucide-react';
import Silk from '../components/Silk';
import './LandingPage.css';

function LandingPage() {
  return (
    <div className="landing-container">
      {/* Background Animation */}
      <div className="silk-background">
        <Silk
          speed={5}
          scale={1}
          color="#7C3AED"
          noiseIntensity={1.5}
          rotation={0}
        />
      </div>

      <div className="content-wrapper">
        {/* Navigation */}
        <nav className="navbar">
          <div className="logo">
            <Shield className="logo-icon" size={28} />
            <span>TruthShield AI</span>
          </div>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#api">API</a>
          </div>
          <div className="nav-actions">
            <Link to="/login" className="btn-login">Log in / Sign up</Link>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="hero-section">
          <div className="hero-badge">
            <ShieldAlert size={16} />
            <span>Enterprise-grade deepfake detection</span>
          </div>
          <h1 className="hero-title">
            Verify the truth<br />instantly.
          </h1>
          <p className="hero-subtitle">
            Detect deepfakes, fact-check claims, and uncover media tampering in real-time. 
            The world's most powerful AI forensic engine.
          </p>
          <div className="hero-actions">
            <Link to="/login" className="btn-primary">
              Start Scanning
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14"></path><path d="m12 5 7 7-7 7"></path></svg>
            </Link>
          </div>
        </section>

        {/* Floating UI Mockups Area */}
        <section className="mockup-section">
          <div className="mockup-card card-left">
            <div className="card-header">
              <span className="dot green"></span>
              Media Uploaded
            </div>
            <div className="card-body">Analyzing pixel forensics...</div>
          </div>
          
          <div className="mockup-card card-center">
            <div className="card-header">
              <span className="dot red"></span>
              Tampering Detected
            </div>
            <div className="card-body">
              <div className="progress-bar">
                <div className="progress fill-red" style={{ width: '85%' }}></div>
              </div>
              <span className="confidence">85% AI Confidence</span>
            </div>
          </div>

          <div className="mockup-card card-right">
            <div className="card-header">
              <span className="dot green"></span>
              Fact-check verified
            </div>
            <div className="card-body">Sources confirm the statement is accurate.</div>
          </div>
        </section>

        {/* Features Staggered Section */}
        <section id="features" className="features-section">
          <div className="feature-row">
            <div className="feature-text">
              <div className="feature-pill">Deepfake Detection</div>
              <h2>Instant AI Verification</h2>
              <p>
                Upload any image or video. Our multi-model forensic AI scans the pixel data, 
                error-level analysis, and lighting inconsistencies to determine authenticity.
              </p>
              <ul className="feature-checks">
                <li>✓ Tailored to image & video</li>
                <li>✓ Real-time analysis</li>
              </ul>
            </div>
            <div className="feature-visual">
              <div className="glass-panel">
                <div className="analysis-row">
                  <span>Facial Artifacts</span>
                  <div className="bar-bg"><div className="bar-fill red" style={{ width: '92%' }}></div></div>
                </div>
                <div className="analysis-row">
                  <span>Lighting Inconsistency</span>
                  <div className="bar-bg"><div className="bar-fill yellow" style={{ width: '60%' }}></div></div>
                </div>
                <div className="analysis-row">
                  <span>Compression Noise</span>
                  <div className="bar-bg"><div className="bar-fill green" style={{ width: '20%' }}></div></div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Grid Features */}
        <section id="api" className="grid-features-section">
          <div className="grid-header">
            <div className="feature-pill">API Integration</div>
            <h2>Protect your digital truth</h2>
            <p>Integrate our engine directly into your platform and automate moderation.</p>
          </div>
          
          <div className="features-grid">
            <div className="grid-card">
              <FileSearch className="grid-icon text-blue" />
              <h3>Forensic Reports</h3>
              <p>Get detailed PDF and JSON reports breaking down why media was flagged.</p>
            </div>
            <div className="grid-card">
              <ShieldAlert className="grid-icon text-red" />
              <h3>Real-time Alerts</h3>
              <p>Receive webhook notifications instantly when dangerous content is detected.</p>
            </div>
            <div className="grid-card">
              <Fingerprint className="grid-icon text-purple" />
              <h3>Identity Protection</h3>
              <p>Scan for known malicious deepfake actors using cross-referenced databases.</p>
            </div>
            <div className="grid-card">
              <Shield className="grid-icon text-green" />
              <h3>Text Fact-Checking</h3>
              <p>Automatically verify textual claims against thousands of verified news sources.</p>
            </div>
          </div>
        </section>
        
        {/* Footer */}
        <footer className="footer">
          <p>© 2026 TruthShield AI. All rights reserved.</p>
        </footer>
      </div>
    </div>
  );
}

export default LandingPage;
