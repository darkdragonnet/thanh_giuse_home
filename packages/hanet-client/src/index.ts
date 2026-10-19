import { evaluateHanetError, HanetErrorEvaluation } from '@thanh-giuse/error-mapping';
import { CircuitBreaker } from './circuitBreaker.js';
import {
  HanetClientOptions,
  HanetApiResponse,
  HanetClientResult,
  RegisterByUrlParams,
  UpdateByFaceImageParams,
  ConnectionStatusResult,
  UpdateAliasIDParams,
  AddPersonToDepartmentParams
} from './types.js';

export * from './types.js';
export * from './circuitBreaker.js';

export class HanetClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly placeId: string;
  private readonly timeoutMs: number;
  private readonly circuitBreaker: CircuitBreaker;

  constructor(options: HanetClientOptions) {
    this.baseUrl = (
      options.baseUrl ||
      process.env.HANET_BASE_URL ||
      'https://partner.hanet.ai'
    ).replace(/\/$/, '');

    this.token = options.token;
    this.placeId = options.placeId;
    this.timeoutMs = options.timeoutMs ?? 120_000; // 120s theo hiến pháp bộ nhớ

    this.circuitBreaker = new CircuitBreaker({
      failureThreshold: options.circuitBreakerThreshold ?? 3,
      cooldownMs: options.circuitBreakerCooldownMs ?? 300_000
    });
  }

  public getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Phương thức gọi HTTP nội bộ với kiểm soát Circuit Breaker và Abort Timeout
   */
  private async executePost<T>(
    path: string,
    body: FormData | URLSearchParams
  ): Promise<HanetClientResult<T>> {
    // 1. Kiểm tra Circuit Breaker trước khi gọi
    try {
      this.circuitBreaker.checkExecution();
    } catch (err) {
      const evaluation = evaluateHanetError(-503, 'CIRCUIT_BREAKER_OPEN');
      return {
        success: false,
        evaluation,
        error: err as Error
      };
    }

    const endpointUrl = `${this.baseUrl}${path}`;
    const signal = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(endpointUrl, {
        method: 'POST',
        body,
        signal
      });
    } catch (networkErr: any) {
      // Chỉ đếm lỗi Circuit Breaker khi rớt mạng thực sự, DNS error, hoặc Timeout
      this.circuitBreaker.recordFailure();

      const isTimeout = networkErr?.name === 'TimeoutError';
      const evaluation: HanetErrorEvaluation = evaluateHanetError(
        -503,
        isTimeout ? 'REQUEST_TIMEOUT_120S' : (networkErr?.message || 'NETWORK_CONNECTION_ERROR')
      );

      return {
        success: false,
        evaluation,
        error: networkErr as Error
      };
    }

    // Đọc an toàn text từ response một lần duy nhất (tránh lỗi stream already read)
    let rawText = '';
    try {
      rawText = await response.text();
    } catch {
      rawText = '';
    }

    const safeMessage = (rawText || response.statusText || '').slice(0, 1000);

    let json: HanetApiResponse<T> | null = null;
    try {
      if (rawText) {
        json = JSON.parse(rawText) as HanetApiResponse<T>;
      }
    } catch {
      json = null;
    }

    // 1. Nếu response chứa JSON có returnCode hợp lệ từ HANET Cloud
    if (json && typeof json.returnCode === 'number') {
      const evaluation = evaluateHanetError(json.returnCode, json.returnMessage || safeMessage);

      // Chỉ ghi nhận failure cho Circuit Breaker khi chính máy chủ HANET báo quá tải -503
      if (evaluation.action === 'RETRY_LATER' && json.returnCode === -503) {
        this.circuitBreaker.recordFailure();
      } else {
        this.circuitBreaker.recordSuccess();
      }

      return {
        success: json.returnCode === 1,
        rawResponse: json,
        evaluation
      };
    }

    // 2. Nếu không có returnCode JSON, phân loại theo HTTP status code
    if (!response.ok) {
      // A. Lỗi 401 hoặc token: Không kích hoạt Circuit Breaker
      if (response.status === 401) {
        const evaluation = evaluateHanetError(-401, safeMessage || 'Unauthorized');
        return {
          success: false,
          rawResponse: json ?? undefined,
          evaluation,
          error: new Error(`HTTP 401 Unauthorized: ${safeMessage}`)
        };
      }

      // B. Lỗi 429 Rate Limit: Không kích hoạt Circuit Breaker, trả về RETRY_LATER backoff
      if (response.status === 429) {
        const evaluation = evaluateHanetError(-429, safeMessage || 'Rate Limit Exceeded');
        return {
          success: false,
          rawResponse: json ?? undefined,
          evaluation,
          error: new Error(`HTTP 429 Too Many Requests: ${safeMessage}`)
        };
      }

      // C. Lỗi 4xx Client Error khác (400, 403, 404, 422): Tuyệt đối KHÔNG đếm Circuit Breaker
      if (response.status >= 400 && response.status < 500) {
        console.warn(`[HANET CLIENT 4XX] Path: ${path} | Status: ${response.status} | Body: ${safeMessage}`);
        const evaluation = evaluateHanetError(-400, safeMessage || `HTTP Error: ${response.status} ${response.statusText}`);
        return {
          success: false,
          rawResponse: json ?? undefined,
          evaluation,
          error: new Error(`HTTP Error: ${response.status} ${response.statusText} - ${safeMessage}`)
        };
      }

      // D. Lỗi 5xx Server Error: Ghi nhận vào Circuit Breaker
      this.circuitBreaker.recordFailure();
      const evaluation = evaluateHanetError(-503, safeMessage || `HTTP Error: ${response.status} ${response.statusText}`);
      return {
        success: false,
        rawResponse: json ?? undefined,
        evaluation,
        error: new Error(`HTTP Error: ${response.status} ${response.statusText}`)
      };
    }

    // 3. Response HTTP 200 nhưng body rỗng hoặc text thường
    this.circuitBreaker.recordSuccess();
    const evaluation = evaluateHanetError(1, 'SUCCESS');
    return {
      success: true,
      rawResponse: json ?? undefined,
      evaluation
    };
  }

  /**
   * 1. Đăng ký nhận diện qua URL ảnh
   */
  public async registerByUrl(params: RegisterByUrlParams): Promise<HanetClientResult<any>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('placeID', this.placeId);
    form.append('aliasID', params.aliasID);
    form.append('name', params.name);
    form.append('url', params.imageUrl);
    form.append('file_url', params.imageUrl);
    if (params.title) form.append('title', params.title);
    form.append('type', String(params.type ?? 0));

    return this.executePost<any>('/person/registerByUrl', form);
  }

  /**
   * 2. Cập nhật ảnh qua personID (Multipart Buffer)
   */
  public async updateByFaceImageByPersonID(params: UpdateByFaceImageParams): Promise<HanetClientResult<any>> {
    const formData = new FormData();
    formData.append('token', this.token);
    formData.append('personID', params.personID);

    const blob = new Blob([params.imageBuffer], { type: 'image/jpeg' });
    formData.append('file', blob, params.filename || 'face.jpg');

    return this.executePost<any>('/person/updateByFaceImageByPersonID', formData);
  }

  /**
   * 3. Kiểm tra trạng thái kết nối camera
   */
  public async getConnectionStatus(deviceID: string): Promise<HanetClientResult<ConnectionStatusResult>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('deviceID', deviceID);

    return this.executePost<ConnectionStatusResult>('/device/getConnectionStatus', form);
  }

  /**
   * 4. Lấy danh sách nhân sự tại địa điểm
   */
  public async getListByPlace(): Promise<HanetClientResult<any>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('placeID', this.placeId);

    return this.executePost<any>('/person/getListByPlace', form);
  }

  /**
   * 5. Xóa nhân sự theo personID (CẢNH BÁO HIẾN PHÁP: CẤM SỬ DỤNG TRONG NGHIỆP VỤ HỌC SINH)
   */
  public async removePersonByID(personID: string): Promise<HanetClientResult<any>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('personID', personID);

    return this.executePost<any>('/person/removePersonByID', form);
  }

  /**
   * 6. Cập nhật mã AliasID mới cho nhân sự (POST /person/updateAliasID)
   */
  public async updateAliasID(params: UpdateAliasIDParams): Promise<HanetClientResult<any>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('personID', params.personID);
    form.append('aliasID', params.aliasID);

    return this.executePost<any>('/person/updateAliasID', form);
  }

  /**
   * 7. Gán nhân sự vào phòng ban (POST /department/add-person)
   */
  public async addPersonToDepartment(params: AddPersonToDepartmentParams): Promise<HanetClientResult<any>> {
    const form = new URLSearchParams();
    form.append('token', this.token);
    form.append('departmentID', String(params.departmentID));
    form.append('personIDs', params.personID);

    return this.executePost<any>('/department/add-person', form);
  }
}
