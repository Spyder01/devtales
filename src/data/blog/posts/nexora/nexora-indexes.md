---
title: "Building a Graph Database 7 - Indexes"
author: "Suhan Bangera"
pubDatetime: 2026-05-23T10:00:00Z
description: "How Nexora maps a logical page number to a physical page ID in O(1), what a directory page looks like on disk, and how the index grows when the database exceeds a single directory page."
featured: false
isSeries: true
series: "Nexora"
chapter: 7
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 6](/posts/posts/nexora/nexora-buffer-cache/) we covered the buffer store — how pages are cached in memory and how the clock algorithm decides which frame to evict. This post covers a structure that makes caching matter: **the page index**, the layer that turns a node ID into a physical page address without scanning anything.

---

## The Problem

Every node lookup in Nexora boils down to: given `node_id`, find the 4 KB page on disk that contains it.

The node store is a chain of pages linked together via `next_page_id` pointers in each page header. The naive approach is to walk that chain from the beginning until you find the right page. That is O(node pages) — fine for tiny databases, unusable for large ones.

Nexora's fixed-size records give a better path. Because each node page holds exactly 101 records and IDs are assigned sequentially, the logical page number for any node is just `node_id / 101`. The problem reduces to: given a logical page number, what is the physical `page_id`? The page index answers that question in O(1).

---

## The Page Index

The page index is a flat array of physical page IDs, stored on disk across one or more **directory pages**. Entry `i` in the array holds the physical `page_id` of the node page that owns logical page `i` — that is, the page containing nodes `i × 101` through `i × 101 + 100`.

```
Logical page number  →  page_index[i]  →  physical page_id  →  node page
```

The footer holds `first_page_index_page` — the physical ID of the first directory page — as the entry point into the index. For databases within a single directory page this lookup is O(1); beyond that, finding the right directory page requires walking the chain, which is O(directory pages). The chain grows at one page per 51,207 nodes and directory pages stay hot in the buffer cache in practice, so the walk remains cheap even for large databases.

---

## The Directory Page

Each directory page begins with the standard 32-byte `NexoraPageHeader`, followed by a 2-byte **directory page header**, then the array of records:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 32 | `NexoraPageHeader` |
| 32 | 2 | `page_dir_count` (u16, LE) — number of entries in this directory page |
| 34 | 6 | padding |
| 40 | 507 × 8 | `records` — array of `page_id` (u64, LE) entries |
| 4056 | 6 | padding |

Each record is 8 bytes — a single `page_id` u64. Capacity:

```
(4096 − 32 − 8) / 8 = 507 entries per directory page
```

One directory page covers 507 logical pages × 101 nodes = **51,207 nodes** before a second directory page is needed.

---

## Looking Up a Node Page

`lookup(page_index)` translates a logical page number to a physical page ID in two steps:

```
dir_page_index = page_index / 507   ← which directory page
slot           = page_index % 507   ← which entry within it

Walk directory page chain to dir_page_index.
Return records[slot].page_id
```

For a database with fewer than 51,207 nodes there is exactly one directory page, so the walk terminates immediately. The entire lookup is:

1. One read of the directory page (likely already in the buffer cache).
2. One arithmetic slot calculation.
3. Return `records[slot]`.

For larger databases with multiple directory pages, each additional directory page adds one page read to find the right directory page. In practice, directory pages themselves stay hot in the buffer cache — the index is small and accessed on every node lookup.

```
node_id = 153

  page_index = 153 / 101 = 1

  dir_page_index = 1 / 507 = 0   →  first directory page
  slot           = 1 % 507 = 1

  Directory Page 0
  ┌────────┬──────────┬──────────┬──────────┬─────┐
  │ header │  rec[0]  │  rec[1]  │  rec[2]  │ … │
  │        │ page_id 2│ page_id 5│ page_id 8│   │
  └────────┴──────────┴──────────┴──────────┴─────┘
                           ↑
                     slot 1 → page_id 5

  Read node page 5, slot = 153 % 101 = 52
```

---

## Inserting into the Index

`insert(page_index, page_id)` is called once per new node page, when a page boundary is crossed (`node_id % 101 == 0`).

```rust
if slot == 0 {
    // First entry on a new directory page — allocate one.
    append_dir_page(dir_page_index, page_id)
} else {
    // Entry fits on an existing directory page — update it.
    read dir page → set records[slot] = page_id → write dir page
}
```

When `slot == 0`, a new directory page is needed. `append_dir_page`:

1. Allocates a fresh page from `StorageManager`.
2. Initialises it with the first record already written (`records[0] = page_id`).
3. Links it to the previous directory page by updating that page's `next_page_id`.
4. If this is the very first directory page (`dir_page_index == 0`), stores its ID in the footer's `first_page_index_page`.

For all other slots, no new page is needed — just a read-modify-write of the existing directory page.

---

## Growing Beyond One Directory Page

When the database accumulates more than 507 node pages (51,207+ nodes), the index overflows onto a second directory page. The two directory pages form a singly-linked list via `next_page_id`:

```
footer.first_page_index_page
        │
        ▼
┌─────────────────────┐  next_page_id  ┌─────────────────────┐
│  Directory Page 0   │───────────────►│  Directory Page 1   │
│  rec[0] … rec[506]  │                │  rec[0] … rec[506]  │
│  logical pages 0–506│                │  logical pages 507+ │
└─────────────────────┘                └─────────────────────┘
```

A lookup for `page_index = 510` walks one step along the chain to directory page 1, then reads `records[510 % 507] = records[3]`. Each additional directory page covers another 51,207 nodes — the chain grows very slowly.

---

## Why Not a Hash Map?

A hash map is the first alternative that comes to mind for any key-to-value mapping. For a page index it would mean: given a logical page number, hash it and jump directly to the physical page ID. No chain walk, no arithmetic. So why not?

**Array traversal beats hash maps at this scale.** A hash map only wins when the collection is large enough that scanning the whole thing costs more than hashing and bucket indirection. For most databases the page index fits on a single directory page — 507 entries, 4056 bytes of contiguous `u64` values. Scanning that array is fast: it is sequential memory access with no pointer chasing, and the CPU prefetcher handles it trivially. A hash map at this size adds hashing overhead, potential collision resolution, and less predictable memory access patterns that defeat the prefetcher — all costs that outweigh any scan savings.

**Hash maps live on the heap.** A hash map grows and shrinks dynamically, which means it needs a heap allocator. Nexora deliberately avoids dynamic heap allocation in the storage layer — every structure is either a fixed-size type or a `Box`ed slice of known size allocated once at startup. Keeping the page index on disk as a fixed-size array of records stays consistent with this philosophy and avoids any allocator interaction on the hot read path.

The directory page design gives the same logical result as a hash map — O(1) lookup via arithmetic — without either of those costs.

---

## What the Index Does Not Cover

Currently, only node pages use the page index. Label pages are indexed the same way — the infrastructure is shared — but edge pages, string pages, and property pages are accessed exclusively by following pointer chains from node records or the footer. A page index for edges is not necessary because edges are not looked up by ID directly in the hot path; they are reached by walking adjacency lists from node records.

---

## What's Next

The next post will cover the **WAL (Write-Ahead Log)** — how Nexora intercepts every page write, what a frame looks like on disk, how recovery scans the sidecar after a crash, and how checkpoint-on-close moves data back to the main file.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
