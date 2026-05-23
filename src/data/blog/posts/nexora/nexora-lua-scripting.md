---
title: "Building a Graph Database 9 - Lua Scripting Layer"
author: "Suhan Bangera"
pubDatetime: 2026-05-23T12:00:00Z
description: "How Nexora embeds Lua 5.4 as a scripting and REPL layer — the UserData bridge that turns GraphStore methods into Lua calls, the sandbox that keeps scripts from escaping to the OS, and the REPL's expression auto-eval trick."
featured: false
isSeries: true
series: "Nexora"
chapter: 9
tags:
  - database
  - graph-database
  - rust
  - deep-dive
  - nexora
---

In [part 8](/posts/posts/nexora/nexora-wal-store/) we covered the WAL — how Nexora intercepts every page write and recovers after a crash. This post steps outside the storage engine and looks at the optional scripting layer: **Lua 5.4**, embedded via the `mlua` crate, which gives Nexora an interactive REPL and a scriptable interface without any recompilation.

---

## Why a Scripting Layer?

Nexora is a library. The core API is Rust — you call `GraphStore::insert_node`, `get_edge`, `bfs`, and so on from Rust code. That is fine for production use, but cumbersome for exploration. Every experiment requires writing a small Rust binary, compiling it, running it, and repeating. For a database, this is a high iteration cost for what is often a simple question: *what does this graph look like? which nodes have this label? is there a path between these two nodes?*

A scripting layer solves this by wrapping the same `GraphStore` API in a language that can be evaluated interactively, without a compile step. Lua is a natural fit: it is small, embeds cleanly into Rust via `mlua`, has no significant runtime dependencies, and is expressive enough for graph queries without being a whole programming environment. The scripting layer is entirely optional — Nexora compiles fine without it, and the library carries no Lua dependency unless you ask for it.

---

## The Feature Flag

The Lua layer is gated behind a Cargo feature:

```toml
[features]
lua = ["mlua/lua54", "mlua/vendored"]
```

All Lua-specific code is wrapped in `#[cfg(feature = "lua")]`. The `mlua/vendored` flag compiles Lua 5.4 from source alongside Nexora, so there is no system Lua dependency — the interpreter travels with the binary.

To build the REPL:

```
cargo build --features lua
```

---

## Bridging Rust and Lua: `mlua::UserData`

`mlua` is a Rust crate that embeds the Lua 5.4 interpreter and provides a safe API for passing values between Rust and Lua. The central bridge mechanism is the `UserData` trait: implement it on a Rust type and instances of that type become first-class Lua objects that scripts can call methods on.

Nexora defines two user data types:

```rust
pub struct LuaGraphStore<S: PageStore>(pub Rc<RefCell<GraphStore<S>>>);
pub struct LuaCursor(pub RecordCursor);
```

`LuaGraphStore<S>` wraps the `GraphStore` in two layers:

- `RefCell<_>` — Lua method calls arrive as `&self` (shared references), but most `GraphStore` methods need `&mut self`. `RefCell` converts the shared reference into an exclusive borrow at runtime, checked by Rust's borrow rules at the call site rather than at compile time.
- `Rc<_>` — the same `GraphStore` instance is shared between the Lua `db` handle and the REPL's close-on-exit call. `Rc` provides reference-counted shared ownership without a heap allocator's overhead. `Arc` is not needed because Lua scripts run single-threaded.

`LuaCursor` wraps `RecordCursor` — the opaque iterator returned by traversal and scan methods. Cursors are passed back to Lua as user data values and handed back to `db` methods on the next call.

---

## The `db` Object

When a REPL session starts or a script is executed, the Lua environment contains a single database handle: `db`. It exposes the full `GraphStore` API as Lua methods.

### Nodes

```lua
local id = db:insert_node("Person")          -- returns node id (integer)
local n  = db:get_node(id)                   -- { id=1, label="Person" }
db:update_node(id, "Employee")
db:delete_node(id)
```

### Edges

```lua
local eid = db:insert_edge(src, dst, "KNOWS", 1.0)   -- returns edge id
local e   = db:get_edge(eid)   -- { id=1, src=1, dst=2, label="KNOWS", weight=1.0 }
db:update_edge(eid, "WORKED_WITH", 0.5)
db:delete_edge(eid)
```

### Properties

Properties are arbitrary string key-value pairs attached to nodes or edges.

```lua
db:set_node_property(id, "age", "30")
local age = db:get_node_property(id, "age")  -- "30" or nil
db:delete_node_property(id, "age")           -- returns bool

db:set_edge_property(eid, "since", "2020")
local since = db:get_edge_property(eid, "since")
db:delete_edge_property(eid, "since")
```

### Cursor Traversal

For low-level iteration, methods return a cursor object that is passed back on each step:

```lua
-- outgoing neighbours of node 1
local cur = db:outgoing_cursor(1)
while true do
    local e = db:next_outgoing(cur)
    if e == nil then break end
    print(e.dst, e.label)
end

-- scan all nodes
local cur = db:all_nodes_cursor()
while true do
    local n = db:next_node(cur)
    if n == nil then break end
    print(n.id, n.label)
end
```

`db:incoming_cursor` / `db:next_incoming`, `db:all_edges_cursor` / `db:next_edge`, `db:node_properties_cursor` / `db:next_property`, and `db:edge_properties_cursor` / `db:next_property` follow the same pattern.

---

## High-Level Traversal

For common patterns, Nexora provides higher-level methods that accept a Lua callback. The callback receives the current record; returning `false` stops the traversal early.

```lua
-- visit every outgoing edge of node 1
db:for_each_outgoing(1, function(e)
    print(e.dst, e.label)
end)

-- stop as soon as we find a heavy edge
db:for_each_outgoing(1, function(e)
    if e.weight > 10 then return false end
    print(e.label)
end)

-- all nodes with a given label
db:for_each_with_label("Person", function(n)
    print(n.id)
end)
```

### BFS and DFS

Both accept a `max_depth` limit and a callback. The callback receives the node and its depth from the start node.

```lua
-- breadth-first from node 1, up to depth 3
db:bfs(1, 3, function(node, depth)
    print(string.rep("  ", depth) .. node.label)
end)

-- depth-first, stop at first match
db:dfs(1, 10, function(node, depth)
    if node.label == "Target" then
        print("found at depth", depth)
        return false
    end
end)
```

Internally, `bfs` uses a `HashSet` (for visited tracking) and a `VecDeque` (as the frontier queue). `dfs` uses a `HashSet` and a `Vec` as a stack; neighbours are pushed in reverse order so they are visited in the same order as the adjacency list. Both implementations live entirely in Rust — Lua only sees the callback interface.

### Reachability and Shortest Path

```lua
local reachable = db:has_path(1, 5)           -- bool
local path      = db:shortest_path(1, 5)      -- {1, 3, 5} (node ids) or nil
```

`shortest_path` returns a Lua array (1-indexed table) of node IDs, or `nil` if no path exists. These delegate to Nexora's `Traversal` API — the same BFS-based implementation used internally.

---

## The Sandbox

Scripts run inside a **sandboxed Lua environment**. The sandbox is a plain Lua table that is set as the `_ENV` for all loaded chunks. Only explicitly whitelisted globals are visible inside it:

```
math, string, table                    ← standard library subsets
ipairs, pairs, next, select, type
tostring, tonumber, pcall, xpcall
error, assert, print
setmetatable, getmetatable
rawget, rawset, rawequal, rawlen
_VERSION
db                                     ← the database handle
```

Everything else — `os`, `io`, `require`, `load`, `dofile`, `loadfile`, `package` — is absent. A script cannot open files, make system calls, load additional modules, or access the real global environment. The sandbox prevents accidental or deliberate escape to OS-level resources while still providing enough of Lua's standard library to write non-trivial queries.

The sandbox is constructed the same way for both interactive and non-interactive modes, so scripts behave identically whether run in the REPL or via `nexora exec`.

---

## The REPL

`nexora [PATH]` opens an interactive session. The REPL is built on <a href="https://github.com/kkawakam/rustyline" target="_blank">rustyline</a>, which provides readline-style editing and history.

```
nexora> db:insert_node("Alice")
1
nexora> db:insert_node("Bob")
2
nexora> db:insert_edge(1, 2, "KNOWS", 1.0)
1
nexora> db:get_node(1)
{ id: 1, label: "Alice" }
```

### Expression Auto-Evaluation

The REPL wraps each input in `return <expr>` and tries to evaluate it first. If that succeeds, the return values are printed. If it fails (because the input is a statement, not an expression), the original code is executed as a statement. This means bare expressions print automatically without needing `print()`:

```
nexora> 1 + 1
2
nexora> db:get_node(1)
{ id: 1, label: "Alice" }
nexora> db:insert_node("Charlie")   -- returns the new id, prints it
3
```

A statement like `for i=1,3 do print(i) end` fails the `return <expr>` attempt and is executed directly.

### Multi-Line Input

If code is syntactically incomplete (an open `do`, `then`, `function`, etc.), the REPL detects the `incomplete_input` error from `mlua` and switches to a continuation prompt:

```
nexora> for i = 1, 3 do
  ...  >     print(i)
  ...  > end
1
2
3
```

The partial input accumulates in a buffer until it is either complete or generates a real error.

### The `local` Stripping Quirk

At the REPL, declaring a variable with `local` scopes it to that chunk and makes it invisible on the next line. Typing `local x = 1` and then `x` on the next line returns `nil` — `x` is gone.

Nexora works around this for single-line inputs: if the input is exactly one line starting with `local`, the `local` keyword is stripped before execution. The assignment happens in the sandbox's global scope instead, and the variable persists across prompts. This only applies to single-line inputs; multi-line locals are left untouched.

---

## Script and Eval Modes

For non-interactive use there are two subcommands:

**`nexora exec DB SCRIPT`** — run a Lua script file:

```
nexora exec graph.nxr seed.lua
```

**`nexora eval DB SCRIPT`** — evaluate an inline Lua string:

```
nexora eval graph.nxr 'print(db:get_node(1).label)'
```

Both run inside the same sandbox as the REPL. Output comes from explicit `print()` calls only — there is no expression auto-printing in non-interactive mode. After the script finishes, `GraphStore::close()` is called, which checkpoints the WAL and flushes the buffer store to disk.

---

## CLI Flags

All modes accept flags that control the underlying storage layer:

| Flag | Effect |
|------|--------|
| *(default)* | WAL mode — crash-safe, sidecar file at `DB-wal` |
| `--no-wal` | Direct writes to the main file — faster, no crash safety |
| `--mmap` | Memory-mapped I/O — faster reads on large graphs, no WAL |
| `--new` | Force-create; fails if the file already exists |

```
nexora --no-wal graph.nxr            # REPL, no WAL
nexora exec --mmap graph.nxr q.lua   # script, mmap store
nexora eval --new fresh.nxr 'db:insert_node("root")'
```

`--mmap` selects a third `PageStore` variant backed by memory-mapped I/O rather than explicit `read()`/`write()` syscalls. The OS maps the database file directly into the process address space; page accesses become memory reads and the kernel handles I/O. It is not covered in this series, but from the Lua layer's perspective the interface is identical — `db` works the same regardless of which store is underneath.

The storage mode is selected once at open time and applies to the entire session. Switching modes requires opening the database differently; the file format is the same regardless.

---

## Where the Lua Layer Fits

The Lua layer sits entirely above the `GraphStore` API. It does not interact with the storage engine directly — it calls the same public methods that any Rust caller would use. The stack, top to bottom:

```
Lua script / REPL
    └── LuaGraphStore<S>   (UserData bridge — method dispatch)
            └── GraphStore<S>
                    └── StorageManager
                            └── BufferStore<WALPageStore<RegularPageStore>>
```

From the storage engine's perspective, a Lua session is indistinguishable from any other Rust caller. The WAL journals every write, the buffer store caches pages, and `close()` checkpoints and flushes exactly as it would in a non-scripted context.

---

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*
