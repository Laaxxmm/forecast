import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api',
  withCredentials: true,
});

// Attach token and client context to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // For super admins, attach the selected client slug
  const clientSlug = localStorage.getItem('client_slug');
  if (clientSlug) {
    config.headers['X-Client-Slug'] = clientSlug;
  }
  return config;
});

// Store token from login response, redirect on 401
api.interceptors.response.use(
  res => {
    // If login response contains a token, save it
    if (res.config.url?.includes('/auth/login') && res.data?.token) {
      localStorage.setItem('auth_token', res.data.token);
      // Store tenant context from login response
      if (res.data.userType) localStorage.setItem('user_type', res.data.userType);
      if (res.data.role) localStorage.setItem('user_role', res.data.role);
      if (res.data.clientSlug) localStorage.setItem('client_slug', res.data.clientSlug);
      if (res.data.clientName) localStorage.setItem('client_name', res.data.clientName);
    }
    return res;
  },
  err => {
    if (err.response?.status === 401 && !window.location.pathname.includes('/login')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_type');
      localStorage.removeItem('user_role');
      localStorage.removeItem('client_slug');
      localStorage.removeItem('client_name');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
