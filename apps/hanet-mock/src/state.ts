export interface MockPerson {
  personID: string;
  aliasID: string;
  name: string;
  title?: string | undefined;
  placeID: string;
  faceUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiCallLog {
  timestamp: string;
  method: string;
  url: string;
  scenarioApplied: string;
  clientIp?: string | undefined;
}

export interface GlobalScenarioOverride {
  scenario: string;
  delayMs?: number | undefined;
  remainingHits?: number | undefined;
  expiresAt?: number | undefined; // epoch ms
}

class MockStateStore {
  private persons: Map<string, MockPerson> = new Map(); // Key: aliasID
  private personsById: Map<string, MockPerson> = new Map(); // Key: personID
  private callHistory: ApiCallLog[] = [];
  private callCounters: Record<string, number> = {};
  private globalOverride: GlobalScenarioOverride | null = null;
  private readonly MAX_HISTORY = 100;

  public reset(): void {
    this.persons.clear();
    this.personsById.clear();
    this.callHistory = [];
    this.callCounters = {};
    this.globalOverride = null;
  }

  public recordCall(log: ApiCallLog): void {
    if (this.callHistory.length >= this.MAX_HISTORY) {
      this.callHistory.shift();
    }
    this.callHistory.push(log);

    const key = `${log.method} ${log.url.split('?')[0]}`;
    this.callCounters[key] = (this.callCounters[key] || 0) + 1;
  }

  public setGlobalScenario(scenario: string, delayMs?: number, hits?: number, ttlSeconds?: number): void {
    this.globalOverride = {
      scenario,
      delayMs: delayMs && delayMs > 0 ? delayMs : undefined,
      remainingHits: hits && hits > 0 ? hits : undefined,
      expiresAt: ttlSeconds && ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : undefined
    };
  }

  public getActiveGlobalScenario(): GlobalScenarioOverride | null {
    if (!this.globalOverride) return null;

    if (this.globalOverride.expiresAt && Date.now() > this.globalOverride.expiresAt) {
      this.globalOverride = null;
      return null;
    }

    if (this.globalOverride.remainingHits !== undefined) {
      if (this.globalOverride.remainingHits <= 0) {
        this.globalOverride = null;
        return null;
      }
      this.globalOverride.remainingHits -= 1;
    }

    return this.globalOverride;
  }

  public savePerson(person: MockPerson): void {
    this.persons.set(person.aliasID, person);
    this.personsById.set(person.personID, person);
  }

  public getPersonByAlias(aliasID: string): MockPerson | undefined {
    return this.persons.get(aliasID);
  }

  public getPersonById(personID: string): MockPerson | undefined {
    return this.personsById.get(personID);
  }

  public deletePerson(personID: string): boolean {
    const p = this.personsById.get(personID);
    if (!p) return false;
    this.persons.delete(p.aliasID);
    this.personsById.delete(personID);
    return true;
  }

  public getSnapshot() {
    return {
      totalPersons: this.persons.size,
      globalScenario: this.globalOverride,
      callCounters: this.callCounters,
      recentCalls: [...this.callHistory].reverse().slice(0, 20)
    };
  }
}

export const mockState = new MockStateStore();
