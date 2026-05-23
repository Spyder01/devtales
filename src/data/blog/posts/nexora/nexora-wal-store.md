---
title: "Building a Graph Database 8 - Write-Ahead Log"
author: "Suhan Bangera"
pubDatetime: 2026-05-23T08:00:00Z
description: "How Nexora's WAL intercepts every page write, what a WAL frame looks like on disk, how recovery scans the sidecar file after a crash, and how checkpoint-on-close moves data back to the main file."
featured: false
isSeries: true
series: "Nexora"
chapter: 8
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 7](/posts/posts/nexora/nexora-indexes/) we covered the page index — how Nexora maps a logical page number to a physical page address in O(1). This post covers the layer responsible for crash safety: **the Write-Ahead Log**, or WAL.

---

## Why a WAL?

The buffer store writes pages to disk on eviction and on close. Both of those are fine during normal operation, but neither is safe against a mid-write crash. If the process is killed while a checkpoint is writing pages to the main `.nxr` file, some pages will have been updated and some will not. The file is in a partially-written, inconsistent state — and there is no way to tell which pages made it and which did not.

A Write-Ahead Log solves this by changing *where* writes go first. Instead of writing a modified page directly to the main file, you append it to a separate sidecar file — the WAL. Only after the write is safely in the sidecar do you eventually apply it to the main file. If the process crashes mid-apply, the WAL still has the complete set of changes. On the next open, Nexora scans the sidecar, rebuilds the list of committed changes, and is back in a consistent state.

The main file is the source of truth for what is durable. The WAL is a journal of what has happened since the last time the main file was fully up to date.

---

## The Sidecar File

When a database is opened with WAL mode, Nexora creates a second file alongside the main `.nxr` file. If the database is at `graph.nxr`, the WAL is at `graph.nxr-wal`. The sidecar is created fresh on each `create` and is preserved across `open`/`close` cycles until a checkpoint clears it.

---

## The WAL Header

The WAL file begins with a fixed 16-byte header:

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 4 | `magic` — `NXWL` |
| 4 | 4 | `page_size` (u32, LE) — must match the main file's page size |
| 8 | 4 | `version` (u32, LE) — currently `1` |
| 12 | 4 | `checksum` (CRC32, LE) — over the first 12 bytes |

The header is verified on every open. A mismatch in `magic`, `version`, or `page_size` — or a checksum failure — returns an error immediately rather than attempting recovery with corrupt data.

---

## The WAL Frame

Every entry in the WAL after the header is a **frame**. There are two kinds: data frames and commit frames.

| Offset | Size | Field |
|-------:|-----:|-------|
| 0 | 8 | `page_id` (u64, LE) — which page this frame describes |
| 8 | 1 | `flags` — `0` = data frame, `1` = commit frame |
| 9 | 7 | padding (alignment to 8 bytes) |
| 16 | 4096 | `page` — full 4 KB page contents (zero for commit frames) |

Each frame is **4112 bytes**. A data frame carries a complete page snapshot — the full 4 KB — along with the page ID it belongs to. A commit frame signals that all preceding data frames form a complete, recoverable transaction; its `page` field is all zeros and its `page_id` is `u64::MAX`.

```
WAL file layout
┌──────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐
│  WAL Header  │  Frame 0 │  Frame 1 │  Frame 2 │  Commit  │  Frame 3 │ …
│   16 bytes   │  4112 B  │  4112 B  │  4112 B  │  4112 B  │  4112 B  │
└──────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘
                 data        data        data       flags=1    data
```

---

## Writing a Page

When `WALPageStore::write_page(page_id, data)` is called:

1. The page bytes are appended to the WAL file as a data frame at `wal_end`.
2. `wal_end` is advanced by one frame size.
3. The in-memory index is updated: `index[page_id] = frame_offset`. If the same page was written before, its index entry is overwritten — only the latest frame matters.

Nothing is written to the main `.nxr` file. The write is durable only in the WAL sidecar.

---

## Reading a Page

`WALPageStore::read_page(page_id)` checks the in-memory index first:

- If the page is in the index — read the frame from the WAL file at the stored offset and return its `page` bytes.
- If not — fall through to the inner `PageStore` (the main `.nxr` file).

This means the WAL acts as a read-through cache over the main file. A page that has been modified since the last checkpoint always comes from the WAL; older, unmodified pages come from the main file.

---

## Committing

`commit()` marks a transaction boundary:

```rust
pub fn commit(&mut self) -> Result<(), NexoraStorageError> {
    self.wal_file.seek(SeekFrom::Start(self.wal_end))?;
    self.wal_file.write_all(WALFrame::commit().as_bytes())?;
    self.wal_end += WAL_FRAME_SIZE as u64;
    self.wal_file.sync_all()?;
    Ok(())
}
```

A commit frame is appended to the WAL. `sync_all()` then flushes the WAL file to disk — this is the guarantee. Once `sync_all()` returns, all data frames preceding this commit are durable on disk. A crash after this point can recover them.

---

## Recovery

When `WALPageStore::open` is called on a database that has an existing WAL sidecar, `recover()` scans it from beginning to end:

```
for each frame in the WAL file:
    if Data:    add (page_id, offset) to pending list
    if Commit:  move pending list → committed list
                (latest offset wins per page_id)

return committed list
```

Only frames that were followed by a commit frame are included in the recovered index. Data frames that appear after the last commit — written during a session that crashed before committing — are silently discarded. This is the correct behaviour: uncommitted writes were never acknowledged as durable, so they must not be applied.

```
WAL after crash (no commit):
  [data: page 3] [data: page 7]   ← no commit frame follows
  Recovery result: empty index — both writes discarded.

WAL after crash (with commit):
  [data: page 3] [data: page 7] [commit] [data: page 5]
  Recovery result: page 3 and page 7 recovered — page 5 discarded.
```

---

## Checkpoint

A checkpoint copies every page in the index from the WAL file back to the main `.nxr` file, then truncates the sidecar:

```rust
pub fn checkpoint(&mut self) -> Result<(), NexoraStorageError> {
    for i in 0..self.index_len {
        let (page_id, offset) = self.index[i];
        // Read frame from WAL at stored offset.
        // Write page bytes to main file.
        self.inner.write_page(PageId(page_id), &frame.page, false)?;
    }
    self.inner.sync()?;

    // Truncate WAL back to just the header.
    self.wal_file.set_len(WAL_HEADER_SIZE as u64)?;
    self.wal_end = WAL_HEADER_SIZE as u64;
    self.index_len = 0;
    Ok(())
}
```

After a checkpoint, the main file is fully up to date, the WAL is empty (header only), and the in-memory index is cleared.

`close()` calls `checkpoint()` automatically, so a clean close always leaves the main file consistent and the WAL empty.

---

## The In-Memory Index

The WAL maintains an in-memory index — an array of `(page_id, wal_offset)` pairs — with a fixed capacity of **4096 entries**. This is the structure that makes WAL reads fast: rather than scanning the WAL file on every `read_page`, the index gives the offset of the latest frame for any page via a linear scan over the array. The lookup is O(n) over up to 4096 entries, not O(1) — the same deliberate tradeoff as the buffer store's `page_ids` scan. A hash map would give O(1) at the cost of heap allocation, which the storage layer avoids. At 4096 entries the linear scan is fast enough that it is not a bottleneck in practice.

If the index fills up, `write_page` returns a `WalIndexFull` error. There is no automatic checkpoint — the error propagates to the caller as a hard failure. Currently, `GraphStore` does not expose a `checkpoint()` method, so a write-heavy workload that modifies more than 4096 distinct pages in a single session would surface this error without a recovery path at the GraphStore level. This is a known limitation; automatic mid-session checkpointing is not yet implemented.

---

## A Note on Crash Safety

The WAL provides crash safety only for writes that have been committed. `commit()` is the demarcation — it appends the commit frame and calls `sync_all()`. Writes before a `commit()` survive a crash; writes after the last `commit()` but before the next one do not.

Currently, `GraphStore` does not expose `commit()` as part of its public API. In WAL mode, writes accumulate in the WAL and are checkpointed on `close()`. If the process crashes, uncommitted WAL frames are discarded on the next open and the main file reflects the last successful checkpoint. Explicit transaction control — calling `commit()` to make individual operations crash-safe — is planned but not yet wired up at the GraphStore level.

---

## Where the WAL Fits

The WAL is the innermost layer of the storage stack, sitting directly above the disk:

```
GraphStore
    └── StorageManager
            └── BufferStore<WALPageStore<RegularPageStore>>
                    └── WALPageStore<RegularPageStore>   ← intercepts all writes
                            └── RegularPageStore         ← disk
```

`BufferStore` flushes dirty frames to `WALPageStore`, which journals them to the sidecar before they ever reach `RegularPageStore`. On `close()`, `BufferStore` flushes remaining dirty frames, then `WALPageStore::close()` checkpoints everything to the main file.

---

## What's Next

The series has now covered every major layer of Nexora's storage engine — from the file format and page layout through node, edge, label, and string storage, the buffer cache, the page index, and crash recovery. The next post will look at the **Lua scripting layer** — how Nexora embeds Lua 5.4 as a REPL and script runtime, the `UserData` bridge that turns `GraphStore` methods into Lua calls, and the sandbox that keeps scripts from escaping to the OS.

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
