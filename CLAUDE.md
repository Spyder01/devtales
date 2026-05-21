# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Start dev server at localhost:4321
npm run build        # Type-check + build + Pagefind index (required for search)
npm run preview      # Preview production build
npm run lint         # ESLint
npm run format       # Prettier (write)
npm run format:check # Prettier (check only)
npm run sync         # Regenerate Astro type definitions
```

> Search (`/search`) requires a production build — Pagefind indexes only after `npm run build`.

## Architecture

**Stack**: Astro 5, TypeScript, Tailwind CSS 4, deployed on Cloudflare Pages with edge analytics via Cloudflare D1.

### Content pipeline

Blog posts live in `src/data/blog/posts/**/*.md` and are loaded via Astro content collections (schema in `src/content.config.ts`). Post URL path is derived from `id` and `filePath` using `src/utils/getPath.ts` — a file at `posts/nexora/chapter-1.md` becomes `/posts/nexora/chapter-1/`.

Key frontmatter fields:
- `draft: true` hides a post in production (visible in dev)
- `pubDatetime` controls scheduling — posts with a future date are hidden until 15 min before
- `isSeries: true` + `series: "Name"` + `chapter: N` enables series prev/next nav in `PostDetails.astro`
- `ogImage` — if omitted, a dynamic PNG is generated at build time via Satori + `src/utils/og-templates/post.js`

### Routing

Astro file-based routing under `src/pages/`:
- `/posts/[...slug]/index.astro` — post detail page
- `/posts/[...slug]/index.png.ts` — dynamic OG image (skipped if post has `ogImage`)
- `/posts/[...page].astro` — paginated post listing
- `/tags/[tag]/[...page].astro` — paginated tag listing

### Styling / Theming

`src/styles/global.css` imports Tailwind and one of four swappable theme files from `src/styles/themes/`. The active theme is set by editing the import line — currently `electric-blue.css`. All themes expose the same CSS custom properties (`--background`, `--foreground`, `--accent`, `--muted`, `--border`) in both light and dark variants. Prose/article styles are in `src/styles/typography.css`.

### Edge API (Cloudflare Functions)

`functions/api/visits.ts` and `functions/api/react.ts` are Cloudflare Pages Functions (edge workers) with D1 bindings (`env.DB`). They handle POST requests for analytics and emoji reactions respectively. These are separate from the Astro build.

### Markdown enhancements

Shiki code blocks support:
- File names via `transformerFileName` (custom, `src/utils/transformers/fileName.js`)
- Line highlights (`// [!code highlight]`)
- Word highlights
- Diff notation (`// [!code ++]` / `// [!code --]`)

`remark-toc` auto-generates tables of contents; `remark-collapse` collapses them.

### Site config

`src/config.ts` exports `SITE` (metadata, pagination, timezone) and `src/constants.ts` exports `SOCIALS`/`SHARE_LINKS`. Edit these for site-wide changes.

### Path alias

`@/*` maps to `src/*` throughout the codebase.

## Nexora blog series

Posts under `src/data/blog/posts/nexora/` document the author's own Rust graph database project at `~/.projects/nexora`. When writing or editing these posts, read the actual source there for ground truth — the Rust code is the authoritative reference.

**What Nexora is**: A single-file embedded graph database (SQLite-style) written in Rust. `.nxr` files are sequences of 4 KB pages. Nodes, edges, labels, properties, and strings each occupy dedicated page chains. Adjacency lists are intrusive singly-linked lists of `PackedPtr` values (a `u64` encoding `page_id << 8 | slot`). Label strings are deduplicated; a node stores a 4-byte `label_id` rather than the raw string. There is no heap allocation in the core storage layer.

**Planned series chapters** (from the posts already written):
- Chapter 1 — `nexora-the-why.md`: motivation, graph model vs relational
- Chapter 2 — `nexora-file-format.md`: page layout, header/footer, node/edge records, PackedPtr, WAL sidecar
- Chapter 3 (not yet written): WAL deep-dive — recovery scan, session-level atomicity, checkpoint-on-close

**Key source paths in `~/.projects/nexora/src/`**:
- `storage/` — page I/O, page allocation, WAL, header/footer models
- `graph/graphstore/` — public GraphStore API (insert/get/delete nodes and edges)
- `graph/node/`, `graph/edge/`, `graph/label/`, `graph/property/`, `graph/string/` — per-record-type page layouts
- `graph/record/types.rs` — `PackedPtr`, `RecordCursor`, `Bitset256`
- `api/traversal/` — BFS, DFS, shortest_path, has_path
- `lua/` — Lua REPL bindings (optional feature)
