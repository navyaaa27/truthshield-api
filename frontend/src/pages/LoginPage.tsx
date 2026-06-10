import React, { useState } from 'react';
import Silk from '../components/Silk';
import './LoginPage.css';

function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Logging in with', email);
  };

  return (
    <div className="login-container">
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

      {/* Login Card overlay */}
      <div className="login-card">
        <h1>TruthShield</h1>
        <form onSubmit={handleLogin}>
          <div className="input-group">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              type="email"
              placeholder="agent@truthshield.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="input-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button type="submit" className="login-button">
            Access Dashboard
          </button>
        </form>
      </div>
    </div>
  );
}

export default LoginPage;
