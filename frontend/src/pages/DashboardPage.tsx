import React, { useState } from 'react';
import { UploadCloud, Shield, FileText, Settings, LogOut } from 'lucide-react';
import Aurora from '../components/Aurora';
import './DashboardPage.css';

function DashboardPage() {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    console.log('Files dropped', e.dataTransfer.files);
  };

  return (
    <div className="dashboard-container">
      {/* Background Animation */}
      <div className="aurora-background">
        <Aurora
          colorStops={["#5227FF", "#EC4899", "#5227FF"]}
          amplitude={0.6}
          blend={0.45}
        />
      </div>

      <div className="dashboard-layout">
        {/* Sidebar */}
        <aside className="dashboard-sidebar">
          <div className="sidebar-header">
            <Shield className="sidebar-logo-icon" size={24} />
            <span>TruthShield AI</span>
          </div>
          <nav className="sidebar-nav">
            <a href="#" className="nav-item active"><UploadCloud size={20} /> New Scan</a>
            <a href="#" className="nav-item"><FileText size={20} /> Reports</a>
            <a href="#" className="nav-item"><Settings size={20} /> Settings</a>
          </nav>
          <div className="sidebar-footer">
            <a href="/" className="nav-item text-muted"><LogOut size={20} /> Sign Out</a>
          </div>
        </aside>

        {/* Main Content Area */}
        <main className="dashboard-main">
          <header className="dashboard-header">
            <h1>Forensic Analysis</h1>
            <p>Upload media or paste a claim to begin deepfake detection and verification.</p>
          </header>

          <div className="upload-section">
            <div 
              className={`upload-zone ${isDragging ? 'dragging' : ''}`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              <div className="upload-icon-wrapper">
                <UploadCloud size={48} className="upload-icon" />
              </div>
              <h3>Drag & drop your files here</h3>
              <p>Supports MP4, JPG, PNG up to 50MB</p>
              
              <div className="upload-divider">or</div>
              
              <button className="btn-upload">Browse Files</button>
            </div>
            
            <div className="text-claim-section">
              <h3>Or verify a text claim:</h3>
              <div className="text-input-group">
                <input type="text" placeholder="Paste a quote, news headline, or URL..." />
                <button className="btn-verify">Verify</button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default DashboardPage;
