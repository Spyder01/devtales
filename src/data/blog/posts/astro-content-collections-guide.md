---
title: "Astro Content Collections: A Practical Guide to Type-Safe Markdown"
author: "Suhan Bangera"
pubDatetime: 2026-05-13T09:00:00Z
description: "Content Collections are one of Astro's best features, giving you a type-safe, schema-validated layer over your Markdown files. Here's how to use them effectively."
featured: true
tags:
  - astro
  - typescript
  - static-sites
  - web-dev
---

Astro's **Content Collections** are one of those features that quietly make your life much better. The pitch is simple: instead of reading raw Markdown files and hoping the frontmatter has the right shape, you define a schema once and get full TypeScript inference across your entire content layer.

This post covers the practical side — how to set them up, how to query them, and a few patterns I've found useful building this blog.

## Table of Contents

## What Is a Content Collection?

A content collection is a folder of Markdown (or MDX) files that Astro treats as a typed data source. You define the schema in `content.config.ts`, and Astro generates TypeScript types from it automatically.

The payoff: anywhere you call `getCollection('blog')`, every field from every post's frontmatter is fully typed — no casting, no `any`, no runtime surprises.

## Setting Up a Collection

Create `src/content.config.ts`:

```ts
// src/content.config.ts
import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const blog = defineCollection({
  loader: glob({ pattern: "**/[^_]*.md", base: "./src/data/blog" }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDatetime: z.date(),
      modDatetime: z.date().optional().nullable(),
      author: z.string().default("Suhan Bangera"),
      featured: z.boolean().optional(),
      draft: z.boolean().optional(),
      tags: z.array(z.string()).default(["general"]),
      ogImage: image().or(z.string()).optional(),
    }),
});

export const collections = { blog };
```

A few things worth noting here:

- The `glob` loader uses `[^_]*.md` — the `[^_]` prefix means any file starting with `_` is skipped. Useful for draft templates you don't want published.
- `image()` is Astro's image helper that validates the path and generates responsive image metadata at build time.
- `z.date().optional().nullable()` handles the case where `modDatetime` might be explicitly set to `null` in frontmatter to suppress the "last edited" display — plain `.optional()` wouldn't cover that.

## Querying Collections

### Get all posts

```ts
import { getCollection } from "astro:content";

const allPosts = await getCollection("blog");
```

By default this returns everything, including drafts. To filter them out:

```ts
const publishedPosts = await getCollection("blog", ({ data }) => {
  return !data.draft;
});
```

The second argument is a filter function that runs at build time. Filtering here is better than filtering in the component — Astro can skip rendering filtered entries entirely.

### Get a single entry

```ts
import { getEntry } from "astro:content";

const post = await getEntry("blog", "posts/my-post-slug");
```

The slug is derived from the file path relative to your `base` directory. `src/data/blog/posts/my-post.md` becomes `posts/my-post`.

### Render post content

```ts
const { Content } = await post.render();
```

Then in your template:

```astro
<Content />
```

`Content` is a component. It renders the Markdown body with all your remark/rehype plugins applied.

## Building a Posts Page

Here's a minimal paginated posts listing page:

```astro
---
// src/pages/posts/[...page].astro
import { getCollection } from "astro:content";
import type { GetStaticPaths } from "astro";

export const getStaticPaths: GetStaticPaths = async ({ paginate }) => {
  const posts = await getCollection("blog", ({ data }) => !data.draft);

  const sorted = posts.sort(
    (a, b) =>
      new Date(b.data.pubDatetime).getTime() -
      new Date(a.data.pubDatetime).getTime()
  );

  return paginate(sorted, { pageSize: 10 });
};

const { page } = Astro.props;
---

<ul>
  {page.data.map(post => (
    <li>
      <a href={`/posts/${post.id}/`}>{post.data.title}</a>
      <p>{post.data.description}</p>
    </li>
  ))}
</ul>
```

`getStaticPaths` runs at build time and generates one static page per paginated chunk. Astro's `paginate()` helper handles the math and gives you `page.data`, `page.currentPage`, `page.lastPage`, and navigation URLs.

## A Pattern: Separating Sorting from Filtering

Once you start building real pages you'll find yourself sorting and filtering posts everywhere. I pull these into small utility functions:

```ts
// src/utils/getSortedPosts.ts
import type { CollectionEntry } from "astro:content";

type BlogPost = CollectionEntry<"blog">;

const isDraft = (post: BlogPost) => post.data.draft === true;
const isScheduled = (post: BlogPost) =>
  new Date(post.data.pubDatetime) > new Date();

export default function getSortedPosts(posts: BlogPost[]) {
  return posts
    .filter(post => !isDraft(post) && !isScheduled(post))
    .sort(
      (a, b) =>
        new Date(b.data.pubDatetime).getTime() -
        new Date(a.data.pubDatetime).getTime()
    );
}
```

`CollectionEntry<"blog">` is the generated type for your collection — it has `.id`, `.data` (your schema shape), and `.body` (raw Markdown). Using it here means if you add a field to your schema, the utilities update automatically.

## Adding Series Support

This blog has serialized content, so I added optional series metadata to the schema:

```ts
isSeries: z.boolean().optional().default(false),
series: z.string().optional(),
chapter: z.number().optional().default(1),
```

Then to get all chapters of a series:

```ts
const chapters = await getCollection("blog", ({ data }) =>
  data.isSeries && data.series === "my-series"
);

const sorted = chapters.sort((a, b) => a.data.chapter - b.data.chapter);
```

And in the post layout, compute prev/next for chapter navigation:

```ts
const allChapters = sortedChapters;
const currentIndex = allChapters.findIndex(c => c.id === post.id);

const prev = currentIndex > 0 ? allChapters[currentIndex - 1] : null;
const next =
  currentIndex < allChapters.length - 1
    ? allChapters[currentIndex + 1]
    : null;
```

## Dynamic OG Images

One thing Content Collections make easy is per-post OG image generation. Because every post's data is typed and available at build time, you can generate custom OG images with Satori without any runtime overhead:

```ts
// src/pages/posts/[slug]/index.png.ts
import { getCollection } from "astro:content";
import { generateOgImage } from "@/utils/generateOgImages";

export async function getStaticPaths() {
  const posts = await getCollection("blog");
  return posts
    .filter(post => !post.data.ogImage)
    .map(post => ({
      params: { slug: post.id },
      props: post,
    }));
}

export async function GET({ props: post }) {
  return new Response(await generateOgImage(post.data.title), {
    headers: { "Content-Type": "image/png" },
  });
}
```

Posts with a custom `ogImage` in frontmatter skip generation entirely. The rest get an auto-generated image with the post title.

## What I'd Change

A few rough edges worth knowing about:

**Slug collision across subdirectories.** If you have `posts/foo.md` and `drafts/foo.md`, both resolve to the slug `foo`. Astro will warn about this but not fail — last one wins. Structure your directories to avoid ambiguity.

**No incremental builds yet.** Every build reprocesses every Markdown file. For a large collection this gets slow. Cloudflare Pages build cache helps, but it's not a substitute for true incremental support.

**Schema changes require full rebuild.** Changing your Zod schema requires `astro sync` to regenerate types. This is fast, but forgetting it leads to confusing type errors until you remember.

---

Content Collections are one of the best reasons to reach for Astro when you're building a content-heavy site. The type safety alone pays for itself — I've caught more than a few missing description fields and malformed dates at build time that would have been silent bugs otherwise.

If you're building with Astro, make the schema first and let the types guide the rest.
