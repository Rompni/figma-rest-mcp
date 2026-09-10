/**
 * Figma REST cannot list a user's teams. team_id is taken from the team URL
 * in the Figma file browser, after `/team/`.
 *
 * Examples:
 * - https://www.figma.com/files/team/1535685101263221741
 * - https://www.figma.com/files/181033233908053158/team/1535685101263221741
 * - raw numeric id
 */
const TEAM_URL_RE = /(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:files\/(?:[^/?#]+\/)?team\/|team\/)(\d+)/i;
const PROJECT_URL_RE =
  /(?:https?:\/\/)?(?:www\.)?figma\.com\/(?:files\/)?project\/(\d+)/i;

export function parseTeamId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error(
      "Empty team id. Figma REST does not return team_id from GET /v1/me. Open the team in Figma and copy the id after /team/ in the URL (e.g. https://www.figma.com/files/team/<team_id>), or pass a numeric id.",
    );
  }

  const fromUrl = trimmed.match(TEAM_URL_RE);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Could not parse a Figma team id from: ${trimmed}. Pass a numeric id or a URL like https://www.figma.com/files/team/<team_id>. GET /v1/me does not include team_id.`,
  );
}

export function parseProjectId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Empty project id.");
  }

  const fromUrl = trimmed.match(PROJECT_URL_RE);
  if (fromUrl?.[1]) {
    return fromUrl[1];
  }

  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Could not parse a Figma project id from: ${trimmed}. Pass a numeric id or a URL like https://www.figma.com/files/project/<project_id>.`,
  );
}
