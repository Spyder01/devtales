---
title: "Building a Graph Database 4 - Edge Storage"
author: "Suhan Bangera"
pubDatetime: 2026-05-22T11:00:00Z
description: "A deep dive into how Nexora stores edges on disk — the 64-byte record, the bitmask slot allocator, two simultaneous adjacency lists, and the full cost of deleting an edge."
featured: false
isSeries: true
series: "Nexora"
chapter: 4
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 3](/posts/posts/nexora/nexora-node-storage/) we covered node storage — fixed-size records, identity-bound slot addressing, and O(1) lookup. This post covers the other half of the graph: **edge storage**. Edges are structurally more complex than nodes. Every edge is simultaneously a member of two separate linked lists, and deletion requires repairing both of them.

---

## What is an Edge?

In a directed graph, an edge is a **relationship between two nodes** with a direction: from a *source* node to a *destination* node. An edge from `Alice` to `Bob` labelled `"FOLLOWS"` means Alice follows Bob — not the other way around.

In Nexora, an edge carries:
- **Source and destination** node IDs — who is connected to whom
- **A label** — what kind of relationship it represents (`"FOLLOWS"`, `"KNOWS"`, `"DEPENDS_ON"`)
- **A weight** — an optional `f64` for weighted graphs (distance, cost, similarity score)
- **Two list pointers** — the next edge in the source's outgoing list and the next edge in the destination's incoming list
- **A properties pointer** — optional key-value metadata

---

## The Edge Page

Edge records are packed into **4 KB pages**, each beginning with the standard 32-byte `NexoraPageHeader` (same as every other page type in Nexora).

```
4 KB Edge Page
┌──────────────────────────────────┐  ← byte 0
│         NexoraPageHeader         │    32 bytes
│   page_id · next · prev · crc   │
├──────────────────────────────────┤  ← byte 32
│       Edge Page Header           │    16 bytes
│    occupied (u64) · record_count │
├──────────────────────────────────┤  ← byte 48
│           Record  0              │    64 bytes
├──────────────────────────────────┤  ← byte 112
│           Record  1              │
├──────────────────────────────────┤
│              ...                 │
├──────────────────────────────────┤
│           Record 61              │
├──────────────────────────────────┤
│    padding (80 bytes)            │
└──────────────────────────────────┘  ← byte 4096
```

### The Edge Page Header

Immediately after the `NexoraPageHeader` comes the 16-byte **edge page header**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `occupied` (u64 — unsigned 64-bit integer / 8 bytes, LE) — bitmask; bit N = 1 means slot N is live |
| 8 | 1 | `record_count` — high-water mark; number of slots ever written |
| 9 | 7 | padding |

This header is where edge storage fundamentally diverges from node storage. Instead of a simple append counter, there is a **64-bit occupancy bitmask**. Each bit corresponds to one slot. A `1` means the slot holds a live edge; a `0` means the slot is either never written or was deleted and is free for reuse.

`record_count` is the high-water mark — it tracks how many slots have been written at least once. A slot below the high-water mark with its bit cleared is a deleted slot available for immediate reuse.

---

## The Edge Record

Every edge is a fixed-size **64-byte record**:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0  | 8 | `edge_id` (u64, LE) |
| 8  | 8 | `weight` (f64 — 64-bit IEEE 754 float / 8 bytes, LE) |
| 16 | 8 | `src_node_id` (u64, LE) |
| 24 | 8 | `dst_node_id` (u64, LE) |
| 32 | 8 | `next_outgoing` (PackedPtr) — next edge in source's outgoing list |
| 40 | 8 | `next_incoming_address_packed` (PackedPtr) — next edge in destination's incoming list |
| 48 | 8 | `property_page_id` (u64, LE) |
| 56 | 4 | `label_id` (u32 — unsigned 32-bit integer / 4 bytes, LE) |
| 60 | 2 | `property_slot` (u16 — unsigned 16-bit integer / 2 bytes, LE) |
| 62 | 1 | `flags` (0 = active, 1 = deleted) |
| 63 | 1 | padding |

`next_outgoing` and `next_incoming_address_packed` are the two list pointers. Each edge is a node in two independent singly-linked lists at the same time — one threaded through all edges leaving the source node, one threaded through all edges arriving at the destination node. This is what makes O(1) adjacency traversal possible.

`weight` is stored as an `f64`. Unweighted graphs set it to `f64::MAX` (`SENTINEL_EDGE_WEIGHT`).

`property_page_id` and `property_slot` together encode a `PackedPtr` to the first property record. They are stored split rather than as a packed `u64` to fit the struct's alignment requirements.

---

## The Bitmask Slot Allocator

This is the key mechanism that sets edge storage apart from node storage. When an edge is inserted, the page header's `find_free_slot` runs:

```rust
fn find_free_slot(&mut self) -> Option<usize> {
    let bounds_mask = (1u64 << self.record_count) - 1;
    let deleted = !self.occupied.get() & bounds_mask;

    if deleted != 0 {
        Some(deleted.trailing_zeros() as usize)
    } else if (self.record_count as usize) < MAX_EDGE_RECORD_COUNT {
        Some(self.record_count as usize)
    } else {
        None
    }
}
```

Step by step:
1. **`bounds_mask`** — a bitmask covering only the slots that have ever been written (bits 0 to `record_count - 1`).
2. **`deleted`** — bits that are within the high-water mark *and* currently unoccupied (deleted slots).
3. If any deleted slot exists, `trailing_zeros()` returns the index of the lowest-numbered one — O(1), a single CPU instruction.
4. If no deleted slot exists but capacity remains, append at `record_count`.
5. If the page is completely full, return `None` — the engine allocates a new page.

A diagram makes this concrete. Suppose a page has had 6 edges written, slot 2 was deleted, and slot 4 was deleted:

```
slot:       5  4  3  2  1  0
occupied:   1  0  1  0  1  1   (binary, MSB left)
bounds_mask:1  1  1  1  1  1   (record_count = 6)

deleted = ~occupied & bounds_mask
        = 0  1  0  1  0  0
                      ↑
              trailing_zeros() = 2  →  reuse slot 2
```

When a slot is occupied (`occupy_slot`), its bit is set. `record_count` only increments if the slot being written is at the high-water mark — reusing a deleted slot leaves `record_count` unchanged.

When a slot is freed (`free_slot`), its bit is cleared. `record_count` is **never decremented**.

---

## Inserting an Edge

When you call `insert_edge(src, dst, label, weight)`, the engine:

1. Reads `next_edge_id` from the footer — that becomes the new edge's ID.
2. Reads `first_out_edge` from the source node and `first_in_edge` from the destination node — these become the new edge's `next_outgoing` and `next_incoming` pointers.
3. Finds a free slot on the current edge page using the bitmask allocator. If the page is full, allocates a new page.
4. Writes the edge record into the slot and marks the bit occupied.
5. Updates both nodes: `src.first_out_edge` and `dst.first_in_edge` now point to the new edge.
6. Increments `edge_count` and `next_edge_id` in the footer.

Steps 2 and 5 together implement a **prepend** to both adjacency lists. The new edge takes the old list head as its `next` pointer, then becomes the new head. This is O(1) insertion regardless of how many edges the nodes already have.

```
Before insert(Alice → Bob, "FOLLOWS"):

  Alice.first_out_edge ──► [edge_5: Alice→Carol]──► [edge_1: Alice→Dave]──► NULL
  Bob.first_in_edge    ──► [edge_3: Carol→Bob]  ──► [edge_0: Dave→Bob]  ──► NULL


After insert (new edge_7):

  edge_7.next_outgoing           = old Alice.first_out_edge  (edge_5)
  edge_7.next_incoming           = old Bob.first_in_edge     (edge_3)
  Alice.first_out_edge           = edge_7
  Bob.first_in_edge              = edge_7

  Alice.first_out_edge ──► [edge_7: Alice→Bob]──► [edge_5: Alice→Carol]──► [edge_1: Alice→Dave]──► NULL
  Bob.first_in_edge    ──► [edge_7: Alice→Bob]──► [edge_3: Carol→Bob]  ──► [edge_0: Dave→Bob]  ──► NULL
```

The same physical record `edge_7` is simultaneously the head of Alice's outgoing list and the head of Bob's incoming list. Its two pointers thread it into both chains independently.

---

## The Adjacency Lists

Every node is the head of two separate singly-linked lists:

```
Node: Alice
  first_out_edge ─────────────────────────────────────────────────────────────────┐
                                                                                   ▼
                  ┌─────────────────────────┐   next_outgoing   ┌─────────────────────────┐
                  │  edge_7: Alice → Bob    │ ────────────────► │  edge_5: Alice → Carol  │ ──► NULL
                  └─────────────────────────┘                   └─────────────────────────┘

Node: Bob
  first_in_edge ──────────────────────────────────────────────────────────────────┐
                                                                                   ▼
                  ┌─────────────────────────┐  next_incoming    ┌─────────────────────────┐
                  │  edge_7: Alice → Bob    │ ────────────────► │  edge_3: Carol → Bob    │ ──► NULL
                  └─────────────────────────┘                   └─────────────────────────┘
```

`edge_7` appears in both diagrams. The outgoing list pointer and the incoming list pointer are **independent fields within the same record** — following one does not affect the other.

Traversing Alice's outgoing edges uses `next_outgoing`; traversing Bob's incoming edges uses `next_incoming_address_packed`. They happen to share records along the way, but each chain follows its own pointer field.

---

## Looking Up an Edge

`get_edge(edge_id)` does a linear scan through all edge pages:

```rust
let mut bits = self.graph_page_header.occupied.get();
while bits != 0 {
    let slot = bits.trailing_zeros() as usize;
    if self.edge_records[slot].edge_id.get() == edge_id {
        return Some(self.edge_records[slot]);
    }
    bits &= bits - 1;  // clear lowest set bit — advance to next occupied slot
}
```

The `bits &= bits - 1` trick skips deleted slots without any branching — it peels off one set bit per iteration, visiting only live records.

This is O(edges) — unlike nodes, there is no page index for edges. Direct edge lookup by ID is rarely needed in practice. The primary access pattern is **adjacency traversal**: given a node, follow its `first_out_edge` / `first_in_edge` pointer and walk the list. That is O(degree), not O(all edges).

---

## Deleting an Edge

Deleting an edge is the most involved operation in Nexora's storage layer. Three things must happen:

1. **Clear the bitmask bit** on the edge's page — the slot is freed for reuse.
2. **Splice the edge out of the outgoing chain** — the source node's outgoing list must bypass this edge.
3. **Splice the edge out of the incoming chain** — the destination node's incoming list must bypass this edge.

Steps 2 and 3 each require walking the respective linked list to find the predecessor, then updating its `next` pointer.

```
Deleting edge_7 (Alice → Bob):

Outgoing chain repair (Alice's list):
  Before: Alice.first_out_edge ──► edge_7 ──► edge_5 ──► NULL
  Action: Alice.first_out_edge = edge_7.next_outgoing  (edge_5)
  After:  Alice.first_out_edge ──► edge_5 ──► NULL

Incoming chain repair (Bob's list):
  Before: Bob.first_in_edge ──► edge_7 ──► edge_3 ──► NULL
  Action: Bob.first_in_edge = edge_7.next_incoming  (edge_3)
  After:  Bob.first_in_edge ──► edge_3 ──► NULL
```

If the edge is not at the head of the list — if another edge preceded it — the predecessor's pointer is updated instead of the node's head pointer:

```
  Before: Alice.first_out_edge ──► edge_5 ──► edge_7 ──► edge_1 ──► NULL
  Action: edge_5.next_outgoing = edge_7.next_outgoing  (edge_1)
  After:  Alice.first_out_edge ──► edge_5 ──► edge_1 ──► NULL
```

The cost is O(out-degree) for the outgoing repair and O(in-degree) for the incoming repair. For densely connected nodes, deletion is the most expensive single-edge operation in the system.

### Why Not a Doubly-Linked List?

A doubly-linked list would reduce deletion to O(1) — just update predecessor and successor in place. The trade-off is 8 more bytes per record (two more `PackedPtr` fields) and two more pointer updates per insert. At 64 bytes per record with 62 per page, adding 8 bytes would drop capacity to 57 records per page. Nexora prioritises insert throughput and memory density over deletion speed, consistent with the assumption that graph mutations are less frequent than traversals.

---

## Traversing Edges

The primary use of edge storage is adjacency traversal — walking all outgoing or incoming edges of a node:

```rust
// All outgoing edges from node 42
let mut cursor = store.outgoing_cursor(42)?;
while let Some(edge) = store.cursor_next_outgoing(&mut cursor)? {
    println!("{} → {}", edge.src_node_id(), edge.dst_node_id());
}

// All incoming edges to node 42
let mut cursor = store.incoming_cursor(42)?;
while let Some(edge) = store.cursor_next_incoming(&mut cursor)? {
    println!("{} → {}", edge.src_node_id(), edge.dst_node_id());
}
```

The cursor starts at the node's `first_out_edge` (or `first_in_edge`) and advances by reading the appropriate `next_*` pointer from each record. Each step is one page read (or zero if the next edge is on the same page as the current one). The engine reads no bitmask, no index — just follows the pointer chain directly.

---

## Scanning All Edges

Full edge scans use the same cursor pattern as nodes, but the scan exploits the bitmask differently. Rather than reading every slot and checking `flags`, the scan uses `trailing_zeros` and `bits &= bits - 1` to visit only occupied slots:

```
occupied = 0b00110101  (slots 0, 2, 4, 5 live; slots 1, 3, 6, 7 deleted/empty)

Iteration 1: trailing_zeros = 0  →  read slot 0;  bits = 0b00110100
Iteration 2: trailing_zeros = 2  →  read slot 2;  bits = 0b00110000
Iteration 3: trailing_zeros = 4  →  read slot 4;  bits = 0b00100000
Iteration 4: trailing_zeros = 5  →  read slot 5;  bits = 0
Done.
```

Slots 1, 3, 6, and 7 are skipped entirely — no record read, no branch. In a page with many deletions, this is significantly faster than the node scan's sequential flag check.

---

## What's Next

The next post will cover **labels and strings** — how Nexora deduplicates label strings, what the label store looks like on disk, and how the string page's two-ended buffer handles variable-length data.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
