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
  // Attach branch context for multi-branch clients
  const branchId = localStorage.getItem('branch_id');
  if (branchId) {
    config.headers['X-Branch-Id'] = branchId;
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
      if (res.data.isMultiBranch) {
        localStorage.setItem('is_multi_branch', '1');
        if (res.data.defaultBranchId) {
          localStorage.setItem('branch_id', String(res.data.defaultBranchId));
          // Find branch name from the branches array
          const defaultBranch = res.data.branches?.find((b: any) => b.id === res.data.defaultBranchId);
          if (defaultBranch) localStorage.setItem('branch_name', defaultBranch.name);
        }
      } else {
        localStorage.removeItem('is_multi_branch');
        localStorage.removeItem('branch_id');
        localStorage.removeItem('branch_name');
      }
      // Store enabled modules
      if (res.data.enabledModules) {
        localStorage.setItem('enabled_modules', JSON.stringify(res.data.enabledModules));
      }
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
      localStorage.removeItem('is_multi_branch');
      localStorage.removeItem('branch_id');
      localStorage.removeItem('branch_name');
      localStorage.removeItem('enabled_modules');
      localStorage.removeItem('active_module');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
