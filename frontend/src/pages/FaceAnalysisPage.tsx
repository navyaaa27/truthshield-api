import React, { useState, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import api from "../lib/api";
import { useNavigate } from "react-router-dom";
import "./FaceAnalysisPage.css";

const EASE = { duration: 0.3, ease: [0.16, 1, 0.3, 1] as const };

interface AnalysisResult {
  prediction: "real" | "fake";
  scores: { fake: number; real: number };
  confidence: number;
  disclaimer: string;
}

const IconCamera = () => (
  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

const IconArrowLeft = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M19 12H5" /><polyline points="12 19 5 12 12 5" />
  </svg>
);

const IconShield = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
);

export default function FaceAnalysisPage() {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const handleFile = useCallback((file: File) => {
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setError("Only JPEG, PNG, or WebP images are accepted.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Image must be under 5 MB.");
      return;
    }
    setError(null);
    setResult(null);
    setSelectedFile(file);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleFile(e.target.files[0]);
  };

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragging(false);
      if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
    },
    [handleFile]
  );

  const onAnalyze = async () => {
    if (!selectedFile) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const form = new FormData();
      form.append("image", selectedFile);

      const { data } = await api.post("/face-analysis", form, {
        headers: { "Content-Type": "multipart/form-data" },
      });

      setResult(data.data);
    } catch (err: any) {
      const msg =
        err?.response?.data?.error?.message ||
        err?.response?.data?.message ||
        err?.message ||
        "Analysis failed. Please try again.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const confidencePct = result ? Math.round(result.confidence * 100) : 0;
  const isReal = result?.prediction === "real";

  return (
    <div className="fa-page">
      {/* Header */}
      <header className="fa-header">
        <button className="fa-back-btn" onClick={() => navigate("/dashboard")}>
          <IconArrowLeft /> Back to Dashboard
        </button>
        <div className="fa-header__brand">
          <IconShield />
          <span className="mono">face_analysis</span>
        </div>
      </header>

      <main className="fa-main">
        {/* Title */}
        <div className="fa-title-block">
          <h1 className="fa-title">
            <span className="fa-title-accent">AI Face</span> Authenticity Check
          </h1>
          <p className="fa-subtitle">
            Upload a portrait image to get an experimental real / fake estimate from our ResNet18 model.
          </p>
          <div className="fa-warning-badge">
            <span>⚠</span> Experimental — not a definitive verdict. Does not apply to videos.
          </div>
        </div>

        <div className="fa-grid">
          {/* Upload Panel */}
          <div className="fa-card">
            <h2 className="fa-card__title mono">01 / upload_image</h2>

            {/* Drop zone */}
            <div
              className={`fa-dropzone${dragging ? " fa-dropzone--dragging" : ""}${previewUrl ? " fa-dropzone--has-image" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              {previewUrl ? (
                <img src={previewUrl} alt="Preview" className="fa-preview-img" />
              ) : (
                <>
                  <div className="fa-dropzone__icon"><IconCamera /></div>
                  <p className="fa-dropzone__text">
                    Drop an image here or <span className="fa-link">browse</span>
                  </p>
                  <p className="fa-dropzone__hint">JPEG · PNG · WebP · max 5 MB</p>
                </>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={onFileChange}
              style={{ display: "none" }}
            />

            {selectedFile && (
              <div className="fa-file-info mono">
                <span>{selectedFile.name}</span>
                <span>{(selectedFile.size / 1024).toFixed(1)} KB</span>
              </div>
            )}

            <div className="fa-actions">
              {previewUrl && (
                <button
                  className="fa-btn-ghost"
                  onClick={() => {
                    setSelectedFile(null);
                    setPreviewUrl(null);
                    setResult(null);
                    setError(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Clear
                </button>
              )}
              <button
                className="fa-btn-primary"
                onClick={onAnalyze}
                disabled={!selectedFile || loading}
              >
                {loading ? (
                  <>
                    <span className="fa-spinner" />
                    Analyzing...
                  </>
                ) : (
                  "Run Analysis"
                )}
              </button>
            </div>

            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div
                  className="fa-error"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={EASE}
                >
                  <span className="mono">ERR</span> {error}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Result Panel */}
          <div className="fa-card">
            <h2 className="fa-card__title mono">02 / analysis_result</h2>

            <AnimatePresence mode="wait">
              {!result && !loading && (
                <motion.div
                  key="empty"
                  className="fa-empty-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={EASE}
                >
                  <div className="fa-empty-state__icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none"
                      stroke="currentColor" strokeWidth="1" strokeLinecap="round"
                      strokeLinejoin="round" style={{ opacity: 0.3 }}>
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <p className="fa-empty-state__text mono">awaiting_input</p>
                  <p className="fa-empty-state__sub">Upload an image and click Run Analysis</p>
                </motion.div>
              )}

              {loading && (
                <motion.div
                  key="loading"
                  className="fa-loading-state"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={EASE}
                >
                  <div className="fa-pulse-ring" />
                  <p className="mono">running_inference...</p>
                  <p className="fa-loading-hint">ResNet18 model processing image</p>
                </motion.div>
              )}

              {result && !loading && (
                <motion.div
                  key="result"
                  className="fa-result"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={EASE}
                >
                  {/* Verdict badge */}
                  <div className={`fa-verdict fa-verdict--${result.prediction}`}>
                    <span className="fa-verdict__label mono">
                      {result.prediction === "real" ? "✓ REAL" : "✗ FAKE"}
                    </span>
                    <span className="fa-verdict__conf">
                      {confidencePct}% confidence
                    </span>
                  </div>

                  {/* Confidence bar */}
                  <div className="fa-conf-section">
                    <span className="mono fa-conf-label">confidence</span>
                    <div className="fa-conf-track">
                      <motion.div
                        className={`fa-conf-fill fa-conf-fill--${result.prediction}`}
                        initial={{ width: 0 }}
                        animate={{ width: `${confidencePct}%` }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      />
                    </div>
                    <span className="mono fa-conf-pct">{confidencePct}%</span>
                  </div>

                  {/* Per-class scores */}
                  <div className="fa-scores">
                    <h3 className="mono fa-scores__title">per_class_scores</h3>
                    <div className="fa-scores__row">
                      <span className="fa-scores__label mono">real</span>
                      <div className="fa-conf-track fa-conf-track--sm">
                        <motion.div
                          className="fa-conf-fill fa-conf-fill--real"
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.round(result.scores.real * 100)}%` }}
                          transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
                        />
                      </div>
                      <span className="mono fa-scores__pct">
                        {Math.round(result.scores.real * 100)}%
                      </span>
                    </div>
                    <div className="fa-scores__row">
                      <span className="fa-scores__label mono">fake</span>
                      <div className="fa-conf-track fa-conf-track--sm">
                        <motion.div
                          className="fa-conf-fill fa-conf-fill--fake"
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.round(result.scores.fake * 100)}%` }}
                          transition={{ duration: 0.5, ease: "easeOut", delay: 0.2 }}
                        />
                      </div>
                      <span className="mono fa-scores__pct">
                        {Math.round(result.scores.fake * 100)}%
                      </span>
                    </div>
                  </div>

                  {/* Disclaimer */}
                  <div className="fa-disclaimer">
                    <span className="mono">disclaimer</span>
                    <p>{result.disclaimer}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </main>
    </div>
  );
}
