import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  motion,
  useInView,
  useScroll,
  useTransform,
  AnimatePresence,
} from "framer-motion";
import "./LandingPage.css";

/* ── Easing ─────────────────────────────────────────────── */
const EASE = [0.16, 1, 0.3, 1] as const;

/* ── Animated scan-line ticker ─────────────────────────── */
const TICKER_ITEMS = [
  "DEEPFAKE DETECTED · 94.2% CONFIDENCE",
  "FACT CHECK COMPLETE · SOURCE VERIFIED",
  "METADATA TAMPERING · EXIF MISMATCH",
  "VIDEO ANALYSIS · 847 FRAMES PROCESSED",
  "DMCA MATCH · 3 SOURCES IDENTIFIED",
  "AI-GENERATED IMAGE · GAN SIGNATURE FOUND",
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

/* ── Glitch Typewriter heading ─────────────────────────── */
const GLITCH_WORD = "verifiable.";

function GlitchTypewriter() {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);
  const charIdx = useRef(0);

  useEffect(() => {
    // Short delay before typing starts
    const start = setTimeout(() => {
      ref.current = setInterval(() => {
        charIdx.current += 1;
        setDisplayed(GLITCH_WORD.slice(0, charIdx.current));
        if (charIdx.current >= GLITCH_WORD.length) {
          clearInterval(ref.current!);
          setDone(true);
        }
      }, 60);
    }, 600);

    return () => {
      clearTimeout(start);
      if (ref.current) clearInterval(ref.current);
    };
  }, []);

  return (
    <em
      className={`hero-heading__em ${done ? "glitch" : ""}`}
      data-text={displayed}
    >
      {displayed}
      {!done && <span className="cursor-blink">|</span>}
    </em>
  );
}

/* ── Animated number counter ───────────────────────────── */
function AnimatedStat({ value, label }: { value: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });
  const numMatch = value.match(/^([\d.]+)(.*)$/);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!inView || !numMatch) return;
    const target = parseFloat(numMatch[1]);
    const duration = 1200;
    const start = performance.now();
    let raf: number;
    const animate = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 4); // ease-out-quart
      setCount(eased * target);
      if (t < 1) raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(raf);
  }, [inView, numMatch]);

  const formatted = numMatch
    ? `${parseFloat(count.toFixed(1))}${numMatch[2]}`
    : value;

  return (
    <div className="stat-item" ref={ref}>
      <span className="stat-value mono">{inView ? formatted : "0"}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

/* ── Floating parallax analysis card ──────────────────── */
function AnalysisCard() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start end", "end start"],
  });
  const y = useTransform(scrollYProgress, [0, 1], [40, -40]);
  const rotateX = useTransform(scrollYProgress, [0, 1], [4, -4]);

  return (
    <motion.div
      ref={ref}
      style={{ y, rotateX, transformPerspective: 800 }}
      className="analysis-card"
      initial={{ opacity: 0, y: 60, scale: 0.96 }}
      whileInView={{ opacity: 1, y: 0, scale: 1 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, ease: EASE }}
    >
      <div className="analysis-card__header">
        <span className="analysis-card__dot red" />
        <span className="analysis-card__dot amber" />
        <span className="analysis-card__dot green" />
        <span className="mono analysis-card__label">forensic_analysis.ts</span>
      </div>

      <div className="analysis-card__body">
        {[
          {
            label: "facial_artifacts",
            pct: 92,
            color: "var(--red)",
            cls: "red",
          },
          {
            label: "lighting_delta",
            pct: 61,
            color: "var(--amber)",
            cls: "amber",
          },
          {
            label: "compression_noise",
            pct: 18,
            color: "var(--green)",
            cls: "green",
          },
          { label: "gan_signature", pct: 88, color: "var(--red)", cls: "red" },
        ].map(({ label, pct, color, cls }) => (
          <div className="analysis-row" key={label}>
            <span className="mono ar-label">{label}</span>
            <div className="ar-bar-wrap">
              <div
                className="ar-bar"
                style={
                  {
                    width: `${pct}%`,
                    "--bar-color": color,
                  } as React.CSSProperties
                }
              />
            </div>
            <span className={`mono ar-val ${cls}`}>{pct}%</span>
          </div>
        ))}
      </div>

      <div className="analysis-card__verdict">
        <span className="tag tag-red">⚠ DEEPFAKE DETECTED</span>
        <span
          className="mono"
          style={{ color: "var(--text-secondary)", fontSize: "11px" }}
        >
          3.2s · claude-3.5 · hive-v2
        </span>
      </div>
    </motion.div>
  );
}

/* ── Scroll-reveal wrapper ─────────────────────────────── */
function Reveal({
  children,
  delay = 0,
  direction = "up",
}: {
  children: React.ReactNode;
  delay?: number;
  direction?: "up" | "left" | "right" | "none";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-80px" });

  const initial: Record<string, number> = { opacity: 0 };
  if (direction === "up") {
    initial.y = 40;
  }
  if (direction === "left") {
    initial.x = -40;
  }
  if (direction === "right") {
    initial.x = 40;
  }

  const animate = inView ? { opacity: 1, y: 0, x: 0 } : initial;

  return (
    <motion.div
      ref={ref}
      initial={initial}
      animate={animate}
      transition={{ duration: 0.6, ease: EASE, delay }}
    >
      {children}
    </motion.div>
  );
}

/* ── Feature card ───────────────────────────────────────── */
function FeatureCard({
  index,
  title,
  desc,
  tag,
  delay,
}: {
  index: string;
  title: string;
  desc: string;
  tag: string;
  delay: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      className="feat-card"
      initial={{ opacity: 0, y: 32 }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y: 32 }}
      transition={{ duration: 0.55, ease: EASE, delay }}
      whileHover={{ y: -4, transition: { duration: 0.2 } }}
    >
      <span className="mono feat-index">{index}</span>
      <div className="feat-card__inner">
        <span className="tag tag-acid">{tag}</span>
        <h3 className="feat-title">{title}</h3>
        <p className="feat-desc">{desc}</p>
      </div>
    </motion.div>
  );
}

/* ── Pricing card ───────────────────────────────────────── */
function PricingCard({
  name,
  price,
  period,
  desc,
  features,
  cta,
  featured,
  delay,
}: {
  name: string;
  price: string;
  period?: string;
  desc: string;
  features: string[];
  cta: string;
  featured?: boolean;
  delay: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-60px" });

  return (
    <motion.div
      ref={ref}
      className={`pricing-card ${featured ? "featured" : ""}`}
      initial={{ opacity: 0, y: 40, scale: 0.97 }}
      animate={
        inView
          ? { opacity: 1, y: 0, scale: 1 }
          : { opacity: 0, y: 40, scale: 0.97 }
      }
      transition={{ duration: 0.6, ease: EASE, delay }}
      whileHover={{ y: featured ? -6 : -4, transition: { duration: 0.2 } }}
    >
      <div className="pricing-card__header">
        <span
          className="mono plan-name"
          style={featured ? { color: "var(--acid)" } : undefined}
        >
          {name}
        </span>
        <p className="plan-price">
          {price}
          {period && <span className="plan-period">{period}</span>}
        </p>
        <p className="plan-desc">{desc}</p>
      </div>
      <ul className="plan-features">
        {features.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
      <Link
        to="/login"
        className={featured ? "btn-acid" : "btn-ghost"}
        style={{ width: "100%", textAlign: "center", marginTop: "auto" }}
      >
        {cta}
      </Link>
    </motion.div>
  );
}

/* ── Page ───────────────────────────────────────────────── */
export default function LandingPage() {
  return (
    <AnimatePresence>
      <motion.div
        className="landing"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      >
        <GridBg />

        {/* ── Nav ─────────────────────────────────────────── */}
        <motion.nav
          className="landing-nav"
          initial={{ y: -60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.5, ease: EASE, delay: 0.05 }}
        >
          <div className="nav-logo">
            <span className="nav-logo__mark" aria-hidden="true">
              ◈
            </span>
            <span className="nav-logo__text">TruthShield</span>
            <span className="tag tag-acid" style={{ fontSize: "10px" }}>
              BETA
            </span>
          </div>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How it works</a>
          </div>
          <div className="nav-actions">
            <Link to="/login" className="btn-ghost">
              Sign in
            </Link>
            <Link to="/login" className="btn-acid">
              Start free →
            </Link>
          </div>
        </motion.nav>

        {/* ── Hero ────────────────────────────────────────── */}
        <section className="hero">
          <motion.div
            className="hero-eyebrow"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE, delay: 0.15 }}
          >
            <span className="tag tag-acid">
              <span
                style={{
                  display: "inline-block",
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: "var(--acid)",
                  animation: "pulse 2s infinite",
                }}
              />
              LIVE DETECTION ENGINE
            </span>
          </motion.div>

          <motion.h1
            className="hero-heading"
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.65, ease: EASE, delay: 0.25 }}
          >
            The truth is
            <br />
            <GlitchTypewriter />
          </motion.h1>

          <motion.p
            className="hero-sub"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.4 }}
          >
            Multimodal AI forensics for deepfakes, misinformation, and stolen
            content. Built for teams that can't afford to be wrong.
          </motion.p>

          <motion.div
            className="hero-cta"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.5 }}
          >
            <Link to="/login" className="btn-acid btn-acid--lg">
              Run a scan →
            </Link>
            <a href="#how-it-works" className="btn-ghost btn-ghost--lg">
              See how it works
            </a>
          </motion.div>

          <motion.div
            className="hero-stats"
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE, delay: 0.65 }}
          >
            <AnimatedStat value="99.1%" label="Detection accuracy" />
            <div className="stat-sep" />
            <AnimatedStat value="3.2s" label="Avg analysis time" />
            <div className="stat-sep" />
            <AnimatedStat value="50MB" label="Max file size" />
            <div className="stat-sep" />
            <AnimatedStat value="6" label="AI models fused" />
          </motion.div>
        </section>

        {/* ── Ticker ──────────────────────────────────────── */}
        <Ticker />

        {/* ── Visual demo ─────────────────────────────────── */}
        <section className="demo-section" id="how-it-works">
          <div className="demo-layout">
            <div className="demo-text">
              <Reveal direction="left">
                <span className="tag tag-acid">FORENSIC ENGINE</span>
              </Reveal>
              <Reveal direction="left" delay={0.08}>
                <h2 className="demo-heading">
                  Every pixel.
                  <br />
                  Every claim.
                  <br />
                  Verified.
                </h2>
              </Reveal>
              <Reveal direction="left" delay={0.15}>
                <p className="demo-para">
                  Upload any image, video, or paste a text claim. Our
                  multi-model pipeline runs facial artifact detection, GAN
                  signature analysis, error-level analysis, and cross-source
                  fact checking — simultaneously.
                </p>
              </Reveal>
              <Reveal direction="left" delay={0.22}>
                <ul className="demo-checklist">
                  {[
                    "Hive Moderation + AWS Rekognition fusion",
                    "Claude 3.5 for semantic fact-checking",
                    "EXIF & metadata forensics",
                    "Perceptual hash for stolen content",
                  ].map((item, i) => (
                    <motion.li
                      key={item}
                      initial={{ opacity: 0, x: -20 }}
                      whileInView={{ opacity: 1, x: 0 }}
                      viewport={{ once: true }}
                      transition={{
                        duration: 0.4,
                        ease: EASE,
                        delay: 0.28 + i * 0.07,
                      }}
                    >
                      <span className="check-icon">✓</span>
                      {item}
                    </motion.li>
                  ))}
                </ul>
              </Reveal>
            </div>
            <div className="demo-card-wrap">
              <AnalysisCard />
            </div>
          </div>
        </section>

        {/* ── Features ────────────────────────────────────── */}
        <section className="features-section" id="features">
          <div className="features-header">
            <Reveal>
              <span className="tag tag-acid">CAPABILITIES</span>
            </Reveal>
            <Reveal delay={0.08}>
              <h2 className="features-heading">One platform. Every threat.</h2>
            </Reveal>
          </div>
          <div className="features-grid">
            <FeatureCard
              delay={0}
              index="01"
              tag="IMAGE · VIDEO"
              title="Deepfake Detection"
              desc="Multi-model AI scans for facial artifacts, GAN signatures, lighting inconsistencies and compression noise."
            />
            <FeatureCard
              delay={0.07}
              index="02"
              tag="TEXT · URL"
              title="Fact Verification"
              desc="Cross-reference claims against thousands of verified news sources using Claude + Google Fact Check API."
            />
            <FeatureCard
              delay={0.14}
              index="03"
              tag="HASH · DMCA"
              title="Stolen Content Radar"
              desc="Perceptual hash matching identifies copied or reposted media across the open web. Auto-generate DMCA notices."
            />
            <FeatureCard
              delay={0.21}
              index="04"
              tag="WEBHOOK · EMAIL"
              title="Real-time Alerts"
              desc="Get notified the moment dangerous content is detected. Webhooks, Slack, and email — all configurable."
            />
            <FeatureCard
              delay={0.28}
              index="05"
              tag="REST API"
              title="API Integration"
              desc="Embed our forensics engine directly into your platform. Rate-limited, key-authenticated, fully documented."
            />
            <FeatureCard
              delay={0.35}
              index="06"
              tag="PDF · JSON"
              title="Forensic Reports"
              desc="Auto-generated reports with confidence scores, evidence breakdown, and recommended actions."
            />
          </div>
        </section>

        {/* ── Pricing ────────────────────────────────────────── */}
        <section className="pricing-section" id="pricing">
          <div className="features-header">
            <Reveal>
              <span className="tag tag-acid">TIERS &amp; PLANS</span>
            </Reveal>
            <Reveal delay={0.08}>
              <h2 className="features-heading">Simple, predictable pricing.</h2>
            </Reveal>
          </div>
          <div className="pricing-grid">
            <PricingCard
              delay={0}
              name="free_analyst"
              price="$0"
              period="/mo"
              desc="For individual researchers and journalists starting out."
              features={[
                "10 scans / day limit",
                "Standard queue priority",
                "Core Deepfake & GAN checks",
              ]}
              cta="Access Console"
            />
            <PricingCard
              delay={0.1}
              name="pro_investigator"
              price="$89"
              period="/mo"
              desc="For active investigators and fast-paced digital newsrooms."
              features={[
                "1,000 scans / day limit",
                "Priority processing queue",
                "Advanced EXIF & metadata forensics",
                "Downloadable PDF audit reports",
              ]}
              cta="Upgrade Workspace"
              featured
            />
            <PricingCard
              delay={0.2}
              name="enterprise_newsroom"
              price="Custom"
              desc="For large networks requiring bulk processing and custom SLAs."
              features={[
                "Unlimited scans / API queries",
                "Dedicated custom inference hosts",
                "Full Webhook & Slack integration",
                "24/7 dedicated engineering support",
              ]}
              cta="Contact Team"
            />
          </div>
        </section>

        {/* ── CTA Band ────────────────────────────────────── */}
        <section className="cta-band">
          <Reveal direction="none">
            <div className="cta-band__inner">
              <div>
                <h2 className="cta-heading">
                  Don't publish.
                  <br />
                  Verify first.
                </h2>
                <p className="cta-sub">
                  Free to start. No credit card required.
                </p>
              </div>
              <motion.div
                whileHover={{ scale: 1.04 }}
                transition={{ duration: 0.2 }}
              >
                <Link to="/login" className="btn-acid btn-acid--lg">
                  Open the dashboard →
                </Link>
              </motion.div>
            </div>
          </Reveal>
        </section>

        {/* ── Footer ──────────────────────────────────────── */}
        <footer className="landing-footer">
          <span
            className="mono"
            style={{ color: "var(--text-dim)", fontSize: "12px" }}
          >
            © 2026 TruthShield AI · Built to protect the information layer
          </span>
        </footer>
      </motion.div>
    </AnimatePresence>
  );
}
