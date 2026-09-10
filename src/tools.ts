import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FigmaApiError } from "./errors.js";
import type { FigmaRestClient } from "./figma-client.js";
import { parseNodeId } from "./node-ids.js";
import { applyFileMode, type FileMode } from "./trim.js";

const fileInput = z
  .string()
  .min(1)
  .describe("Figma file key or URL (figma.com/design/... or figma.com/file/...)");

const teamInput = z
  .string()
  .min(1)
  .describe(
    "Team id or team URL (figma.com/files/team/<id> or figma.com/files/<org>/team/<id>). REST /v1/me does not return team_id.",
  );

const teamIdAlias = z
  .string()
  .min(1)
  .optional()
  .describe("Alias of team: numeric team id or team URL.");

const projectInput = z
  .string()
  .min(1)
  .describe("Project id or URL (figma.com/files/project/<id>).");

const idsInput = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe("Node ids, comma-separated or as an array. URL form 1-2 is normalized to 1:2.");

const formatInput = z
  .enum(["png", "jpg", "svg", "pdf"])
  .default("png")
  .describe("Export format. Defaults to png.");

const fileModeInput = z
  .enum(["full", "trim", "summary"])
  .optional()
  .describe(
    "Payload size: summary = id/name/type/layout/text only; trim = drop noisy keys (prototypeDevice, styleOverrideTable, interactions, …); full = raw REST JSON. Default trim.",
  );

const pageSizeInput = z.number().int().min(1).max(1000).optional().describe("Page size (Figma default 30).");
const autoPaginateInput = z
  .boolean()
  .optional()
  .describe("Follow pagination automatically (default true).");

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const writeHint = { readOnlyHint: false, openWorldHint: true } as const;
const destructive = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function jsonResult(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const text =
    err instanceof FigmaApiError ? err.message : err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}

function resolveTeam(team: string | undefined, teamId?: string): string {
  return (team?.trim() || teamId?.trim() || process.env.FIGMA_TEAM_ID?.trim() || "").trim();
}

function asFileMode(mode: FileMode | undefined): FileMode {
  return mode ?? "trim";
}

function resolveContextNodeId(file: string, nodeId?: string): string {
  if (nodeId?.trim()) {
    return parseNodeId(nodeId);
  }
  try {
    return parseNodeId(file);
  } catch {
    throw new Error(
      "get_design_context_lite requires node_id, or a file URL that includes ?node-id=. Pass the root frame id to snapshot.",
    );
  }
}

export function registerTools(server: McpServer, figma: FigmaRestClient): void {
  server.registerTool(
    "whoami",
    {
      title: "Figma whoami",
      description:
        "GET /v1/me — the user that owns FIGMA_ACCESS_TOKEN. Does not include team_id; pass a team URL or id to list_projects (or set FIGMA_TEAM_ID).",
      annotations: readOnly,
    },
    async () => {
      try {
        return jsonResult(await figma.whoami());
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file",
    {
      title: "Get Figma file",
      description:
        "GET /v1/files/{key} — file JSON. depth defaults to 2. mode=trim|summary|full shrinks node payloads (see README).",
      inputSchema: {
        file: fileInput,
        depth: z.number().int().min(1).max(20).optional().describe("Node levels to include. Default 2."),
        geometry: z.string().optional().describe("Optional geometry mode, e.g. paths."),
        ids: idsInput.optional(),
        version: z.string().optional().describe("Optional version id from get_file_versions."),
        mode: fileModeInput,
      },
      annotations: readOnly,
    },
    async ({ file, depth, geometry, ids, version, mode }) => {
      try {
        const data = await figma.getFile(file, { depth, geometry, ids, version });
        return jsonResult(applyFileMode(data, asFileMode(mode)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_nodes",
    {
      title: "Get Figma nodes",
      description: "GET /v1/files/{key}/nodes?ids=... — specific nodes by id. Supports mode=trim|summary|full.",
      inputSchema: {
        file: fileInput,
        ids: idsInput,
        depth: z.number().int().min(1).max(20).optional().describe("Optional subtree depth."),
        geometry: z.string().optional(),
        mode: fileModeInput,
      },
      annotations: readOnly,
    },
    async ({ file, ids, depth, geometry, mode }) => {
      try {
        const data = await figma.getNodes(file, ids, { depth, geometry });
        return jsonResult(applyFileMode(data, asFileMode(mode)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_design_context_lite",
    {
      title: "Get design context (REST lite)",
      description:
        "REST-only codegen snapshot for a subtree: identity, bbox, best-effort CSS flex from auto-layout, text + typography, fill/stroke summaries, component/instance ids. Optional include_tokens attaches a compact token summary (variables or labeled fallback). Not official MCP get_design_context. Image fills are refs — use get_images or bundle_image_fills for pixels.",
      inputSchema: {
        file: fileInput,
        node_id: z
          .string()
          .min(1)
          .optional()
          .describe("Target node id (1:2 or 1-2). Optional if the file URL already has ?node-id=."),
        depth: z
          .number()
          .int()
          .min(1)
          .max(16)
          .optional()
          .describe("REST subtree depth. Default 6."),
        max_nodes: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe("Cap mapped nodes so the payload fits a context window. Default 80."),
        format: z
          .enum(["json", "markdown", "both"])
          .optional()
          .describe("json (default) slim tree; markdown compact outline; both."),
        include_tokens: z
          .boolean()
          .optional()
          .describe(
            "If true, attach a compact tokens summary (real variables when Enterprise+file_variables:read, else styles/inferred fallback). Default false so the tree stays small; use get_variable_defs for the full token list.",
          ),
      },
      annotations: readOnly,
    },
    async ({ file, node_id, depth, max_nodes, format, include_tokens }) => {
      try {
        const nodeId = resolveContextNodeId(file, node_id);
        const includeMarkdown = format === "markdown" || format === "both";
        const ctx = await figma.getDesignContextLite(file, nodeId, {
          depth,
          maxNodes: max_nodes,
          includeMarkdown,
          includeTokens: include_tokens,
        });
        if (format === "markdown") {
          return {
            content: [{ type: "text" as const, text: ctx.markdown ?? JSON.stringify(ctx, null, 2) }],
          };
        }
        return jsonResult(ctx);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_images",
    {
      title: "Render Figma node images",
      description:
        "GET /v1/images/{key}?ids=&format= — render nodes to short-lived image URLs (png default). Distinct from get_image_fills (uploaded fill assets).",
      inputSchema: {
        file: fileInput,
        ids: idsInput,
        format: formatInput,
        scale: z.number().min(0.01).max(4).optional().describe("Render scale between 0.01 and 4."),
      },
      annotations: readOnly,
    },
    async ({ file, ids, format, scale }) => {
      try {
        return jsonResult(await figma.getImages(file, ids, { format, scale }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_image_fills",
    {
      title: "Get Figma image fills",
      description:
        "GET /v1/files/{key}/images — download URLs for images already uploaded as fills (imageRef). Not a node render; use get_images to rasterize frames.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getImageFills(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "bundle_image_fills",
    {
      title: "Bundle image fills as data URIs",
      description:
        "Design-to-code helper: GET /v1/files/{key}/images then download each fill (Figma/S3 hosts only). Returns imageRef → { contentType, byteLength, dataUri }. Skips assets over max_bytes (default 250KB). Not canvas mutation.",
      inputSchema: {
        file: fileInput,
        image_refs: z
          .union([z.string().min(1), z.array(z.string().min(1))])
          .optional()
          .describe("Optional imageRef filter (comma-separated or array)."),
        max_bytes: z.number().int().min(1024).max(2_000_000).optional(),
        max_assets: z.number().int().min(1).max(50).optional(),
      },
      annotations: readOnly,
    },
    async ({ file, image_refs, max_bytes, max_assets }) => {
      try {
        const refs = Array.isArray(image_refs)
          ? image_refs
          : image_refs
            ? image_refs.split(",").map((item) => item.trim()).filter(Boolean)
            : undefined;
        return jsonResult(await figma.bundleImageFills(file, { imageRefs: refs, maxBytes: max_bytes, maxAssets: max_assets }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "render_nodes_as_data_uri",
    {
      title: "Render nodes as data URIs",
      description:
        "GET /v1/images/{key} then download renders (Figma/S3 only) as data URIs. Same size/SSRF caps as bundle_image_fills. For design-to-code, not writing back to Figma.",
      inputSchema: {
        file: fileInput,
        ids: idsInput,
        format: formatInput,
        scale: z.number().min(0.01).max(4).optional(),
        max_bytes: z.number().int().min(1024).max(2_000_000).optional(),
        max_assets: z.number().int().min(1).max(50).optional(),
      },
      annotations: readOnly,
    },
    async ({ file, ids, format, scale, max_bytes, max_assets }) => {
      try {
        return jsonResult(
          await figma.renderNodesAsDataUri(file, ids, {
            format,
            scale,
            maxBytes: max_bytes,
            maxAssets: max_assets,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file_meta",
    {
      title: "Get Figma file metadata",
      description: "GET /v1/files/{key}/meta — lightweight file metadata (name, folder, thumbnail, role). Scope: file_metadata:read.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getFileMeta(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file_versions",
    {
      title: "Get Figma file versions",
      description:
        "GET /v1/files/{key}/versions — version history. Auto-follows pagination.next_page. Scope: file_versions:read.",
      inputSchema: {
        file: fileInput,
        page_size: z.number().int().min(1).max(50).optional(),
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ file, page_size, auto_paginate }) => {
      try {
        return jsonResult(
          await figma.getFileVersions(file, { pageSize: page_size, autoPaginate: auto_paginate }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List team projects",
      description:
        "GET /v1/teams/{team_id}/projects — projects visible to the PAT. Pass team (id or team URL) or set FIGMA_TEAM_ID. Scope: projects:read.",
      inputSchema: {
        team: teamInput.optional(),
        team_id: teamIdAlias,
      },
      annotations: readOnly,
    },
    async ({ team, team_id }) => {
      try {
        return jsonResult(await figma.listProjects(resolveTeam(team, team_id)));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "list_project_files",
    {
      title: "List project files",
      description: "GET /v1/projects/{project_id}/files — files in a project. Scope: projects:read.",
      inputSchema: {
        project: projectInput,
        branch_data: z.boolean().optional(),
      },
      annotations: readOnly,
    },
    async ({ project, branch_data }) => {
      try {
        return jsonResult(await figma.listProjectFiles(project, { branchData: branch_data }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_comments",
    {
      title: "Get Figma comments",
      description:
        "GET /v1/files/{key}/comments — Figma returns the full comment list (not cursor-paginated). Optional as_md.",
      inputSchema: {
        file: fileInput,
        as_md: z.boolean().optional().describe("Return rich-text comments as markdown when applicable."),
      },
      annotations: readOnly,
    },
    async ({ file, as_md }) => {
      try {
        return jsonResult(await figma.getComments(file, { asMd: as_md }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "post_comment",
    {
      title: "Post a Figma comment",
      description:
        "POST /v1/files/{key}/comments — add a comment or reply (comment_id of a root comment). Scope: file_comments:write.",
      inputSchema: {
        file: fileInput,
        message: z.string().min(1),
        comment_id: z.string().optional().describe("Root comment id to reply to."),
        x: z.number().optional().describe("Canvas x for a new pin (with y)."),
        y: z.number().optional().describe("Canvas y for a new pin (with x)."),
        node_id: z.string().optional().describe("Node to attach the comment to (with offset_x/offset_y)."),
        offset_x: z.number().optional(),
        offset_y: z.number().optional(),
      },
      annotations: writeHint,
    },
    async ({ file, message, comment_id, x, y, node_id, offset_x, offset_y }) => {
      try {
        let client_meta: unknown;
        if (node_id) {
          client_meta = { node_id, node_offset: { x: offset_x ?? 0, y: offset_y ?? 0 } };
        } else if (x !== undefined && y !== undefined) {
          client_meta = { x, y };
        }
        return jsonResult(await figma.postComment(file, { message, comment_id, client_meta }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a Figma comment",
      description: "DELETE /v1/files/{key}/comments/{comment_id} — only the author can delete. Scope: file_comments:write.",
      inputSchema: {
        file: fileInput,
        comment_id: z.string().min(1),
      },
      annotations: destructive,
    },
    async ({ file, comment_id }) => {
      try {
        return jsonResult(await figma.deleteComment(file, comment_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_comment_reactions",
    {
      title: "Get comment reactions",
      description: "GET /v1/files/{key}/comments/{comment_id}/reactions — auto-follows pagination.next_page.",
      inputSchema: {
        file: fileInput,
        comment_id: z.string().min(1),
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ file, comment_id, auto_paginate }) => {
      try {
        return jsonResult(await figma.getCommentReactions(file, comment_id, { autoPaginate: auto_paginate }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "post_comment_reaction",
    {
      title: "Add a comment reaction",
      description: "POST /v1/files/{key}/comments/{comment_id}/reactions — emoji shortcode such as :heart: or :+1:.",
      inputSchema: {
        file: fileInput,
        comment_id: z.string().min(1),
        emoji: z.string().min(1).describe("Emoji shortcode, e.g. :heart: or :+1:."),
      },
      annotations: writeHint,
    },
    async ({ file, comment_id, emoji }) => {
      try {
        return jsonResult(await figma.postCommentReaction(file, comment_id, emoji));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_comment_reaction",
    {
      title: "Delete a comment reaction",
      description: "DELETE /v1/files/{key}/comments/{comment_id}/reactions?emoji= — only the author can delete.",
      inputSchema: {
        file: fileInput,
        comment_id: z.string().min(1),
        emoji: z.string().min(1),
      },
      annotations: destructive,
    },
    async ({ file, comment_id, emoji }) => {
      try {
        return jsonResult(await figma.deleteCommentReaction(file, comment_id, emoji));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file_components",
    {
      title: "Get file components",
      description: "GET /v1/files/{key}/components — published components in a file library. Scope: library_content:read.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getFileComponents(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file_component_sets",
    {
      title: "Get file component sets",
      description: "GET /v1/files/{key}/component_sets — published component sets in a file library.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getFileComponentSets(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_file_styles",
    {
      title: "Get file styles",
      description: "GET /v1/files/{key}/styles — published styles in a file library. Scope: library_content:read.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getFileStyles(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_team_components",
    {
      title: "Get team components",
      description:
        "GET /v1/teams/{team_id}/components — published team library components. Auto-paginates meta.cursor.after. Scope: team_library_content:read.",
      inputSchema: {
        team: teamInput.optional(),
        team_id: teamIdAlias,
        page_size: pageSizeInput,
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ team, team_id, page_size, auto_paginate }) => {
      try {
        return jsonResult(
          await figma.getTeamComponents(resolveTeam(team, team_id), {
            pageSize: page_size,
            autoPaginate: auto_paginate,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_team_component_sets",
    {
      title: "Get team component sets",
      description:
        "GET /v1/teams/{team_id}/component_sets — published team library component sets. Auto-paginates meta.cursor.after. Scope: team_library_content:read.",
      inputSchema: {
        team: teamInput.optional(),
        team_id: teamIdAlias,
        page_size: pageSizeInput,
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ team, team_id, page_size, auto_paginate }) => {
      try {
        return jsonResult(
          await figma.getTeamComponentSets(resolveTeam(team, team_id), {
            pageSize: page_size,
            autoPaginate: auto_paginate,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_team_styles",
    {
      title: "Get team styles",
      description:
        "GET /v1/teams/{team_id}/styles — published team library styles. Auto-paginates meta.cursor.after. Scope: team_library_content:read.",
      inputSchema: {
        team: teamInput.optional(),
        team_id: teamIdAlias,
        page_size: pageSizeInput,
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ team, team_id, page_size, auto_paginate }) => {
      try {
        return jsonResult(
          await figma.getTeamStyles(resolveTeam(team, team_id), {
            pageSize: page_size,
            autoPaginate: auto_paginate,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_component",
    {
      title: "Get published component",
      description: "GET /v1/components/{key} — metadata for a published component key (library key, not a file key). Scope: library_assets:read.",
      inputSchema: {
        key: z.string().min(1).describe("Published component key from library metadata."),
      },
      annotations: readOnly,
    },
    async ({ key }) => {
      try {
        return jsonResult(await figma.getComponent(key));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_style",
    {
      title: "Get published style",
      description: "GET /v1/styles/{key} — metadata for a published style key (library key, not a file key). Scope: library_assets:read.",
      inputSchema: {
        key: z.string().min(1).describe("Published style key from library metadata."),
      },
      annotations: readOnly,
    },
    async ({ key }) => {
      try {
        return jsonResult(await figma.getStyle(key));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "find_nodes",
    {
      title: "Find nodes by name or type",
      description:
        "Utility (not a REST endpoint): fetch a file tree then return only { id, name, type, absoluteBoundingBox, parentId } matches. Requires name and/or type. Prefer this over dumping get_file to locate a frame.",
      inputSchema: {
        file: fileInput,
        name: z.string().optional().describe("Layer name to match."),
        name_match: z.enum(["substring", "exact", "regex"]).optional().describe("Default substring (case-insensitive)."),
        type: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe("Node type(s): FRAME, TEXT, COMPONENT, INSTANCE, GROUP, …"),
        depth: z.number().int().min(1).max(20).optional().describe("Tree depth to fetch. Default 8."),
        ids: idsInput.optional().describe("Optional starting node ids (uses GET .../nodes)."),
        limit: z.number().int().min(1).max(500).optional().describe("Max matches. Default 50."),
      },
      annotations: readOnly,
    },
    async ({ file, name, name_match, type, depth, ids, limit }) => {
      try {
        return jsonResult(
          await figma.findNodes(file, { name, nameMatch: name_match, type, depth, ids, limit }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "extract_text",
    {
      title: "Extract text from a file",
      description: "Utility: walk TEXT nodes and return { id, name, characters, parentId } copy. Default depth 8.",
      inputSchema: {
        file: fileInput,
        ids: idsInput.optional(),
        depth: z.number().int().min(1).max(20).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
      },
      annotations: readOnly,
    },
    async ({ file, ids, depth, limit }) => {
      try {
        return jsonResult(await figma.extractText(file, { ids, depth, limit }));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_local_variables",
    {
      title: "Get local variables",
      description:
        "GET /v1/files/{key}/variables/local — raw REST (local + consumed remote). Enterprise + file_variables:read. Prefer get_variable_defs for codegen shape and automatic fallback.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getLocalVariables(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_published_variables",
    {
      title: "Get published variables",
      description:
        "GET /v1/files/{key}/variables/published — raw REST published names (no valuesByMode). Enterprise + file_variables:read. Prefer get_variable_defs.",
      inputSchema: { file: fileInput },
      annotations: readOnly,
    },
    async ({ file }) => {
      try {
        return jsonResult(await figma.getPublishedVariables(file));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_variable_defs",
    {
      title: "Get variable / token defs",
      description:
        "Preferred token path (REST, not official Desktop get_variable_defs). Tries local Figma variables first (Enterprise + file_variables:read), shapes { collections, modes, variables: [{ id, name, resolvedType, valuesByMode, scopes }] }, resolves aliases one level. If variables 403/empty and fallback is on (default), uses file styles + inferred subtree tokens labeled inferred: true. Pass node_id so fallback can resolve style usage and infer colors/type/radii/spacing.",
      inputSchema: {
        file: fileInput,
        node_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional frame id so fallback can infer from the subtree and resolve style usage."),
        fallback: z
          .boolean()
          .optional()
          .describe("If variables are missing/403, use styles+inferred (default true). Set false to surface the Enterprise error."),
        resolve_aliases: z.boolean().optional().describe("Resolve VARIABLE_ALIAS one level (default true)."),
        mode: z
          .enum(["full", "trim", "summary"])
          .optional()
          .describe("summary = default mode only; trim = drop hidden; full = include hidden/descriptions. Default trim."),
        max_variables: z.number().int().min(1).max(400).optional(),
      },
      annotations: readOnly,
    },
    async ({ file, node_id, fallback, resolve_aliases, mode, max_variables }) => {
      try {
        const nodeId = node_id?.trim()
          ? parseNodeId(node_id)
          : (() => {
              try {
                return parseNodeId(file);
              } catch {
                return undefined;
              }
            })();
        return jsonResult(
          await figma.getVariableDefs(file, {
            nodeId,
            fallback,
            resolveAliases: resolve_aliases,
            mode,
            maxVariables: max_variables,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_design_tokens_fallback",
    {
      title: "Get design tokens fallback",
      description:
        "Skip the variables API. Build labeled tokens from file styles (library_content:read) plus optional inferred fills/type/radii/spacing from a subtree. Every inferred token has inferred: true — not real Figma variables.",
      inputSchema: {
        file: fileInput,
        node_id: z
          .string()
          .min(1)
          .optional()
          .describe("Optional frame id. Without it, styles may be names-only (no paint values)."),
        mode: z.enum(["full", "trim", "summary"]).optional(),
        max_variables: z.number().int().min(1).max(400).optional(),
      },
      annotations: readOnly,
    },
    async ({ file, node_id, mode, max_variables }) => {
      try {
        const nodeId = node_id?.trim()
          ? parseNodeId(node_id)
          : (() => {
              try {
                return parseNodeId(file);
              } catch {
                return undefined;
              }
            })();
        return jsonResult(
          await figma.getDesignTokensFallback(file, {
            nodeId,
            mode,
            maxVariables: max_variables,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_dev_resources",
    {
      title: "Get dev resources",
      description: "GET /v1/files/{key}/dev_resources — Dev Mode links on nodes. Scope: file_dev_resources:read.",
      inputSchema: {
        file: fileInput,
        ids: idsInput.optional().describe("Optional node ids to filter."),
      },
      annotations: readOnly,
    },
    async ({ file, ids }) => {
      try {
        return jsonResult(await figma.getDevResources(file, ids));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_dev_resources",
    {
      title: "Create dev resources",
      description: "POST /v1/dev_resources — attach a Dev Mode URL to a node. Scope: file_dev_resources:write.",
      inputSchema: {
        file: fileInput,
        node_id: z.string().min(1),
        name: z.string().min(1),
        url: z.string().min(1),
      },
      annotations: writeHint,
    },
    async ({ file, node_id, name, url }) => {
      try {
        return jsonResult(await figma.createDevResources([{ file, node_id, name, url }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_dev_resources",
    {
      title: "Update dev resources",
      description: "PUT /v1/dev_resources — update name/url by dev resource id. Scope: file_dev_resources:write.",
      inputSchema: {
        id: z.string().min(1).describe("Dev resource id."),
        name: z.string().optional(),
        url: z.string().optional(),
      },
      annotations: writeHint,
    },
    async ({ id, name, url }) => {
      try {
        return jsonResult(await figma.updateDevResources([{ id, name, url }]));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_dev_resource",
    {
      title: "Delete a dev resource",
      description: "DELETE /v1/files/{key}/dev_resources/{id}. Scope: file_dev_resources:write.",
      inputSchema: {
        file: fileInput,
        id: z.string().min(1),
      },
      annotations: destructive,
    },
    async ({ file, id }) => {
      try {
        return jsonResult(await figma.deleteDevResource(file, id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  const webhookEvent = z.enum([
    "PING",
    "FILE_UPDATE",
    "FILE_VERSION_UPDATE",
    "FILE_DELETE",
    "LIBRARY_PUBLISH",
    "FILE_COMMENT",
    "DEV_MODE_STATUS_UPDATE",
  ]);
  const webhookContext = z.enum(["team", "project", "file"]);
  const webhookStatus = z.enum(["ACTIVE", "PAUSED"]);

  server.registerTool(
    "list_webhooks",
    {
      title: "List webhooks",
      description:
        "GET /v2/webhooks — list Webhooks v2 for a context (team/project/file) or plan_api_id. Auto-paginates next_page. Scope: webhooks:read. 403 usually means missing scope or plan without webhooks.",
      inputSchema: {
        context: webhookContext.optional(),
        context_id: z
          .string()
          .optional()
          .describe("Context id. Team/project/file URL or id is accepted when context is set."),
        plan_api_id: z.string().optional().describe("Plan id to list all accessible webhooks (paginated)."),
        auto_paginate: autoPaginateInput,
      },
      annotations: readOnly,
    },
    async ({ context, context_id, plan_api_id, auto_paginate }) => {
      try {
        return jsonResult(
          await figma.listWebhooks({
            context,
            contextId: context_id,
            planApiId: plan_api_id,
            autoPaginate: auto_paginate,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "get_webhook",
    {
      title: "Get webhook",
      description: "GET /v2/webhooks/{id}. Scope: webhooks:read. Passcode is redacted by Figma.",
      inputSchema: {
        webhook_id: z.string().min(1),
      },
      annotations: readOnly,
    },
    async ({ webhook_id }) => {
      try {
        return jsonResult(await figma.getWebhook(webhook_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "create_webhook",
    {
      title: "Create webhook",
      description:
        "POST /v2/webhooks — Figma sends a PING on create unless status=PAUSED. Scope: webhooks:write. Requires passcode for endpoint verification.",
      inputSchema: {
        event_type: webhookEvent,
        context: webhookContext,
        context_id: z.string().min(1).describe("Team/project/file id or URL matching context."),
        endpoint: z.string().min(1).max(2048).describe("HTTPS endpoint that receives POST events."),
        passcode: z.string().min(1).max(100).describe("Shared secret Figma echoes on each delivery."),
        status: webhookStatus.optional(),
        description: z.string().max(150).optional(),
      },
      annotations: writeHint,
    },
    async ({ event_type, context, context_id, endpoint, passcode, status, description }) => {
      try {
        return jsonResult(
          await figma.createWebhook({
            event_type,
            context,
            context_id,
            endpoint,
            passcode,
            status,
            description,
          }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "update_webhook",
    {
      title: "Update webhook",
      description: "PUT /v2/webhooks/{id}. Scope: webhooks:write. Empty description deletes it.",
      inputSchema: {
        webhook_id: z.string().min(1),
        event_type: webhookEvent.optional(),
        endpoint: z.string().min(1).max(2048).optional(),
        passcode: z.string().min(1).max(100).optional(),
        status: webhookStatus.optional(),
        description: z.string().max(150).optional(),
      },
      annotations: writeHint,
    },
    async ({ webhook_id, event_type, endpoint, passcode, status, description }) => {
      try {
        return jsonResult(
          await figma.updateWebhook(webhook_id, { event_type, endpoint, passcode, status, description }),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "delete_webhook",
    {
      title: "Delete webhook",
      description: "DELETE /v2/webhooks/{id} — irreversible. Scope: webhooks:write.",
      inputSchema: {
        webhook_id: z.string().min(1),
      },
      annotations: destructive,
    },
    async ({ webhook_id }) => {
      try {
        return jsonResult(await figma.deleteWebhook(webhook_id));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
