---
title: Building a Graph Database - The File Format
author: Suhan J Bangera
pubDatetime: 2026-05-21T10:00:00Z
description: "Every database is ultimately a file. This post walks through how Nexora
  lays out nodes, edges, and properties on disk — fixed-size pages, a
  root-pointer manifest, intrusive linked lists for adjacency, and a packed
  pointer encoding that fits a page address and slot index into a single u64."
featured: true
isSeries: true
series: "Nexora"
chapter: 2
tags:
- database
- graph-database
- rust
- file-format
- deep-dive
- nexora
---

In [part 1](/posts/posts/nexora/nexora-the-why/) I explained *why* I am building Nexora: a
single-file embeddable graph database, the SQLite of graph stores. This post is the
*how*, starting at the lowest level: the file itself.

Everything in Nexora — every node, every edge, every property — lives in a
single `.nxr` file. No WAL journal shipped separately (it is a sidecar, not
embedded), no auxiliary index files, no directory of segment files. Open the
file, read the pages, you have the database.

---
## On-Disk Representation

The `.nxr` file is a raw binary file. There is no text encoding, no delimiters, no human-readable structure — just bytes.

Every multi-byte integer in the file is stored in **little-endian** order: the least significant byte comes first. So the value `1` as an 8-byte integer on disk is `01 00 00 00 00 00 00 00`, not `00 00 00 00 00 00 00 01`. This matches the native byte order of x86 and ARM processors, which means the CPU can load a value directly off disk into a register without swapping any bytes. Throughout this post, field descriptions marked `(u64, LE)` or `(u32, LE)` are reminders of this contract.

---

## Everything is a <a href="https://en.wikipedia.org/wiki/Page_(computer_memory)" target="_blank">Page</a>

The db file is divided into fixed-size **4 KB chunks** or a single **OS Page**. 

#### *But why is that??*

That 4KB number (A page) is not arbitrary, but rather it is the smallest unit of memory that the OS manages when mapping between virtual memory address and physical RAM. The CPU's memory management unit (MMU) divides both virtual and physical memory into fixed-size chunks — pages. When a process accesses a virtual address, the MMU translates it to a physical address via a page table. If the physical page isn't in RAM, the OS triggers a page fault and loads it from disk.

This is why Nexora uses 4KB pages for its file format, a single ***read()/write()*** syscall on a 4KB-aligned buffer maps to exactly one OS page transfer, with no wasted partial reads. The filesystem block size is also typically 4 KB for the same reason, so disk I/O aligns cleanly too.

### Page Structure

Every page begins with a 32-byte **page header**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `page_id` (u64 — unsigned 64-bit integer / 8 bytes, LE) |
| 8 | 8 | `next_page_id` (u64, LE) |
| 16 | 8 | `prev_page_id` (u64, LE) |
| 24 | 4 | `checksum` (CRC32, LE) |
| 28 | 1 | `page_type` |
| 29 | 3 | padding |

`checksum` is a CRC32 over the page body. Every read verifies it; every write stamps a fresh one. Silent corruption does not go undetected.

#### Null Representation

`next_page_id` and `prev_page_id` are used to chain pages of the same type into a linked list. And now since there's a linked-list that means there should be the terminal nodes which point to null, and since there isn't a concept of null value in binary, we assign a sentinel value `0xFFFFFFFFFFFFFFFF` (all bits set) as the equivalent to null pointer, which in this context would mean "no next page".

### Page Type

`page_type` tags what the page contains:

| Value | Type        | Contents                              |
|------:|-------------|---------------------------------------|
| 0     | Header      | File header — magic, version, layout  |
| 1     | Footer      | Root-pointer manifest                 |
| 2     | Node        | Graph node records                    |
| 3     | Edge        | Graph edge records                    |
| 5     | PageIndex   | Page-id → page-offset index           |
| 6     | Label       | Label deduplication records           |
| 7     | Free        | Reclaimed pages available for reuse   |
| 8     | String      | Variable-length string data           |
| 9     | Property    | Key-value property records            |
| 10    | LabelString | String storage dedicated to labels    |

---

## Page 0 — The File Header

The very first page is the file header. Its job is identification and
self-description:

```
NXRA                   ← 4-byte magic
version = 1            ← format version
page_size = 4096       ← sanity check on open
footer_page_id = 1     ← where the root manifest lives
```



The magic bytes `NXRA` let tools (and the OS) identify the file type
immediately. The version field allows the engine to refuse to open a file
written by an incompatible future version. The `footer_page_id` is the only header field that changes during the lifecycle of the database, it is meant to relocate the footer whenever the file grows without breaking the format.

---

## Page 1 — The Footer

If the header is the file's identity card, the footer is its **table of
contents**. It holds a pointer to the head (and tail) of every page chain in
the file, plus a running total of how many records exist:

| Field | Purpose |
|-------|---------|
| `node_count` | Total nodes in the database |
| `first_node_page` | Head of the node page chain |
| `last_node_page` | Tail of the node page chain |
| `next_node_id` | Next auto-assigned node ID |
| `edge_count` | Total edges in the database |
| `first_edge_page` | Head of the edge page chain |
| `last_edge_page` | Tail of the edge page chain |
| `next_edge_id` | Next auto-assigned edge ID |
| `page_indices_count` | Number of node→page index entries |
| `first_page_index_page` | Head of the page index chain |
| `free_pages_count` | Number of reclaimed pages available for reuse |
| `first_free_page` | Head of the free page chain |
| `first_string_page` | Head of the string data page chain |
| `last_string_page` | Tail of the string data page chain |
| `label_pages_count` | Number of label pages allocated |
| `first_label_page` | Head of the label record chain |
| `first_label_string_page` | Head of the label string data chain |
| `first_property_page` | Head of the property page chain |
| `page_count` | Total pages allocated (starts at 2 — header + footer) |



When the engine opens a file, it reads page 0 (to get `footer_page_id`), then
reads page 1 (the footer) to find every chain head. From there, the engine
can reach any record in the file by following page links. The footer is
updated on every write and flushed last — it is the single source of truth
about the database state.

---

## Node Records

Node pages pack up to **101 node records** per page. Each record is exactly
40 bytes:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `node_id` (u64, LE) |
| 8 | 8 | `first_out_edge` (PackedPtr) |
| 16 | 8 | `first_in_edge` (PackedPtr) |
| 24 | 8 | `properties` (PackedPtr) |
| 32 | 4 | `label_id` (u32 — unsigned 32-bit integer / 4 bytes, LE) |
| 36 | 1 | `flags` (0=active, 1=deleted) |
| 37 | 3 | padding |



The math: `(4096 − 32 bytes page_header − 4 bytes node_page_header) / 40 = 101 records`.

`label_id` is a 32-bit integer that references a deduplicated label record
(more on that below). Storing a 4-byte ID instead of repeating the string
`"Person"` across millions of records keeps node records small and makes
label comparison a cheap integer equality check.

`flags` is a single byte — `0` for active, `1` for deleted. Deletion is
always logical first (flip the flag, continue); physical reclamation happens
when a page can be freed.

### Slot addressing

Given a `node_id`, Nexora finds its record in two steps:

```
page_id = node_id / 101   →  which page
slot    = node_id % 101   →  which slot within that page
```

This is O(1) direct addressing — no scan, no index lookup, just integer division and a modulo. The page index stores the mapping from page number to physical page ID on disk, so the full lookup is: compute slot, look up page ID, read one page, index into the record array.

The trade-off is space reuse. A node's slot is permanently bound to its ID. When a node is deleted, its slot is flagged but cannot be reclaimed by a new node, new nodes always append at the next `record_count` position. Edges solve this differently with a bitmask that tracks free slots explicitly, which is why edge pages can reuse deleted slots immediately. The full implications of this design, and when it matters, will be covered in a future post.

### A Note on PackedPtr

`first_out_edge`, `first_in_edge`, and `properties` are all `PackedPtr`
values — a single `u64` that encodes both a **page ID** and a **slot index**:

```
 63                             8  7        0
 ┌────────────────────────────────┬──────────┐
 │           page_id              │   slot   │
 │           56 bits              │  8 bits  │
 └────────────────────────────────┴──────────┘

 Example — page 7, slot 2:
   pack:   (7 << 8) | 2  =  0x0000000000000702
   unpack: page_id = ptr >> 8    →  7
           slot    = ptr & 0xFF  →  2
   null:   0xFFFFFFFFFFFFFFFF (all bits set)
```



`0xFFFFFFFFFFFFFFFF` (all bits set) is the null pointer. The encoding is
cheap: pack is `(page_id << 8) | slot`; unpack is a shift and a mask.

This is how Nexora avoids heap-allocated pointer structures entirely in the
storage layer. An adjacency pointer, a property pointer, an overflow pointer
— all fit in 8 bytes on disk and in a register in memory.

---

## Edge Records

Edge pages hold up to **62 edge records** per page. Each record is exactly **64 bytes**.

### Edge Page Header

Every edge page has a 16-byte header immediately after the `NexoraPageHeader`:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `occupied` (u64, LE) — bitmask, bit N set means slot N is active |
| 8 | 1 | `record_count` — high-water mark of slots ever written |
| 9 | 7 | padding |

Unlike node pages which use a simple append counter, edge pages carry a **64-bit occupancy bitmask**. When an edge is deleted its bit is cleared. The next insert finds the first free slot with a single `trailing_zeros()` on the inverted mask — O(1), no scan. This allows immediate slot reuse after deletion, which matters for graphs with heavy edge churn.

`record_count` is the high-water mark — the highest slot index ever written. New slots are allocated at `record_count` when no deleted slots exist; otherwise the bitmask supplies a recycled slot.

### Edge Record

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `edge_id` (u64, LE) |
| 8 | 8 | `weight` (f64 — 64-bit float / 8 bytes, LE) |
| 16 | 8 | `src_node_id` (u64, LE) |
| 24 | 8 | `dst_node_id` (u64, LE) |
| 32 | 8 | `next_outgoing` (PackedPtr) |
| 40 | 8 | `next_incoming_address_packed` (PackedPtr) |
| 48 | 8 | `property_page_id` (u64, LE) |
| 56 | 4 | `label_id` (u32, LE) |
| 60 | 2 | `property_slot` (u16, LE) |
| 62 | 1 | `flags` (0=active, 1=deleted) |
| 63 | 1 | padding |

`next_outgoing` and `next_incoming_address_packed` form the adjacency lists. Each node holds a pointer to the *head* of its outgoing and incoming edge lists; each edge holds a pointer to the *next* edge in each list. Traversal is a pointer-following loop with no heap allocation:

```
node.first_out_edge → edge₀.next_outgoing → edge₁.next_outgoing → NULL
```

This is an **intrusive singly-linked list** — the link pointer lives inside the record itself, the same pattern used in OS kernels and embedded systems where separate allocations are too expensive.

Edge properties are stored differently from node properties. Rather than a single `PackedPtr`, the record splits the pointer across two fields: `property_page_id` (the page) and `property_slot` (the slot index within it). They are combined into a `PackedPtr` at read time.

---

## Labels

Every label string — `"Person"`, `"City"`, `"KNOWS"` — is stored exactly once and referenced everywhere by a 4-byte `label_id`. Labels are capped at **255 characters** (the `label_length` field in the record is a `u8`).

The first time you call `insert_node("Person")`, Nexora checks the label store for an existing `"Person"` entry. If not found, it writes the string to a LabelString page, creates a Label record mapping the string to a new `label_id`, and returns that ID to be stored in the node record. From that point on every `"Person"` node stores the same 4-byte integer — comparing two node labels is a 32-bit integer equality check regardless of string length.

### Label Page Header

Each label page has an 8-byte header:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 4 | `first_label_id` (u32, LE) — first label ID on this page |
| 4 | 2 | `label_count` (u16, LE) — number of labels stored |
| 6 | 2 | padding |

Labels are assigned sequential IDs. Each page holds a contiguous range starting at `first_label_id`. To look up a label by ID: find the page where `first_label_id <= id < first_label_id + label_count`, then index directly into the record array — O(1). Each page holds up to **63 label records** (`(4096 − 32 − 8) / 64 = 63`).

### Label Record

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `label_id` (u64, LE) |
| 8 | 8 | `string_address` (PackedPtr) — slot in a LabelString page |
| 16 | 1 | `label_length` (u8) — byte length of the label string |
| 17 | 47 | padding |

The actual string bytes live on a separate **LabelString page** (type 10). Reading a label takes two page reads: one Label page for the record, one LabelString page for the bytes.

---

## String Pages

Property keys, property values, and label text all live on string pages (types 8 and 10). Strings can be up to **65 535 bytes** (`u16::MAX`). If a string is longer than what fits on one page it is split into chunks linked by overflow pointers.

### Page Layout

A string page uses a **two-ended buffer**: slot descriptors grow inward from the front, raw string bytes grow inward from the back. The two ends must not meet.

```
┌─────────────────────────────────────────────────────────────┐
│  NexoraPageHeader  (32 bytes)                               │
├─────────────────────────────────────────────────────────────┤
│  GraphStringPageHeader  (64 bytes)                          │
├────────────┬────────────────────────────────────────────────┤
│  slot 0    │                                                │
│  slot 1    │                          ← string bytes        │
│  ...  →    │     "Alice"   "KNOWS"   ...                    │
└────────────┴────────────────────────────────────────────────┘
              ↑ record_offset tracks the back boundary
```

### String Page Header

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 32 | `occupied` (Bitset256) — 256-bit bitmask, one bit per slot |
| 32 | 2 | `slot_count` (u16, LE) — number of slots allocated |
| 34 | 2 | `record_offset` (u16, LE) — byte offset of next free string area (grows backward) |
| 36 | 28 | padding |

### String Slot

Each slot descriptor is 16 bytes:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `overflow_slot` (PackedPtr) — next chunk, or NULL if this is the last |
| 8 | 2 | `total_length` (u16, LE) — full string length in bytes (set on first chunk only) |
| 10 | 2 | `chunk_length` (u16, LE) — byte length of this chunk |
| 12 | 2 | `offset` (u16, LE) — position of this chunk's data in the page buffer |
| 14 | 2 | padding |

To read a string: load the first slot, copy `chunk_length` bytes from `offset`, follow `overflow_slot` to the next chunk if non-null, repeat. The maximum chunk that fits in a single page is **3 984 bytes** (`4096 − 32 − 64 − 16`).

---

## Properties

Properties are key-value pairs where both key and value are strings. They
live on dedicated **Property pages**, with up to 119 records per page. Each
record holds two string pointers — one for the key, one for the value — plus
a back-reference to the owning node or edge.

A node's `properties` PackedPtr points directly to its first property record.
Iterating properties means following that pointer and reading consecutive
records on the same page — a single page read covers all properties for most
nodes.

---

## The Page Index

The slot-addressing formula — `node_id / 101` for the page, `node_id % 101` for the slot — tells you *which logical page* a node lives on, but not where that page is physically on disk. Page IDs are allocated in insertion order and can be scattered across the file. The page index bridges that gap.

It is a linked list of **PageIndex pages** (type 5). Each page holds up to **507 entries**, where each entry is a single 8-byte physical `page_id`. Entry N holds the disk address of the Nth node page in the chain.

The full lookup path for a node:

```
page_index = node_id / 101       →  which entry in the page index
dir_page   = page_index / 507    →  which PageIndex page in the chain
slot       = page_index % 507    →  slot within that PageIndex page
physical   = records[slot].page_id  →  disk address of the node page
→ read that page, take record at slot (node_id % 101)
```

For databases with up to **51,207 nodes** (507 node pages × 101 nodes each), the entire index fits in a single page — one extra read on top of the node page itself. Beyond that, the chain grows by one page per 507 node pages added.

### Page Index Record

Each record is 8 bytes:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `page_id` (u64, LE) — physical page ID of the corresponding node page |

The page index page header has a single field: `page_dir_count` (u16, 2 bytes) — the number of entries stored on that page.

A dedicated post will cover the full lookup path in depth, including how the index is updated on node page allocation and what happens during crash recovery.

---

## The WAL Sidecar

When WAL mode is enabled (the default), writes do not go directly to the
`.nxr` file. Instead they go to a companion `.nxr-wal` file as append-only
**frames**:

```
WAL Header (16 bytes)   magic=NXWL, version, page_size, checksum
Frame 0                 page_id (8), flags (1), pad (7), page_data (4096)
Frame 1                 ...
...
COMMIT frame            flags=1, signals end of a complete session
```



Each frame is `4112 bytes` — a 16-byte header followed by a full 4096-byte
page image. On `close()`, the engine writes a COMMIT frame, then
**checkpoints**: replays all committed frames back into the main file and
truncates the WAL.

On the next `open()`, if a WAL sidecar exists, the engine scans it forward.
Frames that precede a COMMIT are replayed into the in-memory read layer.
Frames with no COMMIT are discarded — they represent an uncommitted session
from a crash and are silently dropped.

The WAL index is an in-memory flat array of `(page_id, wal_offset)` pairs
(capacity: 4096 unique pages per session). Reads check the index first; a hit
serves the page from the WAL, a miss falls through to the main file.

---

## What This Buys You

The entire storage layer has **zero heap allocation** during normal operation.
Every read and write is a fixed-size copy between an on-disk page and a
stack-allocated buffer. The `PackedPtr` encoding means adjacency lists and
property pointers require no separate allocation. CRC32 on every page means
corruption is caught at the read boundary, not discovered three queries later.

The tradeoff is inflexibility: record sizes are fixed at compile time, which
means a schema change (adding a field to the node record) is a breaking format
change. That is a deliberate choice — simplicity and predictability over
runtime flexibility.

---

## What's Next

This post covered the skeleton — how bytes are organised on disk across every page type. Each section above is intentionally brief: the goal was to build a complete map of the file format before zooming in.

Every layer gets its own dedicated post:

- **Node storage** — the slot-addressing scheme in depth, what happens to space when nodes are deleted, and when a new page is allocated
- **Edge storage** — the bitmask slot allocator, how incoming and outgoing adjacency lists are maintained across inserts and deletes
- **String and label storage** — the two-ended buffer layout, overflow chaining for long strings, and why labels get a separate page type
- **Properties** — the linked-list chain, how property lookups avoid full scans
- **The page index** — how Nexora maps a node ID to a physical page ID in O(1) without a heap structure
- **The buffer pool** — in-memory page caching, eviction, and dirty tracking
- **The WAL** — how the write-ahead log achieves session-level atomicity, the recovery scan on open, and why checkpoint-on-close is the simplest correct design

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*