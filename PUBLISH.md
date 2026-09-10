# Publicar `figma-rest-mcp` en GitHub

Checklist para pasar de un remoto de trabajo a un repo **público** de portafolio.

GitHub de Andrés: **`Rompni`**. URL objetivo:

`https://github.com/Rompni/figma-rest-mcp`

Si publicas con otro login, cambia `OWNER` aquí, en `package.json` (`repository`, `bugs`, `homepage`) y en el `git clone` del README.

## 1. Crear el repo vacío

En [github.com/new](https://github.com/new):

- Name: `figma-rest-mcp` (no reutilices un slug temporal)
- Public
- **Sin** README / LICENSE / .gitignore (este repo ya los trae)
- Description: `Headless Figma MCP over REST — deterministic, CI-friendly, your PAT`

O con GitHub CLI (autenticado como `Rompni`):

```bash
gh repo create Rompni/figma-rest-mcp --public --source=. --remote=github --description "Headless Figma MCP over REST — deterministic, CI-friendly, your PAT"
```

`--source=.` puede hacer push; si prefieres crear vacío:

```bash
gh repo create Rompni/figma-rest-mcp --public --description "Headless Figma MCP over REST — deterministic, CI-friendly, your PAT"
```

## 2. Topics

Settings → Topics, o:

```bash
gh repo edit Rompni/figma-rest-mcp --add-topic mcp --add-topic figma --add-topic typescript --add-topic ai-agents
```

## 3. Remoto y push de `main`

Desde la raíz de este proyecto (ya hay un `origin` de trabajo; **no lo borres** si aún lo usas):

```bash
git remote add github https://github.com/Rompni/figma-rest-mcp.git
git push -u github main
```

Si `github` ya existe:

```bash
git remote set-url github https://github.com/Rompni/figma-rest-mcp.git
git push -u github main
```

SSH:

```bash
git remote add github git@github.com:Rompni/figma-rest-mcp.git
git push -u github main
```

## 4. Antes de hacer público

- [ ] No hay `.env` ni PATs reales (`git grep -n 'figd_' -- ':!.env.example' ':!src/*.test.ts'` solo debe ver placeholders / `figd_test`)
- [ ] `npm test` y `npm run build` en verde
- [ ] LICENSE MIT con copyright 2026
- [ ] README sin secrets ni stats inventados

## 5. Después

About del repo: pega el one-liner del README. Homepage: `https://www.andresnavarro.dev` si quieres.

No hace falta publicar en npm para el portafolio. Si algún día: `npm publish --access public` (el `name` ya es `figma-rest-mcp`).
