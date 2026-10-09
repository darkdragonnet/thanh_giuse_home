export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerConfig {
  failureThreshold: number; // 3 lần
  cooldownMs: number;       // 300.000 ms (5 phút)
}

export class CircuitBreakerOpenError extends Error {
  constructor(public readonly cooldownRemainingMs: number) {
    super(`Circuit breaker is OPEN. Fast-failing requests for the next ${Math.round(cooldownRemainingMs / 1000)}s`);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  constructor(private readonly config: CircuitBreakerConfig) {}

  public getState(): CircuitState {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.cooldownMs) {
        this.state = 'HALF_OPEN';
      }
    }
    return this.state;
  }

  public checkExecution(): void {
    const currentState = this.getState();
    if (currentState === 'OPEN') {
      const remaining = this.config.cooldownMs - (Date.now() - this.lastFailureTime);
      throw new CircuitBreakerOpenError(Math.max(0, remaining));
    }
  }

  public recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(): void {
    this.consecutiveFailures += 1;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.state = 'OPEN';
    }
  }

  public reset(): void {
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.lastFailureTime = 0;
  }
}
