import { BambuClient } from "@/lib/bambu";

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const TOOLS: ToolDefinition[] = [
  // ── Printers / devices ────────────────────────────────────────────────────
  {
    name: "list_printers",
    description:
      "List all Bambu Lab printers bound to the user's account. Returns serial, name, model, online state, current print_status, and the LAN access_code.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Print history — primary endpoint ──────────────────────────────────────
  {
    name: "list_prints",
    description:
      "List print tasks (history) for the user's account. Returns id, title, status (1=printing, 2=finished, 3=failed), startTime, endTime, weight (grams), costTime (seconds), deviceId, cover image, etc. Use `after` (last id from previous page) for pagination.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "Filter to a single printer (serial)" },
        after: { type: "string", description: "Opaque cursor — pass the last task id from the previous page" },
        limit: { type: "number", description: "Page size (default 25, max ~50)" },
      },
    },
  },
  {
    name: "get_print",
    description: "Get details for a single print task by id.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Task id (from list_prints)" },
      },
      required: ["id"],
    },
  },
  {
    name: "get_filament_usage_summary",
    description:
      "Aggregate total grams printed, total hours, and success/fail counts across recent tasks. Optionally filter by device and start date. Scans up to `maxPages` of 50 tasks each.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: { type: "string", description: "Filter to a single printer" },
        since: {
          type: "string",
          description: "ISO date (e.g. '2026-01-01') — only count tasks that started on/after this",
        },
        maxPages: { type: "number", description: "Max pages of 50 tasks to scan (default 5 = 250 tasks)" },
      },
    },
  },

  // ── Projects (richer per-print data: per-filament grams/meters) ──────────
  {
    name: "list_projects",
    description:
      "List projects owned by the user. A project is a higher-level container than a task — it bundles the sliced plates, filaments, and downloads for a model. Use this to find a project_id before calling get_project.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_project",
    description:
      "Get full project details including profiles[].profile_id (needed to start a print) and profiles[].context.plates[].filaments[] (per-filament color, material, grams, meters used).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Project id (from list_projects)" },
      },
      required: ["id"],
    },
  },

  // ── Live / current status ─────────────────────────────────────────────────
  {
    name: "get_live_status",
    description:
      "Get the current live status (task_id, progress %, temperatures, thumbnail) for every printer bound to this account. Cloud-side snapshot — use LAN MQTT for continuous updates.",
    inputSchema: { type: "object", properties: {} },
  },

  // ── Print control ─────────────────────────────────────────────────────────
  {
    name: "start_print",
    description:
      "Start a print job on a Bambu Lab printer using a project already sliced and saved to Bambu Cloud. Workflow: (1) call list_projects to find the project by name, (2) call get_project with its id to get the profileId from profiles[0].profile_id, (3) call this tool with the printer's deviceId and that profileId. The printer must be online.",
    inputSchema: {
      type: "object",
      properties: {
        deviceId: {
          type: "string",
          description: "Printer serial number — dev_id from list_printers (e.g. '03919D4C1200374')",
        },
        profileId: {
          type: "number",
          description: "Profile ID from get_project → profiles[0].profile_id",
        },
        plateIndex: {
          type: "number",
          description: "Which plate to print (default 1 — most single-model prints only have one plate)",
        },
      },
      required: ["deviceId", "profileId"],
    },
  },

  // ── Account / misc ────────────────────────────────────────────────────────
  {
    name: "get_user_preference",
    description: "Get the user's profile preferences. Contains the numeric `uid` used as the MQTT username prefix.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_messages",
    description: "List notifications / messages for the user's account.",
    inputSchema: {
      type: "object",
      properties: {
        after: { type: "string" },
        limit: { type: "number" },
        type: { type: "string" },
      },
    },
  },
];

type ToolInput = Record<string, unknown>;

export async function callTool(
  name: string,
  input: ToolInput,
  client: BambuClient
): Promise<unknown> {
  switch (name) {
    case "list_printers":
      return client.listDevices();

    case "list_prints":
      return client.listTasks({
        deviceId: input.deviceId as string | undefined,
        after: input.after as string | undefined,
        limit: input.limit as number | undefined,
      });

    case "get_print":
      return client.getTask(input.id as number);

    case "get_filament_usage_summary":
      return client.getFilamentUsageSummary({
        deviceId: input.deviceId as string | undefined,
        since: input.since as string | undefined,
        maxPages: input.maxPages as number | undefined,
      });

    case "list_projects":
      return client.listProjects();

    case "get_project":
      return client.getProject(input.id as string);

    case "get_live_status":
      return client.getLiveStatus();

    case "start_print":
      return client.startPrint({
        deviceId: input.deviceId as string,
        profileId: input.profileId as number,
        plateIndex: input.plateIndex as number | undefined,
      });

    case "get_user_preference":
      return client.getUserPreference();

    case "list_messages":
      return client.getMessages({
        after: input.after as string | undefined,
        limit: input.limit as number | undefined,
        type: input.type as string | undefined,
      });

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
