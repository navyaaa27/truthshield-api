import axios from "axios";

/**
 * The core Axios instance configured to communicate with the TruthShield API.
 * Automatically injects the JWT access token into the Authorization header
 * and handles 401 Unauthorized responses by clearing the session.
 */
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:3000/api/v1",
  headers: { "Content-Type": "application/json" },
});


// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("ts_access_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401 — clear storage and redirect to login only if we are outside the login flow
api.interceptors.response.use(
  (res) => res,
  (error) => {
    const isAuthEndpoint =
      error.config?.url?.includes("/auth/login") ||
      error.config?.url?.includes("/auth/register") ||
      error.config?.url?.includes("/auth/refresh");

    if (error.response?.status === 401 && !isAuthEndpoint) {
      localStorage.removeItem("ts_access_token");
      localStorage.removeItem("ts_refresh_token");
      if (typeof window !== "undefined" && window.location.pathname !== "/login") {
        window.location.href = "/login";
      }
    }
    return Promise.reject(error);
  },
);

export default api;
