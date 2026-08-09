import axios from 'axios';

const api = axios.create({
  baseURL: 'http://localhost:3000/api/v1',
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ts_access_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// On 401 — clear storage and redirect to login
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('ts_access_token');
      localStorage.removeItem('ts_refresh_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

export default api;
