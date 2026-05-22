---
title: "Building a Graph Database 5 - Labels and Strings"
author: "Suhan Bangera"
pubDatetime: 2026-05-22T12:00:00Z
description: "How Nexora deduplicates label strings, maps label IDs to string data in O(1), and stores variable-length strings in a two-ended buffer with overflow chaining."
featured: false
isSeries: true
series: "Nexora"
chapter: 5
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 4](/posts/posts/nexora/nexora-edge-storage/) we covered edge storage — the bitmask slot allocator, two simultaneous adjacency lists, and the cost of deletion. This post covers two layers that sit beneath both nodes and edges: **the label store** and **the string store**. Every node label and edge label is a string, but strings live exactly once on disk. This post explains how that deduplication works and how variable-length string data is stored in fixed-size pages.

---

## What is a Label?

A label is a string that classifies a node or an edge — it answers the question *"what kind of thing is this?"*

For nodes: `"Person"`, `"Movie"`, `"City"`. For edges: `"FOLLOWS"`, `"ACTED_IN"`, `"DEPENDS_ON"`. Labels are not properties — they are not key-value pairs describing attributes of an entity, they are the entity's type. Every node has exactly one label; every edge has exactly one label.

Because labels are categorical, the same string appears on many records. `"Person"` might appear on a hundred thousand nodes. That repetition is exactly what makes deduplication worthwhile.

---

## Deduplication

Deduplication means storing a value once and referencing it by a short identifier everywhere else. Instead of writing `"Person"` into every node record, you write it to disk once, assign it an integer ID, and store only the integer in the node.

For labels this is a natural fit. A graph might have a million `"Person"` nodes. Without deduplication, that is a million copies of the same 6-byte string on disk — 6 MB for a value that never varies. With deduplication, it is one 6-byte string and a million 4-byte integers — about 4 MB, and the storage cost stays fixed regardless of how many more `"Person"` nodes you add.

The deeper benefit is query performance. Finding all nodes labelled `"Person"` would require a string comparison per node without deduplication. With a `label_id`, it is a 32-bit integer comparison — faster, branchless, and directly comparable by the CPU without touching the string store at all.

Nexora assigns each unique label string a sequential integer `label_id` starting at zero. The label store maps that ID back to the string bytes when a human-readable name is needed. Everything else in the engine — node records, edge records, traversal, filtering — works exclusively with the integer.

---

## The Label Store

The label store is a two-level structure:

1. **Label pages** — fixed-size records mapping where each label-id is mapped to a physical location in the file where the actual string is stored i.e `label_id → PackedPtr`
2. **Label string pages** — the actual UTF-8 bytes of strings, stored in a dedicated string page chain.

### The Label Page Header

Each label page begins with the standard 32-byte `NexoraPageHeader`, followed by an 8-byte **label page header**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 4 | `first_label_id` (u32 — unsigned 32-bit integer / 4 bytes, LE) — ID of the first label record on this page |
| 4 | 2 | `label_count` (u16 — unsigned 16-bit integer / 2 bytes, LE) — number of records on this page |
| 6 | 2 | padding |

Just like the nodes, here we focus on achieving constant-time lookups. `first_label_id` is the key to O(1) lookup. Because label IDs are assigned sequentially and records are packed in order, the slot of any label within a page is `label_id − first_label_id`. No scan, a single subtraction gives the array index of desired label directly.

`label_count` bounds the range: a page owns IDs from `first_label_id` to `first_label_id + label_count − 1`.

Capacity: `(4096 − 32 − 8) / 32 = 126 label records per page`.

### The Label Record

Every label is a fixed-size **32-byte record**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `label_id` (u64, LE) |
| 8 | 8 | `string_address` (PackedPtr) — points to the string data in the label string store |
| 16 | 1 | `label_length` — byte length of the label string (max 255) |
| 17 | 15 | padding |

`string_address` is a `PackedPtr` pointing to the first slot in the label string store that holds this label's bytes. `label_length` is cached here to enable a fast length check without fetching the string data (covered below).

---

## Inserting a Label

When a node or edge is created with label `"Person"`, the engine calls `insert_label(b"Person")`:

1. **Deduplication check** — scan all label pages, comparing `label_length` first, then fetching string bytes only for length matches.
2. If found, return the existing `label_id`.
3. If not found, write the string bytes into the label string store to get a `PackedPtr`.
4. Append a new `LabelRecord` to the current label page. If the page is full, allocate a new one.
5. Increment the latest label counter in the [footer](/posts/posts/nexora/nexora-file-format) — this counter is the next `label_id`.

### The Length Fast Path

`find_label_id` uses a two-level comparison to avoid unnecessary string reads:

```rust
for i in 0..count {
    let record = page.label_records[i];
    // Fast path: skip string fetch if lengths differ.
    if record.label_length as usize != data_len {
        continue;
    }
    // Only fetch string bytes when length matches.
    let len = LabelStringStore::get(record.string_address, &mut buf);
    if &buf[..data_len] == data {
        return Ok(Some(record.label_id.get() as u32));
    }
}
```

Most label lookups terminate at the length check. A graph with labels like `"Person"`, `"Movie"`, `"City"`, `"Relationship"` has at most a handful of candidates per length bucket. String bytes are fetched only when the length matches — which in practice means almost never for non-matching labels.

---

## Looking Up a Label by ID

Label pages are indexed the same way node pages are — a page index maps a range of label IDs directly to a physical page, so the engine jumps straight to the right page without walking the chain.

Once on the right page, you subtract the page's starting ID from the ID you want. That subtraction is the array index. No scan, no comparison loop — one subtraction and you are pointing at the record. You then follow the `string_address` from that record to the string page where the actual UTF-8 bytes live.

```
page_index[label_id / 126]  →  physical page         ← O(1) index lookup

  slot           = label_id % 126                     ← O(1) arithmetic
  string_address = page.label_records[slot].string_address

Fetch string bytes from string_address.
```

For example, looking up `label_id = 5`:

```
label_id = 5

Label Page 0  (first_label_id = 0,  label_count = 126)
┌──────┬──────┬──────┬──────┬──────┬──────┬─────┐
│  0   │  1   │  2   │  3   │  4   │  5   │ … │
└──────┴──────┴──────┴──────┴──────┴──────┴─────┘
                                    ↑
                         slot = 5 - 0 = 5
                         → string_address → string page
```

The index lookup is O(1) — one read to find the page, one subtraction to find the slot within it.

---

## The String Store

The string store is where raw UTF-8 bytes live. Both labels and general string properties use the same page layout — just different page chains (the footer tracks `first_label_string_page` separately from `first_string_page`).

### The Challenge of Variable-Length Data (aka. String)

Every other record type in Nexora — nodes, edges, labels — is fixed-size. Fixed-size records are easy: you know exactly how much space each one takes, you can pack them densely into a page, and you can find any record by arithmetic. Strings break all of that.

A string can be 1 byte or 65,535 bytes. You do not know its size until you have it in hand. This creates three problems that do not exist for fixed-size records:

**Placement.** You cannot pre-divide a page into equal slots. If you carve a page into 64-byte cells, a 5-byte string wastes 59 bytes; a 200-byte string does not fit at all. Any fixed cell size is either too wasteful or too small.

**Locating data later.** With fixed-size records you compute position from an index. With variable-length data, you need to record where each string actually landed — its byte offset within the page — because you cannot derive it from the record number alone.

**Overflow.** A string that is longer than what remains on the current page cannot be split arbitrarily — or rather, it can, but then the reader needs a way to follow the pieces and reassemble them in order. That requires a chaining mechanism.

The two-ended buffer and the overflow chain are Nexora's answers to all three of these problems.

### The Two-Ended Buffer

A string page consists of a buffer (`buf`) which is **4000 bytes** (after removing the 32-byte `NexoraPageHeader` and 64-byte string page header). Every string stored on a page has two parts: a **slot** — a fixed-size 16-byte record that describes where the string data is and how long it is — and the **string data** itself, the raw UTF-8 bytes. The slot is always 16 bytes; the data is variable.

The challenge is fitting both into one fixed buffer without wasting space. The two-ended buffer solves this by giving each its own end of the buffer to grow into, with free space in between acting as a shared reservoir.

- **Slots grow forward** from `buf[0]`, 16 bytes each. Every new string gets a slot appended at the front.
- **String data grows backward** from `buf[3999]`, variable size. Each new string's bytes are written just before the previous string's bytes.

The reason data grows backward is to keep the free space contiguous. If both ends grew in the same direction, you would need to shuffle data around whenever the two regions met. Growing toward each other means the free space is always a single unbroken gap between them — no fragmentation, no compaction. The page is full only when the two fronts meet.

```
buf[0 .. 4000]
┌─────────┬─────────┬─────────┬──────────────────────┬──────────────────┐
│  Slot 0 │  Slot 1 │  Slot 2 │      free space      │  data 2 · 1 · 0  │
│  16 B   │  16 B   │  16 B   │                      │  (grows ←)       │
└─────────┴─────────┴─────────┴──────────────────────┴──────────────────┘
 slot_count grows →                         ← record_offset grows
```

The page has space as long as the two regions have not collided:
`(slot_count + 1) × 16  ≤  record_offset − data_len`

### The String Page Header

The 64-byte string page header tracks buffer state:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 32 | `occupied` (Bitset256) — 256-bit occupancy bitmap, one bit per slot |
| 32 | 2 | `slot_count` (u16, LE) — high-water mark; total slots ever written |
| 34 | 2 | `record_offset` (u16, LE) — current write position for string data |
| 36 | 28 | padding |

`Bitset256` is a 256-bit occupancy map stored as four `u64` words (4 × 8 = 32 bytes). Each bit position corresponds to one slot — bit N is `1` if slot N is live, `0` if it is free or deleted. The four words cover bit positions 0–63, 64–127, 128–191, and 192–255, giving a capacity of 256 slots per page.

Because each word is a plain `u64`, every operation is a single CPU instruction with no branching:

- **Set** bit N: `words[N >> 6] |= 1 << (N & 63)` — select the right word with `N >> 6` (divides by 64), then set the right bit within it with `N & 63` (takes the remainder).
- **Clear** bit N: `words[N >> 6] &= !(1 << (N & 63))`
- **Find first free slot**: scan words left to right; for the first word that is not all-ones (`!= u64::MAX`), run `trailing_zeros()` on its bitwise complement to get the index of the lowest `0` bit.

This is the same `trailing_zeros` trick used by the edge page's `occupied: u64` bitmask, just generalised to 256 bits by splitting across four words instead of one.

### The String Slot

Each slot is a **16-byte record** at the front of the buffer:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `overflow_slot` (PackedPtr) — next chunk if string spans pages, NULL if last |
| 8 | 2 | `total_length` (u16, LE) — full string length; set only on the first chunk, 0 on continuations |
| 10 | 2 | `chunk_length` (u16, LE) — bytes of data in this chunk |
| 12 | 2 | `offset` (u16, LE) — byte offset within `buf` where this chunk's data starts |
| 14 | 2 | padding |

`total_length` being set only on the first chunk means the reader knows the full size upfront — it can validate the output buffer before reading any continuation.

---

## Inserting a String

For strings up to `MAX_STRING_CHUNK_SIZE` (3984 bytes), a single slot holds all the data. For longer strings (max 65535 bytes), the engine splits the string into chunks and chains them via `overflow_slot`.

Chunks are inserted **last-first**: the tail of the string is stored first, and each newly stored chunk's `overflow_slot` points forward to the chunk stored before it. The head chunk (beginning of the string) is stored last and returned as the canonical `PackedPtr`.

```
String: "ABCDE … XYZ"  (split into 2 chunks)

Step 1: store tail chunk "… XYZ"   → ptr_B,  overflow = NULL
Step 2: store head chunk "ABCDE …" → ptr_A,  overflow = ptr_B

Return ptr_A

Reading: ptr_A → "ABCDE …" → ptr_B → "… XYZ" → NULL
         reassembles "ABCDE … XYZ"
```

For label strings (always ≤ 255 bytes) the chain has exactly one slot and no overflow.

---

## Reading a String

Reading starts from the `PackedPtr` returned when the string was inserted. That pointer identifies the first chunk — the page and the slot within it. The slot tells you the byte offset of the data within that page's buffer and how many bytes this chunk contributes. You copy those bytes into the output buffer, then check `overflow_slot`: if it is non-null, you repeat the process on the next chunk, appending to wherever the previous copy left off. The loop ends when `overflow_slot` is null, meaning you have reached the last (or only) chunk.

The first chunk also carries `total_length` — the full reassembled length of the string — so the caller knows the final size before reading any continuation. For single-chunk strings (all labels and most short properties) there is exactly one page read and one copy, and the loop exits immediately.

`get(ptr, out)` follows the chain and fills `out` sequentially:

```rust
while !current_ptr.is_null() {
    let page = read_page(current_ptr.page_id());
    let slot = page.get_slot(current_ptr.slot());

    if bytes_written == 0 {
        total_length = slot.total_length;  // full length from first chunk only
    }

    page.read_data(slot.offset, slot.chunk_length, &mut out[bytes_written..]);
    bytes_written += slot.chunk_length;
    current_ptr    = slot.overflow_slot;
}
```

For single-chunk strings — the common case for labels — this is one page read and one `memcpy`. Done.

---

## Deleting a String

Deletion walks the chain and clears the `occupied` bit for each slot. The data bytes are not zeroed and the buffer space tracked by `record_offset` is not reclaimed.

Currently, deleted string slots are **not reused** — insertion always appends at `slot_count` and never consults the `Bitset256` to find a free gap. The bitset is already in place for this purpose (the same `first_zero` path used by edge pages), but the allocation side has not been wired up yet. This is a known limitation being worked on; once it is, freed slots will be reclaimed within the same page rather than requiring a full page free.

---

## What's Next

The next post will cover the **Buffer Store** — how Nexora caches pages in memory to avoid redundant disk reads, what the clock eviction algorithm does, and how dirty pages are written back on close.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
