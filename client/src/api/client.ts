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
  // Attach stream context
  const streamId = localStorage.getItem('stream_id');
  if (streamId) {
    config.headers['X-Stream-Id'] = streamId;
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
      if (res.data.isOwner !== undefined) localStorage.setItem('is_owner', res.data.isOwner ? '1' : '0');
      if (res.data.clientSlug) localStorage.setItem('client_slug', res.data.clientSlug);
      if (res.data.clientName) localStorage.setItem('client_name', res.data.clientName);
      if (res.data.isMultiBranch) {
        localStorage.setItem('is_multi_branch', '1');
        if (res.data.defaultBranchId) {
          localStorage.setItem('branch_id', String(res.data.defaultBranchId));
          // Find branch name + location info from the branches array. State /
          // city are surfaced on reports (e.g. PDF headers) — store them here
          // so a report doesn't need a round-trip to look them up.
          const defaultBranch = res.data.branches?.find((b: any) => b.id === res.data.defaultBranchId);
          if (defaultBranch) {
            localStorage.setItem('branch_name', defaultBranch.name);
            if (defaultBranch.state) localStorage.setItem('branch_state', defaultBranch.state);
            else localStorage.removeItem('branch_state');
            if (defaultBranch.city) localStorage.setItem('branch_city', defaultBranch.city);
            else localStorage.removeItem('branch_city');
          }
        }
      } else {
        localStorage.removeItem('is_multi_branch');
        localStorage.removeItem('branch_id');
        localStorage.removeItem('branch_name');
        localStorage.removeItem('branch_state');
        localStorage.removeItem('branch_city');
      }
      // Store enabled modules
      if (res.data.enabledModules) {
        localStorage.setItem('enabled_modules', JSON.stringify(res.data.enabledModules));
      }
      // Store enabled integrations
      if (res.data.enabledIntegrations) {
        localStorage.setItem('enabled_integrations', JSON.stringify(res.data.enabledIntegrations));
      }
      // Store streams — and auto-select the first stream if none is already
      // chosen, so the forecast module doesn't land in the "no stream" path
      // which returns empty data.
      if (res.data.streams) {
        localStorage.setItem('streams', JSON.stringify(res.data.streams));
        if (!localStorage.getItem('stream_id') && res.data.streams.length > 0) {
          const first = res.data.streams[0];
          localStorage.setItem('stream_id', String(first.id));
          localStorage.setItem('stream_name', first.name);
        }
      }
      if (res.data.streamAccess) {
        localStorage.setItem('stream_access', JSON.stringify(res.data.streamAccess));
      }
    }
    return res;
  },
  err => {
    if (err.response?.status === 401 && !window.location.pathname.includes('/login')) {
      localStorage.removeItem('auth_token');
      localStorage.removeItem('user_type');
      localStorage.removeItem('user_role');
      localStorage.removeItem('is_owner');
      localStorage.removeItem('client_slug');
      localStorage.removeItem('client_name');
      localStorage.removeItem('is_multi_branch');
      localStorage.removeItem('branch_id');
      localStorage.removeItem('branch_name');
      localStorage.removeItem('branch_state');
      localStorage.removeItem('branch_city');
      localStorage.removeItem('enabled_modules');
      localStorage.removeItem('enabled_integrations');
      localStorage.removeItem('active_module');
      localStorage.removeItem('streams');
      localStorage.removeItem('stream_access');
      localStorage.removeItem('stream_id');
      localStorage.removeItem('stream_name');
      window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

export default api;
