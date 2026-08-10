import React, { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from 'framer-motion';
import { useAuth } from '../context/AuthContext';
import api from '../lib/api';
import './LoginPage.css';

/* ── Easing ─────────────────────────────────────────────── */
const SPRING = { type: 'spring' as const, stiffness: 380, damping: 30 };
const EASE   = { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const };

/* ── Live feed ──────────────────────────────────────────── */
const FEED_EVENTS = [
  { tag: 'DEEPFAKE',  color: 'red',   msg: 'facial artifact detected · confidence 94.2%' },
  { tag: 'VERIFIED',  color: 'green', msg: 'claim cross-referenced · 12 sources match' },
  { tag: 'DMCA',      color: 'amber', msg: 'stolen content · 3 upstream sources found' },
  { tag: 'GAN',       color: 'red',   msg: 'GAN signature present · midjourney v6' },
  { tag: 'METADATA',  color: 'amber', msg: 'EXIF timestamp mismatch · 47 days delta' },
  { tag: 'VERIFIED',  color: 'green', msg: 'video authentic · 2,048 frames clean' },
  { tag: 'DEEPFAKE',  color: 'red',   msg: 'lip-sync anomaly detected · frame 0312' },
  { tag: 'CLAIM',     color: 'amber', msg: 'partially false · 2 of 5 claims unverified' },
  { tag: 'PHASH',     color: 'green', msg: 'no duplicates found · unique content' },
  { tag: 'DEEPFAKE',  color: 'red',   msg: 'lighting inconsistency · right facial plane' },
  { tag: 'VERIFIED',  color: 'green', msg: 'journalist source verified · reuters' },
  { tag: 'ALERT',     color: 'red',   msg: 'high-severity · escalated to review queue' },
];

/* ── Animated stat counter ──────────────────────────────── */
function AnimatedCount({ target }: { target: number }) {
  const count = useMotionValue(0);
  const rounded = useTransform(count, v => Math.round(v));
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const unsub = rounded.on('change', v => setDisplay(v));
    const ctrl = animate(count, target, { duration: 2, ease: 'easeOut' });
    return () => { ctrl.stop(); unsub(); };
  }, [target]);

  return <>{display}</>;
}

/* ── Live feed component ────────────────────────────────── */
function LiveFeed() {
  const [items, setItems] = useState<(typeof FEED_EVENTS[0] & { id: number })[]>([]);
  const counterRef = useRef(0);
  const idRef = useRef(0);

  useEffect(() => {
    const seed = FEED_EVENTS.slice(0, 4).map(e => ({ ...e, id: idRef.current++ }));
    setItems(seed);
    counterRef.current = 4;

    const iv = setInterval(() => {
      const next = { ...FEED_EVENTS[counterRef.current % FEED_EVENTS.length], id: idRef.current++ };
      counterRef.current++;
      setItems(prev => [...prev.slice(-11), next]);
    }, 1800);
    return () => clearInterval(iv);
  }, []);

  const ts = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
  };

  return (
    <div className="lp-feed">
      <AnimatePresence initial={false}>
        {items.map(item => (
          <motion.div
            key={item.id}
            className="lp-feed__row"
            initial={{ opacity: 0, x: -12, height: 0 }}
            animate={{ opacity: 1, x: 0, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <span className="mono lp-feed__ts">{ts()}</span>
            <span className={`tag tag-${item.color} lp-feed__tag`}>{item.tag}</span>
            <span className="lp-feed__msg">{item.msg}</span>
          </motion.div>
        ))}
      </AnimatePresence>
      <div className="lp-feed__cursor" />
    </div>
  );
}

/* ── Scanline sweep ─────────────────────────────────────── */
function ScanLine() {
  return (
    <motion.div
      className="lp-scanline"
      initial={{ top: '-2%' }}
      animate={{ top: '102%' }}
      transition={{ duration: 4, ease: 'linear', repeat: Infinity, repeatDelay: 3 }}
    />
  );
}

/* ── Field with stagger ─────────────────────────────────── */
const FieldVariants = {
  hidden: { opacity: 0, y: 14 },
  show:   { opacity: 1, y: 0, transition: EASE },
  exit:   { opacity: 0, y: -10, transition: { duration: 0.14 } },
};

function Field({
  id, label, type, placeholder, value, onChange, autoComplete,
}: {
  id: string; label: string; type: string; placeholder: string;
  value: string; onChange: (v: string) => void; autoComplete?: string;
}) {
  return (
    <motion.div className="lp-field" variants={FieldVariants}>
      <label htmlFor={id} className="mono lp-label">{label}</label>
      <input
        id={id}
        className="lp-input"
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
        required
        autoComplete={autoComplete}
      />
    </motion.div>
  );
}

/* ── Page ───────────────────────────────────────────────── */
type Mode = 'login' | 'register';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [name, setName]         = useState('');
  const [orgName, setOrgName]   = useState('');
  const [error, setError]       = useState('');
  const [loading, setLoading]   = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const switchMode = (m: Mode) => {
    setMode(m);
    setError('');
    setEmail(''); setPassword(''); setName(''); setOrgName('');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        await api.post('/auth/register', { name, email, password, orgName });
        await login(email, password);
      }
      navigate('/dashboard');
    } catch (err: any) {
      if (!err?.response) {
        setError('Cannot reach the server. Make sure the API is running on localhost:3000.');
      } else {
        const valError = err.response.data?.errors?.[0]?.msg;
        setError(valError || err.response.data?.message || 'Authentication failed. Check your credentials.');
      }
    } finally {
      setLoading(false);
    }
  };

  const loginFields = (
    <motion.div
      key="login-fields"
      className="lp-fields-wrap"
      variants={{ show: { transition: { staggerChildren: 0.07 } } }}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <Field id="email-l" label="email_address" type="email"
        placeholder="you@example.com" value={email} onChange={setEmail} autoComplete="email" />
      <Field id="password-l" label="password" type="password"
        placeholder="min. 8 characters" value={password} onChange={setPassword} autoComplete="current-password" />
    </motion.div>
  );

  const registerFields = (
    <motion.div
      key="register-fields"
      className="lp-fields-wrap"
      variants={{ show: { transition: { staggerChildren: 0.07 } } }}
      initial="hidden"
      animate="show"
      exit="exit"
    >
      <Field id="name-r" label="full_name" type="text"
        placeholder="Jane Smith" value={name} onChange={setName} autoComplete="name" />
      <Field id="org-r" label="organization" type="text"
        placeholder="Newsroom / Company" value={orgName} onChange={setOrgName} autoComplete="organization" />
      <Field id="email-r" label="email_address" type="email"
        placeholder="you@example.com" value={email} onChange={setEmail} autoComplete="email" />
      <Field id="password-r" label="password" type="password"
        placeholder="min. 8 chars (A-Z, 0-9, symbol)" value={password} onChange={setPassword} autoComplete="new-password" />
    </motion.div>
  );

  return (
    <div className="login-page">

      {/* ── Left panel ─────────────────────────────────── */}
      <motion.div
        className="lp-left"
        initial={{ opacity: 0, x: -30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <ScanLine />

        <div className="lp-left__top">
          <Link to="/" className="lp-back">← Back</Link>
          <motion.div
            className="lp-brand"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, ...EASE }}
          >
            <span className="lp-brand__mark">◈</span>
            <span className="lp-brand__name">TruthShield</span>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.25, ...EASE }}
          >
            <h1 className="lp-headline">Every second,<br />the engine runs.</h1>
            <p className="lp-subline">Live detections from the global scan queue.</p>
          </motion.div>
        </div>

        {/* Stats row */}
        <motion.div
          className="lp-stats-row"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.35, duration: 0.4 }}
        >
          {[
            { val: 12847, suffix: '', label: 'scans today' },
            { val: 99,    suffix: '.1%', label: 'accuracy' },
            { val: 3,     suffix: '.2s', label: 'avg latency' },
          ].map(s => (
            <div key={s.label} className="lp-stat">
              <span className="mono lp-stat__val">
                <AnimatedCount target={s.val} />{s.suffix}
              </span>
              <span className="lp-stat__label">{s.label}</span>
            </div>
          ))}
        </motion.div>

        <motion.div
          className="lp-terminal"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, ...EASE }}
        >
          <div className="lp-terminal__bar">
            <span className="lp-terminal__dot red" />
            <span className="lp-terminal__dot amber" />
            <span className="lp-terminal__dot green" />
            <span className="mono lp-terminal__label">scan_queue.live</span>
            <span className="lp-terminal__pill">
              <motion.span
                className="lp-pulse"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 1.4, repeat: Infinity }}
              />
              LIVE
            </span>
          </div>
          <LiveFeed />
        </motion.div>
      </motion.div>

      {/* ── Right panel ────────────────────────────────── */}
      <motion.div
        className="lp-right"
        initial={{ opacity: 0, x: 30 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="lp-form-wrap">

          {/* Tab switcher with sliding indicator */}
          <div className="lp-tabs">
            {(['login', 'register'] as Mode[]).map(m => (
              <button
                key={m}
                id={`tab-${m}`}
                className={`lp-tab ${mode === m ? 'active' : ''}`}
                onClick={() => switchMode(m)}
              >
                {mode === m && (
                  <motion.span
                    className="lp-tab__indicator"
                    layoutId="tab-indicator"
                    transition={SPRING}
                  />
                )}
                <span className="lp-tab__text">
                  {m === 'login' ? 'Sign in' : 'Create account'}
                </span>
              </button>
            ))}
          </div>

          {/* Header */}
          <AnimatePresence mode="wait">
            <motion.div
              key={mode + '-header'}
              className="lp-form-header"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={EASE}
            >
              <h2 className="lp-form-title">
                {mode === 'login' ? 'Access your dashboard' : 'Join TruthShield'}
              </h2>
              <p className="lp-form-sub">
                {mode === 'login'
                  ? 'Enter your credentials to continue.'
                  : 'Set up your workspace in seconds.'}
              </p>
            </motion.div>
          </AnimatePresence>

          {/* Form */}
          <form className="lp-form" onSubmit={handleSubmit} noValidate>
            <AnimatePresence mode="wait">
              {mode === 'login' ? loginFields : registerFields}
            </AnimatePresence>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  className="lp-error"
                  initial={{ opacity: 0, y: -8, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={EASE}
                >
                  <span className="mono">ERR</span> {error}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Submit */}
            <motion.button
              id="btn-submit"
              type="submit"
              className="lp-submit"
              disabled={loading}
              whileHover={{ scale: loading ? 1 : 1.015 }}
              whileTap={{ scale: loading ? 1 : 0.975 }}
              transition={SPRING}
            >
              {loading
                ? <span className="lp-submit__loader" />
                : mode === 'login' ? 'Sign in →' : 'Create account →'}
            </motion.button>
          </form>

          <p className="lp-terms">
            By continuing you agree to our{' '}
            <a href="#" className="lp-link">Terms</a> and{' '}
            <a href="#" className="lp-link">Privacy Policy</a>.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
