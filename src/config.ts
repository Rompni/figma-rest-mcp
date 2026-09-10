const TOKEN_HELP =
  "Missing FIGMA_ACCESS_TOKEN. Create a Figma personal access token in Settings → Security → Personal access tokens, then set it in the environment or a .env file. See .env.example.";

export function requireAccessToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.FIGMA_ACCESS_TOKEN?.trim();
  if (!token) {
    throw new Error(TOKEN_HELP);
  }
  return token;
}

/** Opt-in Desktop canvas write. Default off — core MCP is REST-only / headless. */
export function isWriteBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.FIGMA_ENABLE_WRITE_BRIDGE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}
