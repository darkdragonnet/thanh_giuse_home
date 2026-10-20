export const AUTH_UNAUTHORIZED_EVENT = 'app:auth:unauthorized';

interface RequestOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

class ApiClient {
  private baseUrl = '/api/admin';

  private getToken(): string | null {
    return localStorage.getItem('admin_token');
  }

  public setToken(token: string): void {
    localStorage.setItem('admin_token', token);
    document.cookie = `admin_token=${encodeURIComponent(token)}; path=/; max-age=259200; SameSite=Strict`;
  }

  public clearToken(): void {
    localStorage.removeItem('admin_token');
    document.cookie = 'admin_token=; path=/; max-age=0; SameSite=Strict';
  }

  async request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
    const { params, headers = {}, ...customConfig } = options;

    let url = `${this.baseUrl}${endpoint}`;
    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) searchParams.append(key, String(value));
      });
      const queryString = searchParams.toString();
      if (queryString) url += `?${queryString}`;
    }

    const token = this.getToken();
    const defaultHeaders: Record<string, string> = {
      'Accept': 'application/json',
    };

    if (customConfig.body !== undefined && !(customConfig.body instanceof FormData)) {
      defaultHeaders['Content-Type'] = 'application/json';
    }

    if (token) {
      defaultHeaders['Authorization'] = `Bearer ${token}`;
    }

    const config: RequestInit = {
      ...customConfig,
      headers: {
        ...defaultHeaders,
        ...(headers as Record<string, string>),
      },
    };

    const response = await fetch(url, config);

    if (response.status === 401) {
      this.clearToken();
      window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
      throw new Error('Phiên làm việc hết hạn hoặc token không hợp lệ.');
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Lỗi HTTP ${response.status}`);
    }

    return response.json();
  }

  get<T>(endpoint: string, params?: Record<string, any>) {
    return this.request<T>(endpoint, { method: 'GET', params });
  }

  post<T>(endpoint: string, body?: any) {
    const finalBody =
      body instanceof FormData
        ? body
        : body !== undefined
        ? JSON.stringify(body)
        : JSON.stringify({});

    return this.request<T>(endpoint, {
      method: 'POST',
      body: finalBody,
    });
  }

  patch<T>(endpoint: string, body?: any) {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: body !== undefined ? JSON.stringify(body) : JSON.stringify({}),
    });
  }

  put<T>(endpoint: string, body?: any) {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: body !== undefined ? JSON.stringify(body) : JSON.stringify({}),
    });
  }

  delete<T>(endpoint: string) {
    return this.request<T>(endpoint, {
      method: 'DELETE',
    });
  }
}

export const apiClient = new ApiClient();
