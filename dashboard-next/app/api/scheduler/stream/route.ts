import { sseClients, logBuffer } from "@/server/routers/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const encoder = new TextEncoder();
  const stream  = new ReadableStream({
    start(controller) {
      // Send buffered history on connect
      for (const line of logBuffer) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }

      const send = (json: string) => {
        try { controller.enqueue(encoder.encode(`data: ${json}\n\n`)); }
        catch { sseClients.delete(send); }
      };

      sseClients.add(send);

      // Cleanup when client disconnects handled by stream cancel
      return () => sseClients.delete(send);
    },
    cancel() {
      // Client disconnected — cleanup happens via send's try/catch above
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
