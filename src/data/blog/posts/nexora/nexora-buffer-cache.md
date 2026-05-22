---
title: "Building a Graph Database 6 - Buffer Store"
author: "Suhan Bangera"
pubDatetime: 2026-05-22T13:00:00Z
description: "How Nexora caches pages in memory to avoid redundant disk reads, what the clock eviction algorithm does, and how dirty pages are written back on close."
featured: false
isSeries: true
series: "Nexora"
chapter: 6
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 5](/posts/posts/nexora/nexora-label-and-string-storage/) we covered how strings and labels are stored on disk — the two-ended buffer, overflow chaining, and the deduplication layer that keeps labels as integers everywhere in the engine. This post steps back from individual page layouts and looks at something that cuts across all of them: **the buffer store**, Nexora's in-memory page cache.

---

## Why a Cache?

Every operation in Nexora eventually comes down to page reads and writes. A node lookup reads a page index page, then a node page. Inserting an edge reads two node pages, writes them back, and writes an edge page. For a hot graph — one where the same nodes and edges are touched repeatedly — doing a disk read on every one of those accesses would be slow.

The buffer store sits between the graph engine and the disk. Its job is simple: keep recently used pages in memory so that repeated accesses do not hit the disk at all. The graph engine does not need to know or care whether a page came from cache or disk — it calls the same `read_page` and `write_page` interface either way.

---

## The Structure

The buffer store is a fixed-size pool of **frames**. A frame is a 4 KB slot in memory — exactly the size of one page on disk. The pool holds **2048 frames**, giving a total cache size of **8 MB** (`1 << 23` bytes).

```
BufferStore
┌───────────────────────────────────────────────────────────────┐
│  frames[0]      frames[1]      frames[2]   …   frames[2047]  │  ← 2048 × 4 KB = 8 MB
│  [page data]    [page data]    [page data]     [page data]   │
└───────────────────────────────────────────────────────────────┘
  page_ids[0]     page_ids[1]    page_ids[2]     page_ids[2047]   ← which page is in each frame
  dirty_bits:     [BitSet64<32>  — 2048 bits, one per frame]      ← frame has unsaved writes
  ref_bits:       [BitSet64<32>  — 2048 bits, one per frame]      ← frame was recently accessed
  clock_hand:     usize                                           ← eviction sweep position
  store:          S (underlying disk PageStore)
```

`frames` and `page_ids` are both heap-allocated (`Box<[_]>`). The primary reason is size: at 8 MB, the frame pool alone would exceed or nearly exhaust the default thread stack on most platforms (typically 1–8 MB on Linux and macOS, 1 MB on Windows). Placing that much data on the stack risks a <a href="https://en.wikipedia.org/wiki/Stack_overflow" target="_blank">stack overflow</a> — the program writing past the end of its stack segment into adjacent memory, causing a crash or silent corruption. Nexora's own test suite works around this by spawning threads with a manually enlarged 16 MB stack whenever a `BufferStore` is involved, which is a direct acknowledgement of the problem. Heap allocation sidesteps it entirely: `Box<[_]>` allocates from the heap at construction time and the struct itself holds only a fat pointer.

The secondary reason is alignment. Each `Frame` is declared `#[repr(align(4096))]`, guaranteeing 4096-byte alignment in memory. The heap allocator respects this; stack placement does not have that guarantee for large arrays.

`page_ids` maps a frame index back to the page currently occupying it. On startup every slot is set to `SENTINEL_PAGE_ID` — meaning empty.

`dirty_bits` and `ref_bits` are `BitSet64<32>` — the same generalised bitset used elsewhere in Nexora, here sized to 32 words × 64 bits = 2048 bits, one per frame.

### Why 8 MB?

Nexora is an embedded database in the SQLite mould — it runs inside the process that uses it, not as a separate server. The design constraint is that it must be usable without any configuration and without surprising the host application with large resource usage.

8 MB is a hardcoded compile-time constant (`BUFFER_POOL_SIZE = 1 << 23`). It is large enough to hold the hot working set of most small-to-medium graphs in memory — 2048 pages × 101 nodes = over 200,000 nodes entirely in cache before a single eviction. It is small enough to be allocated unconditionally without worrying about the host machine's available RAM. There is no graceful degradation path for machines with less memory — Nexora assumes 8 MB is always available, which is a reasonable assumption for any environment where you would embed a database. The constant can be changed at compile time if a different tradeoff is needed. 

A dynamic buffer cache size is not difficult to implement with the current design, but it is purposefully avoided to keep things simple, although dynamic cache sizing is planned for future versions.

---

## Reading a Page

When the engine calls `read_page(page_id)`, the buffer store:

1. **Checks the cache** — scans `page_ids` for a frame holding `page_id`.
2. **On a hit** — sets the frame's `ref_bit` (marking it recently used) and copies the frame's bytes into the caller's buffer. No disk access.
3. **On a miss** — evicts a frame (see below), reads the page from disk into that frame, sets the `ref_bit`, and returns the data.

The cache check is a **linear scan** over `page_ids`. At 2048 entries of 8 bytes each the scan touches 16 KB of memory in the worst case — sequential access that modern CPUs can tear through in a handful of microseconds. A disk read that it avoids costs milliseconds. The scan is not a bottleneck; it would only become one if the pool were significantly larger, at which point a hash map would be the right replacement.

In practice, benchmarks showed the linear scan consistently outperforming a hash map at this scale. The reason is cache locality: `page_ids` is a flat array of `u64` values laid out contiguously in memory, so the CPU prefetcher can stream through it without any pointer chasing. A hash map, by contrast, involves hashing overhead, potential bucket indirection, and less predictable memory access patterns — costs that only pay off once the collection is large enough that the scan itself becomes the bottleneck.

---

## Writing a Page

`write_page(page_id, data)` does not write to disk immediately. Instead:

1. Find the frame holding `page_id`, or evict one if not cached.
2. Copy the new data into that frame.
3. Set the frame's `dirty_bit` and `ref_bit`.

The write stays in memory until the frame is evicted or the database is closed. This is **write-back caching** — batching disk writes rather than flushing on every change.

The tradeoff is durability: if the process crashes after `write_page` returns but before the buffer is flushed, those writes are lost — though a clean exit will still flush them via `Drop`. Crash recovery is handled by the WAL layer, which ensures that writes are recoverable even if the process never gets a chance to flush. That is covered in the next post; for now, the rule is: a crash requires the WAL to recover, everything else is handled on the way out.

---

## The Clock Eviction Algorithm

When the cache is full and a new page needs to be brought in, a frame must be freed. The buffer store uses the <a href="https://en.wikipedia.org/wiki/Page_replacement_algorithm#Clock" target="_blank">clock algorithm</a> — a practical approximation of LRU that requires no timestamps and no sorted structure. It is the same policy used by <a href="https://sqlite.org" target="_blank">SQLite</a>'s page cache and by most OS kernels (Linux, macOS, Windows) for virtual memory page replacement. True LRU requires maintaining a sorted access-order list and updating it on every read and write — O(1) with a doubly-linked list, but with non-trivial constant overhead and poor cache behaviour under concurrent access. Clock achieves similar eviction quality with a single bit per frame and a cheap circular sweep.

The idea is a circular sweep. The `clock_hand` points at the current candidate frame. Each frame has a `ref_bit` that is set whenever the frame is accessed (read or write). The sweep works like this:

```
for each frame (in circular order starting at clock_hand):
    if ref_bit is set:
        clear ref_bit          ← give it a second chance
        advance clock_hand
    else:
        this is the victim     ← ref_bit was already clear; evict it
```

A frame with its `ref_bit` set gets one reprieve — the bit is cleared and the hand moves on. If the hand comes back around and the bit is still clear, the frame has not been used since its last chance and is evicted.

Before evicting, the store checks the `dirty_bit`. If the frame has unsaved writes, it is flushed to disk first:

```
evict(frame):
    if dirty_bits[frame]:
        write frames[frame] → disk
        clear dirty_bits[frame]
    clear page_ids[frame]    ← slot is now free
    return frame
```

The clock loop always terminates. If every frame is dirty, the algorithm still makes progress — it flushes whichever frame it selects as the victim rather than skipping it. There is no scenario where all frames are dirty and the eviction stalls.

---

## An Example

Suppose the cache holds pages A, B, C with their ref bits:

```
clock_hand
     ↓
┌────────┬────────┬────────┐
│  A     │  B     │  C     │
│ ref=1  │ ref=0  │ ref=1  │
└────────┴────────┴────────┘
```

A new page D needs to come in. The sweep:

1. Frame A: `ref=1` → clear to `ref=0`, advance.
2. Frame B: `ref=0` → evict. If dirty, flush to disk first.

```
┌────────┬────────┬────────┐
│  A     │  D     │  C     │
│ ref=0  │ ref=1  │ ref=1  │
└────────┴────────┴────────┘
```

If B had been accessed recently its `ref_bit` would have been set, giving it another pass. The clock naturally preserves hot pages — pages accessed frequently keep having their bits re-set before the hand returns.

---

## Flushing and Close

`flush` iterates `dirty_bits` with `first_set` — the same `trailing_zeros` trick used across Nexora's bitsets — and writes each dirty frame to disk in turn:

```rust
while let Some(i) = self.dirty_bits.first_set() {
    self.flush_frame(i)?;
}
```

On `close`, flush runs first, then the underlying `PageStore` is closed. Both `StorageManager` and `BufferStore` implement Rust's <a href="https://doc.rust-lang.org/std/ops/trait.Drop.html" target="_blank">`Drop` trait</a> — a hook the compiler calls automatically when a value goes out of scope, analogous to a destructor in C++. This means dirty pages are written to disk even if `close` is never called explicitly.

---

## What's Next

The next post will cover **indexes** — how Nexora maps a logical page number to a physical page ID in O(1), what a directory page looks like on disk, and how the index grows when the database exceeds a single directory page.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
