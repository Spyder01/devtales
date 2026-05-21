---
title: "Building a Graph Database - The Why"
author: "Suhan Bangera"
pubDatetime: 2026-05-21T09:00:00Z
description: "Before diving into how Nexora works, this post covers the why and what graph databases are, where relational databases fall short, and why graphs are a natural fit for highly connected data."
featured: true
isSeries: true
series: "Nexora"
chapter: 1
tags:
- database
- graph-database
- graphs
- tech-deep-dive
- deep-dive
- nexora

---

### The Background

Before diving into how a graph database works under the hood, let me introduce you to <a href="https://github.com/spyder01/nexora" target="_blank">Nexora</a>, a single-file graph database I am building in Rust. It aims to achieve memory efficiency, crash safety, and performance when dealing with graph data.

But before we get into implementation details, it is worth asking a more fundamental question: what is a graph database, and why does it exist?

---

### The Relational Model

**Relational databases** have been one of the most important and successful inventions in computer science. Introduced by *Dr. Edgar F. Codd* in 1970, the relational model proposed storing data in tables and rows — and ever since, it has been the first choice of developers and the foundation of millions of applications throughout the world.

It works beautifully for structured data. A `users` table, an `orders` table, a `products` table — each row is an entity, each column is an attribute, and relationships are expressed through foreign keys and joins.

For most use cases, this is exactly the right tool.

---

### Where It Falls Short

But there are cases where the relational model starts to strain. Consider a classic example of a social network. You have users, and users know other users, who know other users, who know other users. To find everyone within three degrees of separation from a given user, you need a join on a join on a join, and the query becomes increasingly expensive the deeper you go.

The problem is not the database. The problem is the **mismatch between the data model and the storage model**. The data is fundamentally a graph — entities connected by relationships — but it is being forced into a flat table structure that was never designed for it.

This problem shows up across many domains:

* **Social networks** — who knows whom, who follows whom
* **Recommendation engines** — users who bought X also bought Y
* **Fraud detection** — accounts connected through shared devices, addresses, or transactions
* **Knowledge graphs** — entities and the relationships between them

In each case, the interesting queries are about **traversal** — following relationships from one entity to another. Relational databases can do this, but it is not what they were built for.

This is exactly the kind of problem graph databases were designed to solve.

---

### The Graph Model

A graph database is built around this kind of data from the ground up. Instead of tables and rows, the primitive concepts are:

* **Nodes** — entities. A person, a city, a company, a product.
* **Edges** — directed relationships between nodes. "Alice **KNOWS** Bob", "Bob **LIVES_IN** London", "London **IS_IN** England".
* **Properties** — key-value pairs attached to nodes or edges. `name: "Alice"`, `age: "30"`, `since: "2019"`.

A query like "find all friends of Alice who live in London" becomes a direct traversal operation: start at Alice's node, follow KNOWS edges, check LIVES_IN edges for London. Instead of reconstructing relationships through joins at query time, the relationships are stored explicitly.

This is not just conceptually cleaner — it is also significantly faster for connected queries.

---

### Why Build One From Scratch?

There are excellent graph databases already — Neo4j, Amazon Neptune, ArangoDB. So why build Nexora?

The honest answer: to understand how it works.

Like many developers, I had been treating databases as black boxes. Data goes in, data comes out. But the decisions made at the storage layer — how bytes are laid out on disk, how memory is managed, how crashes are handled — affect everything: performance, reliability, scalability.

Nexora is a learning project, but a serious one. It is a single-file embedded graph database, analogous to SQLite but built around a graph model. No external server, no dependencies — just a file on disk and a Rust library to read and write it, with Lua planned as the scripting and querying layer.

---

### What's Next

Now that we know *what* we are building and *why*, the next post gets into the implementation. Starting from the very bottom: how Nexora organises bytes on disk.

**Next: Building a Graph Database — The File Format**

*Nexora is open source — check it out on <a href="https://github.com/spyder01/nexora" target="_blank">GitHub</a>.*

---
