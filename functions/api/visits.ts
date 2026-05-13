/**
 * Vicitales Visit Analytics
 * Cloudflare Pages Function
 *
 * Stores one visit per (session_id + path)
 * Updates scroll depth if reader scrolls further.
 */

export async function onRequestPost(context: any) {
    const { request, env } = context;

    try {
        const ua = request.headers.get("user-agent") || "";

        if (!ua || ua.length < 10) {
            return new Response("Blocked", { status: 403 });
        }

        // const contentType = request.headers.get("content-type");

        // if (!contentType?.includes("application/json")) {
        //     return new Response("Invalid", { status: 400 });
        // }

        const body = await request.json();

        const path: string = body.path || "/";
        const sessionId: string | null = body.sessionId || null;
        const scrollDepth: number = Number(body.scrollDepth ?? 0);

        if (!sessionId) {
            return json({ error: "Missing sessionId" }, 400);
        }

        // -----------------------------
        // Single atomic UPSERT
        // -----------------------------
        await env.DB.prepare(`
      INSERT INTO visits (path, session_id, scroll_depth)
      VALUES (?, ?, ?)
      ON CONFLICT(path, session_id)
      DO UPDATE SET
        scroll_depth = MAX(visits.scroll_depth, excluded.scroll_depth)
    `)
            .bind(path, sessionId, scrollDepth)
            .run();

        return json({ success: true });
    } catch (err) {
        console.log(err)
        return json({ error: "Internal error" }, 500);
    }
}

/**
 * Helper: JSON response
 */
function json(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}
