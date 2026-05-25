export interface User {
  id: string;
  org_id: string;
  email: string;
  password_hash: string;
  role: string;
  mfa_secret: string | null;
  mfa_enabled: boolean;
  last_login: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface RegisterDTO {
  email: string;
  password: string;
  orgName: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface JWTPayload {
  userId: string;
  orgId: string;
  role: string;
  iat?: number;
  exp?: number;
}
