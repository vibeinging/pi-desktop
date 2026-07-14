import { listSessionTraces } from "../app/observability/trace_service.js";

export const observabilityRoutes = [
  { m: "GET", p: "/api/agent/projects/:pid/sessions/:sid/traces", fn: listSessionTraces },
];
