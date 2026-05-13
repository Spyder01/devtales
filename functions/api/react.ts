export async function onRequestPost(context: any) {
    const { request, env } = context;

    try {
        const ua = request.headers.get("user-agent") || "";

        if (!ua || ua.length < 10) {
            return new Response("Blocked", { status: 403 });
        }

        const body = await request.json();

        const path = body.path;
        const sessionId = body.sessionId;
        const reaction = body.reaction;

        if (!path || !sessionId || !reaction) {
            return json({ error: "Invalid payload" }, 400);
        }

        await env.DB.prepare(`
      INSERT OR IGNORE INTO reactions
      (path, session_id, reaction)
      VALUES (?, ?, ?)
    `)
            .bind(path, sessionId, reaction)
            .run();

        return json({ success: true });
    } catch (e) {
        console.error(e);
        return json({ error: "Internal error" }, 500);
    }
}

function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json" }
    });
}