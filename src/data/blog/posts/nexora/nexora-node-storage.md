---
title: "Building a Graph Database - Node Storage"
author: "Suhan Bangera"
pubDatetime: 2026-05-21T11:00:00Z
description: "A deep dive into how Nexora stores, looks up, inserts, and deletes nodes. Fixed-size records, identity-bound slots, O(1) direct addressing via the page index, and why deleted nodes leave permanent holes."
featured: true
isSeries: true
series: "Nexora"
chapter: 3
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 2](/posts/posts/nexora/nexora-file-format/) we mapped the full file format — every page type, the footer manifest, the PackedPtr encoding. This post zooms into one layer: **node storage**. How a node is laid out on disk, how it gets there, how it is found, and what happens when it is deleted.

---

## What is a Node?
In a graph, *nodes* are one of its two primitives (the other being *edges*). A node represents an entity, like a **Person**, a **Movie**, a **City**, etc. Edges represent relationships between entities.

### What does a Node contain?
For a directed graph, a typical node should contain the following information:
- *A Label*: An identifier describing what kind of thing it is — for example: a **Person**, a **Movie**, a **City**, etc.
- *Incoming Edges*: These are the edges directed towards the node.
- *Outgoing Edges*: These are the edges going away from the node.
- *Node Properties*: A collection of key-value pairs that give more information about a node. For example: for a node **Person**, properties could be **Name=Jon Doe**, **Age=69**, etc.

---

## The Node Page
Node records are packed into **4 KB pages**.

```
4 KB Node Page
┌──────────────────────────────────┐  ← byte 0
│         NexoraPageHeader         │    32 bytes
│   page_id · next · prev · crc   │
├──────────────────────────────────┤  ← byte 32
│        Node Page Header          │     2 bytes
│           record_count           │
├──────────────────────────────────┤  ← byte 34
│           Record  0              │    40 bytes
├──────────────────────────────────┤  ← byte 74
│           Record  1              │
├──────────────────────────────────┤
│              ...                 │
├──────────────────────────────────┤
│           Record 100             │
└──────────────────────────────────┘  ← byte 4096
```

### Nexora Page Header

Every page in Nexora, regardless of type, begins with the same 32-byte `NexoraPageHeader`:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `page_id` (u64, LE) — this page's own ID |
| 8 | 8 | `next_page_id` (u64, LE) — next page in the chain, `0xFFFF…` if none |
| 16 | 8 | `prev_page_id` (u64, LE) — previous page in the chain, `0xFFFF…` if none |
| 24 | 4 | `checksum` (CRC32, LE) — over the page body; verified on every read |
| 28 | 1 | `page_type` — identifies the page kind (2 = Node) |
| 29 | 3 | padding |

`next_page_id` and `prev_page_id` chain all node pages into a doubly-linked list. The footer holds `first_node_page` and `last_node_page` as entry points into the chain. `checksum` is stamped on every write and verified on every read — silent corruption is caught at the page boundary, not discovered three queries later.

### The Node Page Header

Immediately after the `NexoraPageHeader` comes the 4-byte **node page header**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 1 | `record_count` — number of records written so far |
| 1 | 1 | padding |

`record_count` is the append pointer. New records always go at slot `record_count`; after the insert it is incremented. It is never decremented — deletion does not touch it.

The capacity of a Node Page: `(4096 − 32 NexoraPageHeader − 2 node_page_header) / 40 = 101 records per page`.

### The Node Record

Every node is a fixed-size **40-byte record** packed into the data area of the node page:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `node_id` (u64 — unsigned 64-bit integer / 8 bytes, LE) |
| 8 | 8 | `first_out_edge` (PackedPtr) |
| 16 | 8 | `first_in_edge` (PackedPtr) |
| 24 | 8 | `properties` (PackedPtr) |
| 32 | 4 | `label_id` (u32 — unsigned 32-bit integer / 4 bytes, LE) |
| 36 | 1 | `flags` (0 = active, 1 = deleted) |
| 37 | 3 | padding |

`first_out_edge` and `first_in_edge` are the heads of the node's adjacency lists. Each is a [`PackedPtr`](/posts/posts/nexora/nexora-file-format#a-note-on-packedptr) — a `u64` encoding a page ID and a slot index — pointing to the first outgoing and first incoming edge respectively. Following these pointers is how graph traversal works.

`properties` is a `PackedPtr` to the first property record for this node, or `NULL` if the node has no properties.

`label_id` is a 4-byte integer referencing a deduplicated label string in the label store. All nodes labelled `"Person"` share the same `label_id` — comparing labels is a 32-bit integer comparison, not a string comparison.

`flags` is a single byte: `0` for active, `1` for deleted. Deletion is always logical — the flag is flipped, the record stays on disk.

---

## Inserting a Node

When you call `insert_node("Person")`, the engine:

1. Reads `next_node_id` from the footer — that becomes the new node's ID.
2. Checks if `node_id % 101 == 0`. If yes, the current page is full (or this is the very first insert). A new page is allocated.
3. Otherwise, reads the last node page, appends the record at slot `record_count`, writes the page back.
4. Increments `node_count` and `next_node_id` in the footer and marks it dirty.
5. The dirty pages are written into the file, when the database is closed.

When a new page is allocated:

- The previous last page's `next_page_id` is updated to link to the new one.
- The new page is registered in the **page index** at position `node_id / 101`.
- The footer's `last_node_page` is updated.

The page boundary check is elegant: because node IDs are sequential and each page holds exactly 101 nodes, `node_id % 101 == 0` fires precisely when a new page is needed — no separate counter required.

```
node_id 0    → new page (slot 0)
node_id 1    → append  (slot 1)
...
node_id 100  → append  (slot 100)
node_id 101  → new page (slot 0)
node_id 102  → append  (slot 1)
...
```

---

## Looking Up a Node

Given a `node_id`, the lookup is arithmetic and two page reads:

```
page_id    = node_id / 101          →  which node page
physical_page = page_index[page_id] →  disk address (from page index)
slot          = node_id % 101          →  position within that page

read physical_page → records[slot]
```

```
node_id = 153
    │
    ├─ 153 / 101 = 1  ──►  Page Index
    │                       ┌──────┬───────────┐
    │                       │  0   │  page_id 2 │
    │                       │  1   │  page_id 5 │ ◄── entry 1
    │                       │  2   │  page_id 8 │
    │                       └──────┴───────────┘
    │                                  │
    │                                  ▼  read physical page 5
    │                       ┌──────────────────┐
    └─ 153 % 101 = 52  ──►  │    slot 52       │ ◄── the record
                            └──────────────────┘
```

The page index lookup may involve a short chain walk for very large databases (>507 node pages, ~51,200 nodes), but for most databases the entire index fits on a single page — one extra read before the node page read.

Total cost for any lookup: **one page index read + one node page read**, regardless of how many nodes exist.

---

## Deleting a Node

Deletion flips `flags` to `1` and writes the page back. That is all.

The slot is **permanently vacated**. Because a node's slot is determined by its ID (`node_id % 101`), no future node can occupy that position — new nodes always get the next sequential ID and are appended at `record_count`. The hole stays until the containing page can be freed entirely, which requires all 101 slots on the page to be deleted.

```
Page 0  (node_ids 0 – 100)
┌──────┬──────┬──────┬──────┬──────┬──────┐
│  0   │  1   │  ✗   │  3   │  ✗   │  …  │  slots 2, 4 deleted — permanent holes
└──────┴──────┴──────┴──────┴──────┴──────┘

Page 1  (node_ids 101 – 201) — all 101 slots deleted
┌──────┬──────┬──────┬──────┬──────┬──────┐
│  ✗   │  ✗   │  ✗   │  ✗   │  ✗   │  ✗  │  entire page can now be reclaimed
└──────┴──────┴──────┴──────┴──────┴──────┘
```

### The Trade-off: Space vs O(1) Access

This is a deliberate design choice, not an oversight.

The O(1) lookup formula — `page = node_id / 101`, `slot = node_id % 101` — only works because a node's position is permanently fixed by its ID. If a deleted slot could be reused by a future node with a different ID, the mapping breaks. You would need an extra level of indirection: a slot map, a free list, or some other structure that says "node 47 is now in slot 3 of page 6." That indirection costs a read and introduces fragmentation of the address space itself.

The trade-off: **no fragmentation of the lookup path, at the cost of fragmentation on disk**. A page with 50 deleted nodes still occupies 4 KB. Until every one of its 101 slots is deleted, the page cannot be reclaimed.

#### Why Not a Bitmask?

The initial design used a 64-bit occupancy bitmask in the page header — exactly what the edge store does. An edge page carries an `occupied: u64` bitmask where each bit corresponds to a slot. When an edge is deleted, its bit is cleared. The next insertion scans the bitmask for the first free bit (`trailing_zeros`) and reuses that slot. This is fast and space-efficient.

For nodes, we moved away from this. A bitmask-based allocator severs the identity–location binding: a node's slot becomes an implementation detail rather than something derivable from its ID. Every lookup requires going through the bitmask or an indirection table. <a href="https://neo4j.com" target="_blank">Neo4J</a> takes the same approach Nexora settled on for nodes — IDs are durable and location is fixed. The result is a simpler, branchless lookup path that scales to any database size without additional bookkeeping.

Edge slot reuse is covered in the next post, including why the bitmask is the right call for edges (edges are created and destroyed far more frequently than nodes, so the space savings justify the added complexity).

---

## Scanning All Nodes

Full scans use a cursor:

```rust
let mut cursor = store.scan_cursor()?;
while let Some(node) = store.cursor_next_node(&mut cursor)? {
    // process node
}
```

```
footer.first_node_page
        │
        ▼
┌─────────────┐  next_page_id  ┌─────────────┐  next_page_id  ┌─ ─ ─ ─
│   Page 2    │───────────────►│   Page 5    │───────────────►│   …
│  [0] active │ ← yield        │  [0] active │ ← yield
│  [1] deleted│   skip ──►     │  [1] active │ ← yield
│  [2] active │ ← yield        │  [2] deleted│   skip ──►
│     …       │                │     …       │
└─────────────┘                └─────────────┘
 ▲
 cursor  { page: 2, slot: 0 }
```

The cursor holds a `PackedPtr` to the next position to read. It walks the page chain linearly, skipping records where `flags == DELETED`. When all records on a page are processed, the cursor advances to the first slot of the next page via `next_page_id`.

The scan walks the physical page chain directly from `first_node_page` in the footer — the page index is not involved.

### What is a Cursor?

A cursor is a lightweight bookmark into the data — it remembers *where you are* in a scan so the engine can pause and resume without holding the entire dataset in memory.

Nexora's cursor is borrowed from <a href="https://sqlite.org" target="_blank">SQLite</a>'s B-tree cursor model. In SQLite, a cursor points to a position within a B-tree page; you advance it one row at a time, and the cursor tracks both the page and the cell offset. Nexora adapts the same idea for a flat page chain: the cursor is just a `PackedPtr` — a page ID and a slot — and advancing it means either incrementing the slot or following `next_page_id` to the next page.

This is useful for several reasons:

- **No materialisation** — you never load all nodes at once. Each `cursor_next_node` call reads one record. For a database with millions of nodes, the memory cost of a full scan is constant.
- **Composability** — the caller controls the loop. You can stop early, filter as you go, or feed results into a pipeline without buffering.
- **Stateless between calls** — the cursor is just a value. It can be stored, cloned, or passed across function boundaries without the scan "knowing" it was interrupted.

---

## The Same-Page Optimisation

When an edge is inserted between two nodes, both nodes need their adjacency list head pointer updated — `first_out_edge` on the source and `first_in_edge` on the destination. If both nodes live on the same page (their IDs fall in the same block of 101), Nexora reads the page once, updates both records, and writes it back once:

```
src_id = 5,  dst_id = 7   →  both on page 0  →  1 read + 1 write
src_id = 5,  dst_id = 110 →  different pages  →  2 reads + 2 writes
```

This is a concrete benefit of packing multiple records per page. Dense graphs where edges connect nearby nodes get this for free.

---

## What's Next

The next post will cover **edge storage** — how the adjacency lists are built and maintained on disk, the occupancy bitmask slot allocator, and what it takes to delete an edge while keeping both the outgoing and incoming chains consistent.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
