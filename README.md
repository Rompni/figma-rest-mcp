# figma-rest-mcp

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6)

**Headless Figma MCP over REST.** Talk to Figma from Cursor or Claude with *your* personal access token — deterministic, CI-friendly, no official MCP seat tool-call quotas.

Servidor MCP **stdio** (Node 20+, TypeScript) de [Andrés Felipe Navarro Gómez](https://www.andresnavarro.dev). Lee archivos de Figma por la **REST API**. No es el MCP oficial de Figma.

## Problema → solución

El MCP oficial de Figma corre dentro de **Figma Desktop**, consume **cuotas de tool-calls del asiento**, y no encaja en CI ni en un agente headless. La REST API sí: un PAT, `api.figma.com`, respuestas repetibles.

`figma-rest-mcp` expone esa REST como tools MCP: contexto de diseño recortado para codegen, búsqueda de nodos, copy, tokens (variables Enterprise o fallback), discovery de team/library. Desactiva el MCP oficial en el cliente para que el modelo no lo llame por error.

Esto **no** es un exploit de cuotas. Usas **tu** PAT, sujeto a los [términos de Figma](https://www.figma.com/legal/tos/) y a los rate limits de `api.figma.com`.

## Quickstart

1. Crea un [personal access token](https://help.figma.com/hc/en-us/articles/8085703771159-Manage-personal-access-tokens) en Figma (Settings → Security). Mínimo: `current_user:read`, `file_content:read`.
2. Clona, instala, copia el env:

```bash
git clone https://github.com/Rompni/figma-rest-mcp.git
cd figma-rest-mcp
npm install
cp .env.example .env
# edita .env y pega FIGMA_ACCESS_TOKEN=figd_...
```

3. Cursor — `~/.cursor/mcp.json` o `.cursor/mcp.json` (placeholders, **nunca** un token real en git):

```json
{
  "mcpServers": {
    "figma-rest": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/TO/figma-rest-mcp/src/index.ts"],
      "env": {
        "FIGMA_ACCESS_TOKEN": "figd_your_personal_access_token_here"
      }
    }
  }
}
```

Claude Desktop: `claude_desktop_config.json` (macOS `~/Library/Application Support/Claude/`, Windows `%APPDATA%\Claude\`).

```bash
npm start          # stdio MCP, REST-only
npm test && npm run build
```

Si el oficial sigue conectado, el modelo puede llamarlo igual y gastar esa cuota. Déjalo solo `figma-rest`.

## Tools destacadas

`file` acepta key o URL (`figma.com/design/...`).

| Tool | Para qué |
| --- | --- |
| **`get_design_context_lite`** | Snapshot codegen de un subtree: id, bbox, flex aproximado desde auto-layout, texto + tipografía, fills, instancias. `include_tokens` (default `false`) añade un resumen compacto. **No** es paridad con el `get_design_context` oficial. |
| **`find_nodes`** | Filtra por `name` / `type` → `{ id, name, type, bbox }` sin volcar el archivo entero. |
| **`extract_text`** | Copy de nodos `TEXT` con id. |
| **`get_variable_defs`** | Tokens: variables reales si hay Enterprise + `file_variables:read`; si no, estilos + inferencia del frame (`inferred: true`). |
| `list_projects` / `list_project_files` | Discovery. `GET /v1/me` **no** trae `team_id`: pasa URL/id de team o `FIGMA_TEAM_ID`. |
| `get_file` / `get_nodes` | JSON REST con `mode=trim\|summary\|full` (default `trim`). |

Otras: renders (`get_images`), image fills, libraries, comments, webhooks v2, bundle de assets a data URI (caps + allowlist SSRF). Catálogo completo en las descripciones de las tools.

### Tokens

- Enterprise + `file_variables:read` → `source: "variables"`, aliases a un nivel.
- Si no → fallback de estilos / valores repetidos del subtree. **No** son variables de Figma.
- `get_design_tokens_fallback` fuerza el fallback. `fallback: false` en `get_variable_defs` deja el 403 (Enterprise + scope).

## Frente al MCP oficial

| | Este repo (REST) | MCP oficial (Desktop) |
| --- | --- | --- |
| Headless / CI | Sí | No (hace falta Figma Desktop) |
| Cuotas | Rate limit de `api.figma.com` + scopes del PAT | Tool-calls del asiento / plan MCP |
| `get_design_context` | Lite: árbol recortado, flex best-effort | Plugin API + semántica extra de codegen |
| Variables | REST Enterprise, o fallback etiquetado | Definiciones vivas en el archivo abierto |
| Escribir canvas | REST **no puede**. Bridge opt-in, comandos allowlist | Plugin API (`use_figma`) |
| Determinismo | Alto (JSON de REST) | Depende del archivo abierto en Desktop |

**Dónde ganamos:** agentes, CI, cuotas predecibles, archivos sin abrir Desktop.  
**Dónde ganan ellos:** magia de codegen, variables vivas, writes de canvas de primer nivel.

## Limitaciones

- **Read-mostly.** REST no crea ni muta nodos de diseño. Comments / webhooks / dev resources sí son REST de escritura, no canvas.
- **`get_design_context_lite` ≠ `get_design_context`.** Sin Plugin API, sin plantillas oficiales, sin “semantic magic”.
- **Variables reales = Enterprise** + `file_variables:read`. El resto es fallback `inferred: true`.
- **Write bridge es secundario y opt-in** (`FIGMA_ENABLE_WRITE_BRIDGE=1`). Solo `create_frame` / `set_text` allowlist; **no hay eval** de JS. Default `npm start` no registra esas tools.
- FigJam / Slides / Make / shaders: fuera de alcance para writes; lectura REST según lo que exponga la API.

## Seguridad y ToS

- El token es **tuyo**. No lo subas a git (`.gitignore` cubre `.env`).
- El servidor no bypasea autenticación de Figma ni cuotas de asiento: **deja de usar el MCP oficial** y usa REST con PAT.
- 401 = PAT; 403 = scopes/plan (variables Enterprise, webhooks); 429 = rate limit REST (`Retry-After`), no cuota MCP.
- Bridge (si lo enciendes): solo `127.0.0.1`, token compartido, sin eval. Sigue ejecutando Plugin API en el archivo abierto.

## Escritura Desktop (opt-in, no es el producto)

REST no escribe el canvas. Si lo necesitas: `FIGMA_ENABLE_WRITE_BRIDGE=1`, `FIGMA_BRIDGE_TOKEN`, plugin de desarrollo (`plugin/manifest.json`) en **Figma Desktop**, archivo Design. Comandos allowlist; el plugin rechaza scripts libres. Sin plugin, las tools fallan al instante (no cuelgan). Detalle en `.env.example`.

## Licencia

MIT © 2026 Andrés Felipe Navarro Gómez. Ver [LICENSE](LICENSE).

Publicar este repo en GitHub: [PUBLISH.md](PUBLISH.md).
