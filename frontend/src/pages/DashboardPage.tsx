import React, { useState, useEffect, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import api from "../lib/api";
import { motion, AnimatePresence } from "framer-motion";
import { io, Socket } from "socket.io-client";
import "./DashboardPage.css";

const IconFileText = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" y1="13" x2="8" y2="13" />
    <line x1="16" y1="17" x2="8" y2="17" />
    <polyline points="10 9 9 9 8 9" />
  </svg>
);

const IconTerminal = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
);

const IconSettings = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const IconBell = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
  </svg>
);

const IconLogOut = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

const IconUpload = () => (
  <svg
    width="32"
    height="32"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

/* ── Animation Configs ─────────────────────────────────────────────────── */
const EASE = { duration: 0.25, ease: [0.16, 1, 0.3, 1] as const };

/* ── Types ──────────────────────────────────────────────────────────────── */
type Tab = "scan" | "reports" | "alerts" | "settings";
type ScanType = "file" | "text";

interface Job {
  id: string;
  content_type: string;
  status: string;
  detection_modules: string[];
  source_url?: string;
  aggregated_score?: number | null;
  aggregated_verdict?: string | null;
  aggregated_risk_level?: string | null;
  created_at: string;
}

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
}

interface Alert {
  id: string;
  title: string;
  severity: "low" | "medium" | "high" | "critical";
  jobId: string;
  module: string;
  score: number;
  acknowledged_at?: string | null;
  resolved_at?: string | null;
}

export default function DashboardPage() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<Tab>("scan");
  const [scanType, setScanType] = useState<ScanType>("file");

  // Text Verification Form
  const [textClaim, setTextClaim] = useState("");
  const [textModules, setTextModules] = useState<string[]>([
    "deepfake",
    "fake_news",
  ]);
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<any>(null);

  // File Upload State
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileModules, setFileModules] = useState<string[]>([
    "deepfake",
    "metadata_tampering",
  ]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadStatus, setUploadStatus] = useState<
    "idle" | "uploading" | "processing" | "done"
  >("idle");
  const [fileVerdict, setFileVerdict] = useState<any>(null);

  // History & API Keys State
  const [jobs, setJobs] = useState<Job[]>([]);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [newKeyName, setNewKeyName] = useState("");
  const [generatedKey, setGeneratedKey] = useState<string | null>(null);

  // Subscription Billing State
  const [planTier, setPlanTier] = useState<"starter" | "pro">("starter");
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);

  // Real-time Alerts State
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [toastAlert, setToastAlert] = useState<Alert | null>(null);
  const socketRef = useRef<Socket | null>(null);

  // Modals / Details
  const [selectedJobDetail, setSelectedJobDetail] = useState<any>(null);

  /* ── WebSocket Setup ───────────────────────────────────── */
  useEffect(() => {
    const token = localStorage.getItem("ts_access_token");
    if (!token) return;

    const socket = io("http://localhost:3000", {
      auth: { token },
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[WebSocket] Connected successfully");
    });

    socket.on("alerts:unread_count", (data: { count: number }) => {
      setUnreadCount(data.count);
    });

    socket.on("alert:new", (data: Record<string, unknown>) => {
      const newAlert: Alert = {
        id: data.alertId as string,
        title: data.title as string,
        severity: data.severity as "high" | "critical" | "info",
        jobId: data.jobId as string,
        module: data.module as string,
        score: data.score as number,
        acknowledged_at: null,
        resolved_at: null,
      };

      setAlerts((prev) => [newAlert, ...prev]);
      setUnreadCount((c) => c + 1);
      setToastAlert(newAlert);

      setTimeout(() => {
        setToastAlert((t) => (t?.id === newAlert.id ? null : t));
      }, 6000);
    });

    socket.on(
      "alert:update",
      (data: { alertId: string; acknowledged: boolean; resolved: boolean }) => {
        setAlerts((prev) =>
          prev.map((a) => {
            if (a.id === data.alertId) {
              return {
                ...a,
                acknowledged_at: data.acknowledged
                  ? new Date().toISOString()
                  : null,
                resolved_at: data.resolved ? new Date().toISOString() : null,
              };
            }
            return a;
          }),
        );
        socket.emit("ping");
      },
    );

    return () => {
      socket.disconnect();
    };
  }, []);

  /* ── Tab Changes & Data Fetching ───────────────────────── */
  const fetchJobs = async () => {
    try {
      const res = await api.get("/jobs?limit=20");
      setJobs(res.data.jobs || []);
    } catch (err) {
      console.error("Error fetching jobs:", err);
    }
  };

  const fetchAlerts = async () => {
    try {
      const res = await api.get("/alerts?limit=20");
      const items = res.data.alerts || res.data || [];
      setAlerts(items);
    } catch (err) {
      console.error("Error fetching alerts:", err);
    }
  };

  const fetchApiKeys = async () => {
    try {
      const res = await api.get("/api-keys");
      setApiKeys(res.data || []);
    } catch (err) {
      console.error("Error fetching API keys:", err);
    }
  };

  useEffect(() => {
    if (activeTab === "reports") fetchJobs();
    if (activeTab === "alerts") fetchAlerts();
    if (activeTab === "settings") fetchApiKeys();
  }, [activeTab]);

  /* ── Alert Interaction Triggers ────────────────────────── */
  const handleAcknowledgeAlert = async (alertId: string) => {
    try {
      await api.patch(`/alerts/${alertId}/acknowledge`);
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, acknowledged_at: new Date().toISOString() }
            : a,
        ),
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (err) {
      console.error("Failed to acknowledge alert:", err);
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      await api.patch(`/alerts/${alertId}/resolve`);
      setAlerts((prev) =>
        prev.map((a) =>
          a.id === alertId
            ? { ...a, resolved_at: new Date().toISOString() }
            : a,
        ),
      );
    } catch (err) {
      console.error("Failed to resolve alert:", err);
    }
  };

  /* ── Handles Text Verification ─────────────────────────── */
  const handleTextVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textClaim.trim()) return;
    setVerifying(true);
    setVerdict(null);

    try {
      const res = await api.post("/jobs", {
        contentType: textClaim.startsWith("http") ? "url" : "article",
        detectionModules: textModules,
        sourceUrl: textClaim,
      });

      const jobId = res.data.job.id;

      let completed = false;
      let attempts = 0;
      while (!completed && attempts < 15) {
        await new Promise((r) => setTimeout(r, 1500));
        const check = await api.get(`/jobs/${jobId}`);
        const currentJob = check.data.job;

        if (
          currentJob.status === "completed" ||
          currentJob.status === "failed"
        ) {
          completed = true;
          setVerdict(check.data);
        }
        attempts++;
      }
    } catch (err: unknown) {
      console.error("Verification error:", err);
    } finally {
      setVerifying(false);
    }
  };

  /* ── Handles File Upload Simulation ─────────────────────── */
  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files?.[0]) {
      setSelectedFile(e.dataTransfer.files[0]);
    }
  };

  const triggerUpload = async () => {
    if (!selectedFile) return;
    setUploadStatus("uploading");
    setUploadProgress(0);
    setFileVerdict(null);

    const interval = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) {
          clearInterval(interval);
          setUploadStatus("processing");
          runFileSimulation();
          return 100;
        }
        return prev + 10;
      });
    }, 150);
  };

  const runFileSimulation = async () => {
    setTimeout(() => {
      setUploadStatus("done");

      const isSuspicious =
        selectedFile?.name.includes("fake") ||
        selectedFile?.name.includes("deep");
      const score = isSuspicious ? 89.4 : 12.8;
      const severity = isSuspicious ? "high" : "low";
      const statusText = isSuspicious ? "SUSPICIOUS" : "VERIFIED";

      setFileVerdict({
        job: {
          id: "sim_job_" + Math.random().toString(36).substring(4, 9),
          content_type: selectedFile?.type.includes("image")
            ? "image"
            : "video",
          status: "completed",
          detection_modules: fileModules,
          created_at: new Date().toISOString(),
        },
        aggregation: {
          aggregated_score: score,
          aggregated_verdict: statusText,
          aggregated_risk_level: severity,
          modules_succeeded: fileModules,
        },
      });

      if (isSuspicious) {
        const localAlert: Alert = {
          id: "sim_alert_" + Math.random().toString(36).substring(4, 9),
          title: `Deepfake signature found in ${selectedFile?.name}`,
          severity: "high",
          jobId: "sim_job_" + Math.random().toString(36).substring(4, 9),
          module: "deepfake",
          score: 89.4,
          acknowledged_at: null,
          resolved_at: null,
        };
        setAlerts((prev) => [localAlert, ...prev]);
        setUnreadCount((c) => c + 1);
        setToastAlert(localAlert);
        setTimeout(() => setToastAlert(null), 6000);
      }
    }, 2000);
  };

  /* ── Handle API Key Generation ─────────────────────────── */
  const handleGenerateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newKeyName.trim()) return;
    try {
      const res = await api.post("/api-keys", { name: newKeyName });
      setGeneratedKey(res.data.apiKey);
      setNewKeyName("");
      fetchApiKeys();
    } catch (err) {
      console.error("Error generating API key:", err);
    }
  };

  const handleCopyKey = () => {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      alert("API Key copied to clipboard!");
    }
  };

  return (
    <div className="dp-container noise">
      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="dp-sidebar">
        <div className="dp-sidebar__top">
          <div className="dp-logo">
            <span className="dp-logo__mark">◈</span>
            <span className="dp-logo__text">TruthShield</span>
          </div>
          <div className="dp-profile">
            <span className="mono dp-profile__org">
              {user?.organizationId ? "WORKSPACE" : "OFFLINE"}
            </span>
            <span className="dp-profile__email">
              {user?.email || "agent@truthshield.com"}
            </span>
          </div>
          <nav className="dp-nav">
            <button
              className={`dp-nav__item ${activeTab === "scan" ? "active" : ""}`}
              onClick={() => setActiveTab("scan")}
            >
              <IconTerminal /> Forensic Scan
            </button>
            <button
              className={`dp-nav__item ${activeTab === "reports" ? "active" : ""}`}
              onClick={() => setActiveTab("reports")}
            >
              <IconFileText /> All Reports
            </button>
            <button
              className={`dp-nav__item ${activeTab === "alerts" ? "active" : ""}`}
              onClick={() => setActiveTab("alerts")}
            >
              <IconBell /> Alerts Inbox
              {unreadCount > 0 && (
                <span className="dp-nav__badge">{unreadCount}</span>
              )}
            </button>
            <button
              className={`dp-nav__item ${activeTab === "settings" ? "active" : ""}`}
              onClick={() => setActiveTab("settings")}
            >
              <IconSettings /> Workspace Settings
            </button>
          </nav>
        </div>
        <button className="dp-nav__item dp-logout-btn" onClick={logout}>
          <IconLogOut /> Sign Out
        </button>
      </aside>

      {/* ── Main Panel ──────────────────────────────────────── */}
      <main className="dp-main">
        <AnimatePresence mode="wait">
          {/* ── Tab: Scan ────────────────────────────────────── */}
          {activeTab === "scan" && (
            <motion.div
              key="scan"
              className="dp-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={EASE}
            >
              <div className="dp-header">
                <span className="tag tag-acid">forensic_analysis_engine</span>
                <h1 className="dp-title">Analysis Center</h1>
                <p className="dp-subtitle">
                  Upload media or verify claim strings using multi-model checks.
                </p>
              </div>

              {/* Mode Switcher */}
              <div className="dp-switcher">
                <button
                  className={`dp-switcher__btn ${scanType === "file" ? "active" : ""}`}
                  onClick={() => setScanType("file")}
                >
                  File Forensics
                </button>
                <button
                  className={`dp-switcher__btn ${scanType === "text" ? "active" : ""}`}
                  onClick={() => setScanType("text")}
                >
                  Claim / URL Verification
                </button>
              </div>

              {/* Scan Type: File Upload */}
              {scanType === "file" && (
                <div className="dp-scan-section">
                  <div className="dp-scan-layout">
                    {/* Left: upload controls */}
                    <div className="dp-scan-controls">
                      <div
                        className={`dp-dropzone ${isDragging ? "dragging" : ""} ${selectedFile ? "has-file" : ""}`}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setIsDragging(true);
                        }}
                        onDragLeave={() => setIsDragging(false)}
                        onDrop={handleFileDrop}
                      >
                        <input
                          type="file"
                          id="file-uploader"
                          style={{ display: "none" }}
                          onChange={(e) =>
                            e.target.files?.[0] &&
                            setSelectedFile(e.target.files[0])
                          }
                        />
                        <label
                          htmlFor="file-uploader"
                          className="dp-dropzone__inner"
                        >
                          <IconUpload />
                          {selectedFile ? (
                            <>
                              <h3 className="dp-dropzone__filename">
                                {selectedFile.name}
                              </h3>
                              <p className="dp-dropzone__filesize">
                                {(selectedFile.size / 1024 / 1024).toFixed(2)}{" "}
                                MB
                              </p>
                            </>
                          ) : (
                            <>
                              <h3>Drag file here or click to browse</h3>
                              <p>Supports MP4, JPG, PNG up to 50MB</p>
                            </>
                          )}
                        </label>
                      </div>

                      {/* Module Toggles */}
                      <div className="dp-modules-box">
                        <span className="mono dp-modules-box__title">
                          select_forensic_modules
                        </span>
                        <div className="dp-modules-grid">
                          {[
                            { id: "deepfake", name: "Facial Artifacts" },
                            { id: "metadata_tampering", name: "EXIF Metadata" },
                            {
                              id: "stolen_content",
                              name: "Stolen Content Finder",
                            },
                          ].map((mod) => (
                            <label key={mod.id} className="dp-checkbox">
                              <input
                                type="checkbox"
                                checked={fileModules.includes(mod.id)}
                                onChange={(e) => {
                                  if (e.target.checked)
                                    setFileModules([...fileModules, mod.id]);
                                  else
                                    setFileModules(
                                      fileModules.filter((m) => m !== mod.id),
                                    );
                                }}
                              />
                              <span className="dp-checkbox__box" />
                              <span className="dp-checkbox__label">
                                {mod.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>

                      {selectedFile && uploadStatus === "idle" && (
                        <button
                          className="btn-acid btn-acid--lg"
                          style={{ width: "100%", marginTop: "16px" }}
                          onClick={triggerUpload}
                        >
                          Initialize Analysis Pipeline →
                        </button>
                      )}

                      {/* Active Upload/Processing Bar */}
                      {uploadStatus !== "idle" && uploadStatus !== "done" && (
                        <div className="dp-progress-card">
                          <div className="dp-progress-header">
                            <span className="mono">
                              {uploadStatus === "uploading"
                                ? "uploading_assets"
                                : "running_forensic_models"}
                            </span>
                            <span className="mono">{uploadProgress}%</span>
                          </div>
                          <div className="dp-progress-track">
                            <div
                              className="dp-progress-bar"
                              style={{ width: `${uploadProgress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Right: upload verdict display */}
                    <div className="dp-scan-verdict">
                      {fileVerdict ? (
                        <div className="verdict-card">
                          <div className="verdict-card__header">
                            <span
                              className={`tag tag-${fileVerdict.aggregation.aggregated_risk_level === "high" ? "red" : "green"}`}
                            >
                              {fileVerdict.aggregation.aggregated_verdict}
                            </span>
                            <span className="mono verdict-card__id">
                              {fileVerdict.job.id}
                            </span>
                          </div>
                          <div className="verdict-card__body">
                            <div className="verdict-stat">
                              <span className="verdict-stat__val">
                                {fileVerdict.aggregation.aggregated_score}%
                              </span>
                              <span className="verdict-stat__label">
                                Aggregated Suspicion Score
                              </span>
                            </div>
                            <div
                              className="divider"
                              style={{ margin: "16px 0" }}
                            />
                            <div className="verdict-logs">
                              <span className="mono logs-title">
                                forensic_analysis_report
                              </span>
                              <div className="logs-wrap">
                                <p className="mono log-line green">
                                  [OK] Asset indexed successfully.
                                </p>
                                <p className="mono log-line green">
                                  [OK] EXIF Integrity verified.
                                </p>
                                {fileVerdict.aggregation
                                  .aggregated_risk_level === "high" ? (
                                  <>
                                    <p className="mono log-line red">
                                      [WARN] High lighting variance in facial
                                      quadrants.
                                    </p>
                                    <p className="mono log-line red">
                                      [WARN] GAN pattern mismatch in background
                                      compression.
                                    </p>
                                  </>
                                ) : (
                                  <p className="mono log-line green">
                                    [OK] Face pattern matches baseline
                                    distribution.
                                  </p>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="verdict-placeholder">
                          <span className="mono">pipeline_idle</span>
                          <p>
                            Initialize scan to display real-time forensic
                            report.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Scan Type: Text Claim */}
              {scanType === "text" && (
                <div className="dp-scan-section">
                  <div className="dp-scan-layout">
                    {/* Left: Input */}
                    <form
                      className="dp-scan-controls"
                      onSubmit={handleTextVerify}
                    >
                      <div className="dp-text-field">
                        <label htmlFor="text-claim" className="mono lp-label">
                          claim_string_or_url
                        </label>
                        <textarea
                          id="text-claim"
                          className="lp-input"
                          style={{ minHeight: "120px", resize: "vertical" }}
                          placeholder="Paste a direct quote, tweet, news headline, or source URL..."
                          value={textClaim}
                          onChange={(e) => setTextClaim(e.target.value)}
                          required
                        />
                      </div>

                      {/* Module Toggles */}
                      <div
                        className="dp-modules-box"
                        style={{ marginTop: "16px" }}
                      >
                        <span className="mono dp-modules-box__title">
                          select_verifiers
                        </span>
                        <div className="dp-modules-grid">
                          {[
                            { id: "deepfake", name: "Facial Artifacts" },
                            { id: "fake_news", name: "Semantic Fact Check" },
                          ].map((mod) => (
                            <label key={mod.id} className="dp-checkbox">
                              <input
                                type="checkbox"
                                checked={textModules.includes(mod.id)}
                                onChange={(e) => {
                                  if (e.target.checked)
                                    setTextModules([...textModules, mod.id]);
                                  else
                                    setTextModules(
                                      textModules.filter((m) => m !== mod.id),
                                    );
                                }}
                              />
                              <span className="dp-checkbox__box" />
                              <span className="dp-checkbox__label">
                                {mod.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <button
                        type="submit"
                        className="btn-acid btn-acid--lg"
                        style={{ width: "100%", marginTop: "16px" }}
                        disabled={verifying}
                      >
                        {verifying
                          ? "Running checks..."
                          : "Submit Claims Verification →"}
                      </button>
                    </form>

                    {/* Right: Verdict */}
                    <div className="dp-scan-verdict">
                      {verdict ? (
                        <div className="verdict-card">
                          <div className="verdict-card__header">
                            <span
                              className={`tag tag-${verdict.aggregation.aggregated_risk_level === "high" ? "red" : "green"}`}
                            >
                              {verdict.aggregation.aggregated_verdict ||
                                "VERIFIED"}
                            </span>
                            <span className="mono verdict-card__id">
                              {verdict.job.id}
                            </span>
                          </div>
                          <div className="verdict-card__body">
                            <div className="verdict-stat">
                              <span className="verdict-stat__val">
                                {verdict.aggregation.aggregated_score || 0}%
                              </span>
                              <span className="verdict-stat__label">
                                Aggregated Suspicion Score
                              </span>
                            </div>
                            <div
                              className="divider"
                              style={{ margin: "16px 0" }}
                            />
                            <div className="verdict-logs">
                              <span className="mono logs-title">
                                fact_check_sources
                              </span>
                              <div className="logs-wrap">
                                <p className="mono log-line green">
                                  [OK] Dispatched claim to cross-verifier
                                  cluster.
                                </p>
                                <p className="mono log-line green">
                                  [OK] Fact-check engine returned results.
                                </p>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="verdict-placeholder">
                          <span className="mono">waiting_for_input</span>
                          <p>
                            Submit claim statement or URL to generate consensus
                            report.
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ── Tab: Reports ─────────────────────────────────── */}
          {activeTab === "reports" && (
            <motion.div
              key="reports"
              className="dp-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={EASE}
            >
              <div className="dp-header">
                <span className="tag tag-acid">scans_database_archive</span>
                <h1 className="dp-title">Scans & Reports</h1>
                <p className="dp-subtitle">
                  Archive of past forensic reports and automated detections.
                </p>
              </div>

              <div className="dp-table-wrap">
                <table className="dp-table">
                  <thead>
                    <tr>
                      <th className="mono">report_id</th>
                      <th className="mono">type</th>
                      <th className="mono">status</th>
                      <th className="mono">modules</th>
                      <th className="mono">verdict</th>
                      <th className="mono">created_at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          style={{ textAlign: "center", padding: "40px 0" }}
                          className="mono"
                        >
                          no_records_found
                        </td>
                      </tr>
                    ) : (
                      jobs.map((job) => (
                        <tr
                          key={job.id}
                          onClick={() => setSelectedJobDetail(job)}
                        >
                          <td className="mono" style={{ color: "var(--acid)" }}>
                            {job.id.substring(0, 8)}...
                          </td>
                          <td className="mono">{job.content_type}</td>
                          <td>
                            <span className={`tag tag-amber`}>
                              {job.status}
                            </span>
                          </td>
                          <td className="mono">
                            {job.detection_modules.join(", ")}
                          </td>
                          <td>
                            {job.aggregated_verdict ? (
                              <span
                                className={`tag tag-${job.aggregated_risk_level === "high" ? "red" : "green"}`}
                              >
                                {job.aggregated_verdict}
                              </span>
                            ) : (
                              "-"
                            )}
                          </td>
                          <td className="mono">
                            {new Date(job.created_at).toLocaleString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </motion.div>
          )}

          {/* ── Tab: Alerts ──────────────────────────────────── */}
          {activeTab === "alerts" && (
            <motion.div
              key="alerts"
              className="dp-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={EASE}
            >
              <div className="dp-header">
                <span className="tag tag-acid">realtime_alerts_inbox</span>
                <h1 className="dp-title">Active Security Alerts</h1>
                <p className="dp-subtitle">
                  Real-time deepfake anomalies and claim manipulation triggers.
                </p>
              </div>

              <div className="dp-alerts-list">
                {alerts.length === 0 ? (
                  <div
                    className="verdict-placeholder"
                    style={{ padding: "80px 0" }}
                  >
                    <span className="mono">all_clear</span>
                    <p>
                      No active threats or anomalous alerts found in current
                      stream.
                    </p>
                  </div>
                ) : (
                  <div className="alerts-inbox-grid">
                    {alerts.map((alert) => (
                      <div
                        key={alert.id}
                        className={`dp-alert-card severity-${alert.severity} ${alert.acknowledged_at ? "acknowledged" : ""}`}
                      >
                        <div className="dp-alert-card__top">
                          <span
                            className={`tag tag-${alert.severity === "high" || alert.severity === "critical" ? "red" : "amber"}`}
                          >
                            {alert.severity.toUpperCase()}
                          </span>
                          <span className="mono dp-alert-card__id">
                            {alert.id.substring(0, 8)}...
                          </span>
                        </div>
                        <h3 className="dp-alert-card__title">{alert.title}</h3>

                        <div className="dp-alert-card__meta">
                          <div>
                            <span className="mono label">origin_job</span>
                            <p className="val mono">
                              {alert.jobId.substring(0, 8)}...
                            </p>
                          </div>
                          <div>
                            <span className="mono label">trigger_module</span>
                            <p className="val mono">{alert.module}</p>
                          </div>
                          <div>
                            <span className="mono label">confidence_score</span>
                            <p className="val mono">{alert.score}%</p>
                          </div>
                        </div>

                        <div className="dp-alert-card__actions">
                          {!alert.acknowledged_at ? (
                            <button
                              className="btn-acid"
                              style={{ padding: "6px 12px", fontSize: "11px" }}
                              onClick={() => handleAcknowledgeAlert(alert.id)}
                            >
                              Acknowledge Alert
                            </button>
                          ) : !alert.resolved_at ? (
                            <button
                              className="btn-acid"
                              style={{
                                padding: "6px 12px",
                                fontSize: "11px",
                                background: "#3b82f6",
                                color: "white",
                              }}
                              onClick={() => handleResolveAlert(alert.id)}
                            >
                              Resolve Threat
                            </button>
                          ) : (
                            <span className="tag tag-green">RESOLVED</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Tab: Settings & Billing ──────────────────────── */}
          {activeTab === "settings" && (
            <motion.div
              key="settings"
              className="dp-view"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={EASE}
            >
              <div className="dp-header">
                <span className="tag tag-acid">workspace_administration</span>
                <h1 className="dp-title">Workspace Settings</h1>
                <p className="dp-subtitle">
                  Provision API key credentials and manage organization
                  subscription plans.
                </p>
              </div>

              <div className="dp-apikeys-layout">
                {/* Left Panel: API Key Management */}
                <div className="dp-settings-card">
                  <h3 className="feat-title" style={{ marginBottom: "16px" }}>
                    Developer Credentials
                  </h3>
                  <form
                    onSubmit={handleGenerateKey}
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: "16px",
                    }}
                  >
                    <div className="lp-field">
                      <label htmlFor="keyname" className="mono lp-label">
                        credential_label
                      </label>
                      <input
                        id="keyname"
                        className="lp-input"
                        type="text"
                        placeholder="e.g. Production Webhook Engine"
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        required
                      />
                    </div>
                    <button
                      type="submit"
                      className="btn-acid"
                      style={{ width: "100%" }}
                    >
                      Generate Key Pair
                    </button>
                  </form>

                  {/* Generated Key Info Block */}
                  {generatedKey && (
                    <div className="dp-genkey-box">
                      <span className="mono logs-title">credentials_ready</span>
                      <p className="dp-genkey-desc">
                        Copy this key now. For safety, it will not be displayed
                        again.
                      </p>
                      <div className="dp-genkey-row">
                        <code className="mono">{generatedKey}</code>
                        <button
                          type="button"
                          className="btn-acid"
                          style={{ fontSize: "11px", padding: "6px 12px" }}
                          onClick={handleCopyKey}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="divider" style={{ margin: "24px 0 16px" }} />

                  <h4
                    className="mono title"
                    style={{
                      marginBottom: "12px",
                      fontSize: "11px",
                      color: "var(--text-dim)",
                    }}
                  >
                    active_credentials_list
                  </h4>
                  <div className="dp-keys-list">
                    {apiKeys.length === 0 ? (
                      <p
                        className="mono text-dim"
                        style={{ padding: "12px 0", fontSize: "12px" }}
                      >
                        no_api_keys_provisioned
                      </p>
                    ) : (
                      apiKeys.map((k) => (
                        <div key={k.id} className="dp-key-row">
                          <div>
                            <p className="dp-key-row__name">{k.name}</p>
                            <p className="mono dp-key-row__prefix">
                              Prefix: {k.key_prefix}••••••••
                            </p>
                          </div>
                          <span className="mono dp-key-row__date">
                            {new Date(k.created_at).toLocaleDateString()}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Right Panel: Subscription & Billing Info */}
                <div className="dp-settings-card">
                  <h3 className="feat-title" style={{ marginBottom: "16px" }}>
                    Subscription & Billing
                  </h3>

                  <div className="billing-plan-info">
                    <div className="plan-badge-row">
                      <span className="mono label">active_plan</span>
                      <span
                        className="tag tag-acid"
                        style={{ fontSize: "11px", textTransform: "uppercase" }}
                      >
                        {planTier === "starter"
                          ? "starter_free"
                          : "pro_investigator"}
                      </span>
                    </div>
                    <p className="billing-price">
                      {planTier === "starter" ? "$0" : "$89"}
                      <span className="plan-period">/month</span>
                    </p>
                  </div>

                  <div className="divider" style={{ margin: "20px 0" }} />

                  {/* Plan Resource Limits Progress bar */}
                  <h4
                    className="mono title"
                    style={{
                      marginBottom: "12px",
                      fontSize: "11px",
                      color: "var(--text-dim)",
                    }}
                  >
                    usage_limits
                  </h4>
                  <div className="billing-limits">
                    <div className="limit-item">
                      <div className="limit-label-row">
                        <span className="limit-name">API Queries</span>
                        <span className="limit-fraction">
                          {planTier === "starter" ? "4 / 100" : "112 / 10,000"}
                        </span>
                      </div>
                      <div className="dp-progress-track">
                        <div
                          className="dp-progress-bar"
                          style={{
                            width: planTier === "starter" ? "4%" : "1.1%",
                          }}
                        />
                      </div>
                    </div>
                    <div className="limit-item" style={{ marginTop: "16px" }}>
                      <div className="limit-label-row">
                        <span className="limit-name">
                          PDF Forensics Reports
                        </span>
                        <span className="limit-fraction">
                          {planTier === "starter" ? "0 / 10" : "45 / Unlimited"}
                        </span>
                      </div>
                      <div className="dp-progress-track">
                        <div
                          className="dp-progress-bar"
                          style={{
                            width: planTier === "starter" ? "0%" : "5%",
                          }}
                        />
                      </div>
                    </div>
                  </div>

                  <div className="divider" style={{ margin: "24px 0 20px" }} />

                  {planTier === "starter" ? (
                    <button
                      className="btn-acid btn-acid--lg"
                      style={{ width: "100%" }}
                      onClick={() => setShowUpgradeModal(true)}
                    >
                      Upgrade Workspace Plan →
                    </button>
                  ) : (
                    <div
                      className="tag tag-green"
                      style={{
                        display: "block",
                        textAlign: "center",
                        padding: "12px",
                      }}
                    >
                      ✓ Pro subscription active & billed automatically.
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* ── Interactive Upgrade Plan Modal ──────────────────── */}
      <AnimatePresence>
        {showUpgradeModal && (
          <div className="dp-modal" onClick={() => setShowUpgradeModal(false)}>
            <div
              className="dp-modal__content"
              style={{ maxWidth: "640px" }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dp-modal__header">
                <h2 className="dp-modal__title">Upgrade Workspace Plan</h2>
                <button
                  className="dp-modal__close"
                  onClick={() => setShowUpgradeModal(false)}
                >
                  ×
                </button>
              </div>
              <div
                className="dp-modal__body"
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "20px",
                }}
              >
                {/* Pro Tier Upgrade Selection */}
                <div className="upgrade-tier-box featured">
                  <span
                    className="mono tier-name"
                    style={{ color: "var(--acid)" }}
                  >
                    pro_investigator
                  </span>
                  <p className="tier-price">
                    $89<span className="plan-period">/mo</span>
                  </p>
                  <p className="tier-desc">
                    For active investigators and fast-paced digital newsrooms.
                  </p>
                  <ul
                    className="plan-features"
                    style={{
                      margin: "14px 0 24px",
                      fontSize: "11px",
                      gap: "8px",
                    }}
                  >
                    <li>10,000 API queries / month</li>
                    <li>Priority queue processing</li>
                    <li>Full PDF audit report downloads</li>
                  </ul>
                  <button
                    className="btn-acid"
                    style={{ width: "100%", marginTop: "auto" }}
                    onClick={() => {
                      setPlanTier("pro");
                      setShowUpgradeModal(false);
                      alert(
                        "Workspace upgraded to Pro Investigator successfully!",
                      );
                    }}
                  >
                    Select Plan
                  </button>
                </div>

                {/* Enterprise Tier Selection */}
                <div className="upgrade-tier-box">
                  <span className="mono tier-name">enterprise_newsroom</span>
                  <p className="tier-price">Custom</p>
                  <p className="tier-desc">
                    For large networks requiring bulk processing and custom
                    SLAs.
                  </p>
                  <ul
                    className="plan-features"
                    style={{
                      margin: "14px 0 24px",
                      fontSize: "11px",
                      gap: "8px",
                    }}
                  >
                    <li>Unlimited API queries</li>
                    <li>Custom inference hosts</li>
                    <li>SLA compliance guarantee</li>
                  </ul>
                  <a
                    href="mailto:team@truthshield.com"
                    className="btn-ghost"
                    style={{
                      width: "100%",
                      textAlign: "center",
                      marginTop: "auto",
                    }}
                  >
                    Contact Support
                  </a>
                </div>
              </div>
            </div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Real-time Toast Alert ───────────────────────────── */}
      <AnimatePresence>
        {toastAlert && (
          <motion.div
            className="dp-toast"
            initial={{ opacity: 0, y: 50, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={EASE}
          >
            <div className="dp-toast__header">
              <span className="mono">realtime_anomaly_alert</span>
              <button
                className="dp-toast__close"
                onClick={() => setToastAlert(null)}
              >
                ×
              </button>
            </div>
            <p className="dp-toast__title">{toastAlert.title}</p>
            <div className="dp-toast__footer">
              <span className="tag tag-red">
                {toastAlert.severity.toUpperCase()}
              </span>
              <button
                className="dp-toast__action"
                onClick={() => {
                  setActiveTab("alerts");
                  setToastAlert(null);
                }}
              >
                Inspect Anomaly →
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Detailed Modal ──────────────────────────────────── */}
      {selectedJobDetail && (
        <div className="dp-modal" onClick={() => setSelectedJobDetail(null)}>
          <div
            className="dp-modal__content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="dp-modal__header">
              <h2 className="dp-modal__title">
                Report {selectedJobDetail.id.substring(0, 12)}...
              </h2>
              <button
                className="dp-modal__close"
                onClick={() => setSelectedJobDetail(null)}
              >
                ×
              </button>
            </div>
            <div className="dp-modal__body">
              <div className="dp-modal__stat-grid">
                <div>
                  <span className="mono label">status</span>
                  <p className="val">{selectedJobDetail.status}</p>
                </div>
                <div>
                  <span className="mono label">verdict</span>
                  <p className="val">
                    {selectedJobDetail.aggregated_verdict || "UNAVAILABLE"}
                  </p>
                </div>
                <div>
                  <span className="mono label">suspicion_score</span>
                  <p className="val">
                    {selectedJobDetail.aggregated_score ?? 0}%
                  </p>
                </div>
                <div>
                  <span className="mono label">created_at</span>
                  <p className="val">
                    {new Date(selectedJobDetail.created_at).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="divider" style={{ margin: "20px 0" }} />

              <h4 className="mono title" style={{ marginBottom: "10px" }}>
                active_forensic_modules
              </h4>
              <div className="tags-row">
                {selectedJobDetail.detection_modules.map((m: string) => (
                  <span key={m} className="tag tag-acid">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
