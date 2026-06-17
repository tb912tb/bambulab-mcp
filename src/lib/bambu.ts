// Bambu Lab cloud HTTP client — reverse-engineered endpoints.
// See: https://github.com/Doridian/OpenBambuAPI/blob/main/cloud-http.md
//      https://github.com/greghesp/ha-bambulab/blob/main/custom_components/bambu_lab/pybambu/bambu_cloud.py

export type BambuRegion = "world" | "china";

const HOSTS: Record<BambuRegion, string> = {
  world: "https://api.bambulab.com",
  china: "https://api.bambulab.cn",
};

// These headers mirror what Bambu Studio / Orca Slicer send. Without them
// Cloudflare aggressively flags the request (403 with a Cloudflare-branded body).
const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "bambu_network_agent/01.09.05.01",
  "X-BBL-Client-Name": "OrcaSlicer",
  "X-BBL-Client-Type": "slicer",
  "X-BBL-Client-Version": "01.09.05.51",
  "X-BBL-Language": "en-US",
  "X-BBL-OS-Type": "linux",
  "X-BBL-OS-Version": "6.2.0",
  "X-BBL-Agent-Version": "01.09.05.01",
  "X-BBL-Executable-Name": "bambu_network_agent",
  "X-BBL-Agent-OS-Type": "linux",
};

// ── Response types ──────────────────────────────────────────────────────────

export type LoginResult =
  | { kind: "token"; accessToken: string; refreshToken: string; expiresIn: number }
  | { kind: "verifyCode" }
  | { kind: "tfa"; tfaKey: string };

export type Task = {
  id: number;
  designId?: number;
  modelId?: string;
  title?: string;
  cover?: string;
  status: number; // 1=printing, 2=finished, 3=failed
  feedbackStatus?: number;
  startTime?: string;
  endTime?: string;
  weight?: number; // grams
  costTime?: number; // seconds
  profileId?: number;
  plateIndex?: number;
  deviceId?: string;
  deviceName?: string;
  deviceModel?: string;
  amsDetailMapping?: unknown[];
  mode?: string;
};

export type TasksResponse = { total: number; hits: Task[] };

export type Device = {
  dev_id: string;
  name: string;
  online: boolean;
  print_status: string;
  dev_model_name: string;
  dev_product_name: string;
  dev_access_code: string;
};

// ── Cloudflare / network error helper ───────────────────────────────────────

export class BambuApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: string,
    public cloudflare: boolean = false
  ) {
    super(message);
    this.name = "BambuApiError";
  }
}

// ── Unauthenticated auth calls ──────────────────────────────────────────────

/**
 * POST /v1/user-service/user/login — step 1 or step 2 of login.
 * Supply EITHER password OR code (never both).
 */
export async function login(params: {
  account: string;
  password?: string;
  code?: string;
  region?: BambuRegion;
}): Promise<LoginResult> {
  const region = params.region ?? "world";
  const url = `${HOSTS[region]}/v1/user-service/user/login`;

  const body: Record<string, string> = { account: params.account };
  if (params.password) body.password = params.password;
  if (params.code) body.code = params.code;

  const res = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    const cf = /cloudflare/i.test(text);
    throw new BambuApiError(
      cf ? "Cloudflare blocked the request — try again later" : `Login failed (${res.status})`,
      res.status,
      text,
      cf
    );
  }

  let json: {
    accessToken?: string;
    refreshToken?: string;
    expiresIn?: number;
    loginType?: string;
    tfaKey?: string;
  };
  try {
    json = JSON.parse(text);
  } catch {
    throw new BambuApiError("Invalid JSON from login endpoint", res.status, text);
  }

  if (json.loginType === "verifyCode") return { kind: "verifyCode" };
  if (json.loginType === "tfa" && json.tfaKey) return { kind: "tfa", tfaKey: json.tfaKey };
  if (json.accessToken) {
    return {
      kind: "token",
      accessToken: json.accessToken,
      refreshToken: json.refreshToken ?? json.accessToken,
      expiresIn: json.expiresIn ?? 7_776_000,
    };
  }
  throw new BambuApiError("Unexpected login response shape", res.status, text);
}

/**
 * POST /v1/user-service/user/sendemail/code — request the email verification
 * code (triggers Bambu to send the user an email with a 6-digit code).
 */
export async function sendEmailCode(email: string, region: BambuRegion = "world"): Promise<void> {
  const url = `${HOSTS[region]}/v1/user-service/user/sendemail/code`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ email, type: "codeLogin" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new BambuApiError(`Email code request failed (${res.status})`, res.status, text);
  }
}

/**
 * POST https://bambulab.com/api/sign-in/tfa — complete TOTP-style two-factor.
 * Note: different host than the rest of the API; token comes back in a cookie.
 */
export async function verifyTfa(tfaKey: string, tfaCode: string): Promise<string> {
  const res = await fetch("https://bambulab.com/api/sign-in/tfa", {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({ tfaKey, tfaCode }),
    redirect: "manual",
  });

  // The token is returned in a `token` cookie, not JSON.
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/(?:^|,\s*)token=([^;]+)/);
  if (!match) {
    const text = await res.text().catch(() => "");
    throw new BambuApiError(`TFA verification failed (${res.status})`, res.status, text);
  }
  return decodeURIComponent(match[1]);
}

// ── Authenticated client ────────────────────────────────────────────────────

export class BambuClient {
  private baseUrl: string;
  private authHeaders: Record<string, string>;

  constructor(accessToken: string, region: BambuRegion = "world") {
    this.baseUrl = HOSTS[region];
    this.authHeaders = {
      ...DEFAULT_HEADERS,
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string | number | undefined>,
    body?: unknown
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: body
        ? { ...this.authHeaders, "Content-Type": "application/json" }
        : this.authHeaders,
      body: body != null ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      const cf = /cloudflare/i.test(text);
      throw new BambuApiError(
        `${method} ${path} → ${res.status}${cf ? " (Cloudflare block)" : ""}`,
        res.status,
        text,
        cf
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  // ── Devices ─────────────────────────────────────────────────────────────

  /** GET /v1/iot-service/api/user/bind — list printers bound to the account. */
  listDevices() {
    return this.request<{ message: string; devices: Device[] }>(
      "GET",
      "/v1/iot-service/api/user/bind"
    );
  }

  // ── Print history (THE important one) ───────────────────────────────────

  /**
   * GET /v1/user-service/my/tasks — list past & current print tasks.
   * `after` is an opaque cursor (use the last `hits[].id` from the previous page).
   */
  listTasks(params?: { deviceId?: string; after?: string; limit?: number }) {
    return this.request<TasksResponse>("GET", "/v1/user-service/my/tasks", {
      deviceId: params?.deviceId,
      after: params?.after,
      limit: params?.limit ?? 25,
    });
  }

  /** GET /v1/user-service/my/task/{id} — single task detail. */
  getTask(id: number) {
    return this.request<Task>("GET", `/v1/user-service/my/task/${id}`);
  }

  // ── Projects (richer per-print filament / plate data) ──────────────────

  /** GET /v1/iot-service/api/user/project — list all projects. */
  listProjects() {
    return this.request<unknown>("GET", "/v1/iot-service/api/user/project");
  }

  /** GET /v1/iot-service/api/user/project/{id} — full project, incl. per-filament grams/meters. */
  getProject(projectId: string) {
    return this.request<unknown>("GET", `/v1/iot-service/api/user/project/${projectId}`);
  }

  // ── Live status ─────────────────────────────────────────────────────────

  /** GET /v1/iot-service/api/user/print?force=true — current live status for all devices. */
  getLiveStatus() {
    return this.request<unknown>(
      "GET",
      "/v1/iot-service/api/user/print",
      { force: "true" }
    );
  }

  // ── Print control ────────────────────────────────────────────────────────

  /**
   * POST /v1/user-service/my/task — start a print job from a saved project profile.
   *
   * Prerequisites:
   *   1. The .3mf must already be sliced and uploaded to Bambu Cloud as a project.
   *   2. Get the profileId from get_project → profiles[0].profile_id.
   *   3. Get the deviceId from list_printers → devices[].dev_id.
   *
   * plateIndex defaults to 1 (first plate). Most single-model prints only have one plate.
   */
  startPrint(params: {
    deviceId: string;
    profileId: number;
    plateIndex?: number;
  }) {
    return this.request<unknown>("POST", "/v1/user-service/my/task", undefined, {
      deviceId: params.deviceId,
      profileId: params.profileId,
      plateIndex: params.plateIndex ?? 1,
      mode: "cloud_file",
      repetitions: 1,
    });
  }

  // ── Misc ────────────────────────────────────────────────────────────────

  /** GET /v1/design-user-service/my/preference — includes numeric `uid` (for MQTT). */
  getUserPreference() {
    return this.request<unknown>("GET", "/v1/design-user-service/my/preference");
  }

  /** GET /v1/user-service/my/messages — notifications / feed. */
  getMessages(params?: { after?: string; limit?: number; type?: string }) {
    return this.request<unknown>("GET", "/v1/user-service/my/messages", {
      after: params?.after,
      limit: params?.limit ?? 25,
      type: params?.type,
    });
  }

  /** Cheap auth probe — validates the access token is still good. */
  async validate(): Promise<boolean> {
    try {
      await this.listDevices();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Aggregate filament usage from the tasks list. Client-side summary because
   * Bambu does not expose a "total grams by filament" endpoint.
   */
  async getFilamentUsageSummary(params?: {
    deviceId?: string;
    maxPages?: number;
    since?: string; // ISO date — only count tasks that started on/after this
  }) {
    const maxPages = params?.maxPages ?? 5;
    const since = params?.since ? new Date(params.since).getTime() : 0;
    let after: string | undefined;
    let totalGrams = 0;
    let totalSeconds = 0;
    let finished = 0;
    let failed = 0;
    let inProgress = 0;
    const perDevice: Record<string, { grams: number; seconds: number; count: number }> = {};

    for (let i = 0; i < maxPages; i++) {
      const page = await this.listTasks({
        deviceId: params?.deviceId,
        after,
        limit: 50,
      });
      if (!page.hits?.length) break;

      for (const t of page.hits) {
        if (since && t.startTime) {
          const ts = new Date(t.startTime).getTime();
          if (ts < since) continue;
        }
        const grams = t.weight ?? 0;
        const seconds = t.costTime ?? 0;
        totalGrams += grams;
        totalSeconds += seconds;
        if (t.status === 2) finished++;
        else if (t.status === 3) failed++;
        else if (t.status === 1) inProgress++;
        if (t.deviceId) {
          const d = (perDevice[t.deviceId] ??= { grams: 0, seconds: 0, count: 0 });
          d.grams += grams;
          d.seconds += seconds;
          d.count++;
        }
      }

      if (page.hits.length < 50) break;
      after = String(page.hits[page.hits.length - 1].id);
    }

    return {
      totalGrams: Math.round(totalGrams * 10) / 10,
      totalHours: Math.round((totalSeconds / 3600) * 10) / 10,
      totalSeconds,
      counts: { finished, failed, inProgress, total: finished + failed + inProgress },
      perDevice,
      pagesScanned: maxPages,
    };
  }
}
