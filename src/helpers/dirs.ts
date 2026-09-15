// Shared storage directories. Extracted from index.tsx so route modules can
// import them without pulling in the app entrypoint (needed for API/MCP tests).
export const uploadsDir = "./data/uploads/";
export const outputDir = "./data/output/";
