import { logServerError } from "@/lib/errors";
import { appendRunErrorToProgress, executeRun } from "@/lib/orchestrator";
import type { StreamEvent } from "@/lib/types";

export const dynamic = "force-dynamic";
/** Pro (and above): raise in dashboard if needed; Hobby caps lower. */
export const maxDuration = 800;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      // Data + comment pings: some CDNs buffer SSE until a `data:` line; comments alone are not enough.
      let pingTimer: ReturnType<typeof setInterval> | undefined;
      try {
        pingTimer = setInterval(() => {
          try {
            send({ type: "keepalive" });
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            if (pingTimer) clearInterval(pingTimer);
          }
        }, 10000);
        await executeRun(id, send);
      } catch (e) {
        const parts = logServerError(`stream:${id}`, e, { runId: id });
        const entry = await appendRunErrorToProgress(id, e);
        if (entry) send({ type: "progress", entry });
        send({
          type: "error",
          message: parts.message,
          stack: parts.stack,
          errorName: parts.errorName,
        });
      } finally {
        if (pingTimer) clearInterval(pingTimer);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
