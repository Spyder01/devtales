function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

export async function onRequestGet(context: any) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.searchParams.get("path");

    if (!path) {
        return json({ error: "Missing path" }, 400);
    }

    try {
        const { results } = await env.DB.prepare(`
            SELECT id, parent_id, author, body, created_at
            FROM comments
            WHERE path = ?
            ORDER BY created_at ASC
        `)
            .bind(path)
            .all();

        return json({ comments: results });
    } catch (e) {
        console.error(e);
        return json({ error: "Internal error" }, 500);
    }
}

export async function onRequestPost(context: any) {
    const { request, env } = context;

    try {
        const ua = request.headers.get("user-agent") || "";
        if (!ua || ua.length < 10) {
            return new Response("Blocked", { status: 403 });
        }

        const body = await request.json();
        const { path, author, body: text, parent_id } = body;

        if (!path || !author?.trim() || !text?.trim()) {
            return json({ error: "Missing required fields" }, 400);
        }

        if (author.length > 100 || text.length > 2000) {
            return json({ error: "Content too long" }, 400);
        }

        const token = crypto.randomUUID();

        const result = await env.DB.prepare(`
            INSERT INTO comments (path, parent_id, author, body, delete_token)
            VALUES (?, ?, ?, ?, ?)
        `)
            .bind(path, parent_id ?? null, author.trim(), text.trim(), token)
            .run();

        return json({ success: true, id: result.meta.last_row_id, token });
    } catch (e) {
        console.error(e);
        return json({ error: "Internal error" }, 500);
    }
}

export async function onRequestDelete(context: any) {
    const { request, env } = context;
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const token = url.searchParams.get("token");

    if (!id || !token) {
        return json({ error: "Missing id or token" }, 400);
    }

    try {
        const row = await env.DB.prepare(`
            SELECT delete_token FROM comments WHERE id = ?
        `)
            .bind(id)
            .first();

        if (!row) {
            return json({ error: "Comment not found" }, 404);
        }

        if (row.delete_token !== token) {
            return json({ error: "Invalid token" }, 403);
        }

        // Delete replies before the parent to avoid FK constraint violation
        await env.DB.prepare(`DELETE FROM comments WHERE parent_id = ?`)
            .bind(id)
            .run();

        await env.DB.prepare(`DELETE FROM comments WHERE id = ?`)
            .bind(id)
            .run();

        return json({ success: true });
    } catch (e) {
        console.error(e);
        return json({ error: "Internal error" }, 500);
    }
}
