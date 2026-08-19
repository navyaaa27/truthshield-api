import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from "react";
import api from "../lib/api";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  organizationId: string;
}

/**
 * Represents the authentication context value provided to the React tree.
 * Exposes the currently authenticated user, loading state, and core auth methods.
 */
interface AuthContextValue {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  isAuthenticated: boolean;
}

/**
 * The global Authentication Context.
 * Use `useAuth()` hook to consume this context rather than using `AuthContext` directly.
 */
const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("ts_access_token");
    if (!token) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsLoading(false);
      return;
    }

    api
      .get("/users/me")
      .then((res) => setUser(res.data.data.user))
      .catch(() => {
        localStorage.removeItem("ts_access_token");
        localStorage.removeItem("ts_refresh_token");
      })
      .finally(() => setIsLoading(false));
  }, []);

  /**
   * Authenticates user credentials against the REST API.
   * On success, registers JWT tokens in local storage and updates user profile state.
   */
  const login = async (email: string, password: string) => {
    const res = await api.post("/auth/login", { email, password });
    const { tokens, user: userData } = res.data;
    localStorage.setItem("ts_access_token", tokens.accessToken);
    localStorage.setItem("ts_refresh_token", tokens.refreshToken);
    setUser(userData);
  };

  /**
   * Discards the active user session and clears stored tokens.
   * Redirects the viewport back to the landing page portal.
   */
  const logout = () => {
    localStorage.removeItem("ts_access_token");
    localStorage.removeItem("ts_refresh_token");
    setUser(null);
    window.location.href = "/";
  };

  return (
    <AuthContext.Provider
      value={{ user, isLoading, login, logout, isAuthenticated: !!user }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * Access hook helper to query current authentication states and session management functions.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
