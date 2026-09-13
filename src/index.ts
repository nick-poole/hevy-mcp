/**
 * hevy-mcp: a stateless MCP server on Cloudflare Workers that exposes one
 * Hevy account to Claude.
 *
 * Request flow
 *   claude.ai connector  -->  https://<worker>/mcp/<MCP_PATH_TOKEN>
 *                             |  token check (constant time)
 *                             v
 *                        createMcpHandler (agents/mcp/server)
 *                             |  builds a fresh McpServer per request
 *                             v
 *                        Hevy REST API  https://api.hevyapp.com/v1
 *
 * Reads: workouts, routines, routine folders, exercise templates, exercise history.
 * Writes: routines only (create + update). Workouts stay read-only in v1.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, type StatelessMcpHandler } from "agents/mcp/server";
import { z } from "zod";
import { createHevyClient, seg } from "./hevy";

interface Env {
  HEVY_API_KEY: string;
  MCP_PATH_TOKEN: string;
}

const SERVER_VERSION = "0.1.0";
const MCP_PREFIX = "/mcp/";

// ---------------------------------------------------------------------------
// Input schemas (verified against the Hevy OpenAPI spec, Sept 2026)
// ---------------------------------------------------------------------------

const page = z.number().int().min(1).default(1).describe("Page number, starting at 1");
const pageSize10 = z.number().int().min(1).max(10).default(10).describe("Items per page (max 10)");
const pageSize100 = z.number().int().min(1).max(100).default(100).describe("Items per page (max 100)");

const paged10 = z.object({ page, pageSize: pageSize10 });

const routineSet = z.object({
  type: z.enum(["warmup", "normal", "failure", "dropset"]).default("normal"),
  weight_kg: z.number().nullable().optional().describe("Weight in kilograms"),
  reps: z.number().int().nullable().optional(),
  distance_meters: z.number().int().nullable().optional(),
  duration_seconds: z.number().int().nullable().optional(),
  custom_metric: z.number().nullable().optional().describe("Used for steps and floors"),
  rep_range: z
    .object({ start: z.number().nullable().optional(), end: z.number().nullable().optional() })
    .nullable()
    .optional()
    .describe("Target rep range, e.g. { start: 8, end: 12 }")
});

const routineExercise = z.object({
  exercise_template_id: z.string().describe("Template id from get_exercise_templates, e.g. D04AC939"),
  superset_id: z.number().int().nullable().optional().describe("Exercises sharing an id form a superset"),
  rest_seconds: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  sets: z.array(routineSet).min(1)
});

const routineBody = z.object({
  title: z.string().min(1),
  folder_id: z.number().nullable().optional().describe("Folder id from get_routine_folders, or null for My Routines"),
  notes: z.string().nullable().optional(),
  exercises: z.array(routineExercise).min(1)
});

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE_CREATE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const WRITE_UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

// ---------------------------------------------------------------------------
// Server factory: one McpServer per request, all tools bound to one API key
// ---------------------------------------------------------------------------

function buildServer(env: Env): McpServer {
  const hevy = createHevyClient(env.HEVY_API_KEY);

  const server = new McpServer(
    { name: "hevy-mcp", version: SERVER_VERSION },
    {
      instructions: [
        "Tools for one Hevy (weightlifting tracker) account.",
        "Weights are kilograms, durations are seconds, distances are meters, timestamps are ISO 8601.",
        "List endpoints are paginated: workouts, routines and folders allow at most 10 per page; exercise templates allow 100.",
        "Writes are limited to routines. Workouts and body measurements are read-only here.",
        "update_routine replaces the whole routine, so call get_routine first and send back the full exercise list with your edits."
      ].join(" ")
    }
  );

  // ----- Workouts (read-only) ---------------------------------------------

  server.registerTool(
    "get_workouts",
    {
      title: "List workouts",
      description: "Paginated list of logged workouts, newest first. Max 10 per page.",
      inputSchema: paged10,
      annotations: READ
    },
    ({ page, pageSize }) => run(() => hevy.get("/workouts", { page, pageSize }))
  );

  server.registerTool(
    "get_workout",
    {
      title: "Get workout",
      description: "Full details of one workout, including every exercise and set.",
      inputSchema: z.object({ workoutId: z.string().describe("Workout id (UUID)") }),
      annotations: READ
    },
    ({ workoutId }) => run(() => hevy.get(`/workouts/${seg(workoutId)}`))
  );

  server.registerTool(
    "get_workout_count",
    {
      title: "Count workouts",
      description: "Total number of workouts on the account.",
      annotations: READ
    },
    () => run(() => hevy.get("/workouts/count"))
  );

  server.registerTool(
    "get_workout_events",
    {
      title: "List workout events",
      description:
        "Workouts updated or deleted since a timestamp, for incremental syncs. Returns 'updated' events with the workout and 'deleted' events with the id.",
      inputSchema: z.object({
        since: z.string().default("1970-01-01T00:00:00Z").describe("ISO 8601 timestamp, e.g. 2026-09-01T00:00:00Z"),
        page,
        pageSize: pageSize10
      }),
      annotations: READ
    },
    ({ since, page, pageSize }) => run(() => hevy.get("/workouts/events", { since, page, pageSize }))
  );

  // ----- Routines (read + write) ------------------------------------------

  server.registerTool(
    "get_routines",
    {
      title: "List routines",
      description: "Paginated list of saved routines with their exercises and target sets. Max 10 per page.",
      inputSchema: paged10,
      annotations: READ
    },
    ({ page, pageSize }) => run(() => hevy.get("/routines", { page, pageSize }))
  );

  server.registerTool(
    "get_routine",
    {
      title: "Get routine",
      description: "One routine by id.",
      inputSchema: z.object({ routineId: z.string().describe("Routine id (UUID)") }),
      annotations: READ
    },
    ({ routineId }) => run(() => hevy.get(`/routines/${seg(routineId)}`))
  );

  server.registerTool(
    "get_routine_folders",
    {
      title: "List routine folders",
      description: "Paginated list of routine folders. Use folder ids when creating routines. Max 10 per page.",
      inputSchema: paged10,
      annotations: READ
    },
    ({ page, pageSize }) => run(() => hevy.get("/routine_folders", { page, pageSize }))
  );

  server.registerTool(
    "create_routine",
    {
      title: "Create routine",
      description:
        "Create a new routine in Hevy. Look up exercise_template_id values with get_exercise_templates first. Returns the created routine.",
      inputSchema: z.object({ routine: routineBody }),
      annotations: WRITE_CREATE
    },
    ({ routine }) => run(() => hevy.post("/routines", { routine }))
  );

  server.registerTool(
    "update_routine",
    {
      title: "Update routine",
      description:
        "Replace an existing routine's title, folder, notes and full exercise list. Omitted exercises are removed, so send the complete routine.",
      inputSchema: z.object({
        routineId: z.string().describe("Routine id (UUID)"),
        routine: routineBody
      }),
      annotations: WRITE_UPDATE
    },
    ({ routineId, routine }) => run(() => hevy.put(`/routines/${seg(routineId)}`, { routine }))
  );

  // ----- Exercises (read-only) ---------------------------------------------

  server.registerTool(
    "get_exercise_templates",
    {
      title: "List exercise templates",
      description:
        "Paginated catalogue of exercises (built-in and custom) with ids, muscle groups and equipment. Max 100 per page.",
      inputSchema: z.object({ page, pageSize: pageSize100 }),
      annotations: READ
    },
    ({ page, pageSize }) => run(() => hevy.get("/exercise_templates", { page, pageSize }))
  );

  server.registerTool(
    "get_exercise_template",
    {
      title: "Get exercise template",
      description: "One exercise template by id.",
      inputSchema: z.object({ exerciseTemplateId: z.string().describe("Template id, e.g. D04AC939") }),
      annotations: READ
    },
    ({ exerciseTemplateId }) => run(() => hevy.get(`/exercise_templates/${seg(exerciseTemplateId)}`))
  );

  server.registerTool(
    "get_exercise_history",
    {
      title: "Get exercise history",
      description: "Every logged set of one exercise across workouts, optionally within a date range. Useful for progress tracking.",
      inputSchema: z.object({
        exerciseTemplateId: z.string().describe("Template id, e.g. D04AC939"),
        start_date: z.string().optional().describe("ISO 8601 date-time lower bound"),
        end_date: z.string().optional().describe("ISO 8601 date-time upper bound")
      }),
      annotations: READ
    },
    ({ exerciseTemplateId, start_date, end_date }) =>
      run(() => hevy.get(`/exercise_history/${seg(exerciseTemplateId)}`, { start_date, end_date }))
  );

  return server;
}

// ---------------------------------------------------------------------------
// Worker entry point
// ---------------------------------------------------------------------------

async function tokensMatch(supplied: string, expected: string): Promise<boolean> {
  const enc = new TextEncoder();
  const a = enc.encode(supplied);
  const b = enc.encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

// The handler is built once per isolate. Secrets are fixed for a deployment,
// so caching on the token is safe and avoids rebuilding routing per request.
let cached: { token: string; handler: StatelessMcpHandler } | undefined;

function handlerFor(env: Env): StatelessMcpHandler {
  if (!cached || cached.token !== env.MCP_PATH_TOKEN) {
    cached = {
      token: env.MCP_PATH_TOKEN,
      handler: createMcpHandler(() => buildServer(env), {
        route: MCP_PREFIX + env.MCP_PATH_TOKEN,
        corsOptions: false
      })
    };
  }
  return cached.handler;
}

export default {
  async fetch(request, env, ctx) {
    if (!env.HEVY_API_KEY || !env.MCP_PATH_TOKEN) {
      return new Response("Server misconfigured: missing HEVY_API_KEY or MCP_PATH_TOKEN", { status: 500 });
    }

    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(MCP_PREFIX)) return new Response("Not Found", { status: 404 });

    const supplied = pathname.slice(MCP_PREFIX.length);
    if (!(await tokensMatch(supplied, env.MCP_PATH_TOKEN))) return new Response("Not Found", { status: 404 });

    return handlerFor(env)(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
