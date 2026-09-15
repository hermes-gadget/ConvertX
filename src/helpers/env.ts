export const ACCOUNT_REGISTRATION =
  process.env.ACCOUNT_REGISTRATION?.toLowerCase() === "true" || false;

export const HTTP_ALLOWED = process.env.HTTP_ALLOWED?.toLowerCase() === "true" || false;

export const ALLOW_UNAUTHENTICATED =
  process.env.ALLOW_UNAUTHENTICATED?.toLowerCase() === "true" || false;

export const AUTO_DELETE_EVERY_N_HOURS = process.env.AUTO_DELETE_EVERY_N_HOURS
  ? Number(process.env.AUTO_DELETE_EVERY_N_HOURS)
  : 24;

export const HIDE_HISTORY = process.env.HIDE_HISTORY?.toLowerCase() === "true" || false;

export const BRANDING = process.env.BRANDING ?? "ConvertX";

export const WEBROOT = process.env.WEBROOT ?? "";

export const LANGUAGE = process.env.LANGUAGE?.toLowerCase() || "en";

export const MAX_CONVERT_PROCESS =
  process.env.MAX_CONVERT_PROCESS && Number(process.env.MAX_CONVERT_PROCESS) > 0
    ? Number(process.env.MAX_CONVERT_PROCESS)
    : 0;

export const UNAUTHENTICATED_USER_SHARING =
  process.env.UNAUTHENTICATED_USER_SHARING?.toLowerCase() === "true" || false;

export const TIMEZONE = process.env.TZ || undefined;

// Fork additions (hermes-gadget): REST API + MCP endpoint
export const API_TOKEN = process.env.API_TOKEN ?? "";

export const API_USER_EMAIL = process.env.API_USER_EMAIL ?? "api@convertx.local";

export const API_MAX_UPLOAD_MB =
  process.env.API_MAX_UPLOAD_MB && Number(process.env.API_MAX_UPLOAD_MB) > 0
    ? Number(process.env.API_MAX_UPLOAD_MB)
    : 512;

export const API_SYNC_WAIT_SECONDS =
  process.env.API_SYNC_WAIT_SECONDS && Number(process.env.API_SYNC_WAIT_SECONDS) > 0
    ? Number(process.env.API_SYNC_WAIT_SECONDS)
    : 600;
