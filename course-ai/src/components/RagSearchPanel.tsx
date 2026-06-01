import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { formatMs } from "@/lib/time";
import { usePlayer } from "@/stores/player";
import type { RagAnswer } from "@/lib/types";

export function RagSearchPanel({ videoId }: { videoId: string }) {
  const requestSeek = usePlayer((s) => s.requestSeek);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const build = useMutation({
    mutationFn: () => ipc.ai.buildEmbeddings(videoId),
  });
  const ask = useMutation<RagAnswer, unknown, string>({
    mutationFn: (q: string) => ipc.ai.ragQuery(videoId, q),
    onSuccess: () => setOpen(true),
  });

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <input
          className="w-48 rounded bg-zinc-800 px-2 py-1 text-xs"
          placeholder="问这段视频…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && query.trim()) ask.mutate(query.trim());
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={build.isPending}
          onClick={() => build.mutate()}
          title="对字幕建立向量索引（首次问答前需要）"
        >
          {build.isPending
            ? "索引中…"
            : build.isSuccess
              ? `已索引 ${build.data}`
              : "建立索引"}
        </Button>
      </div>

      {build.isError && (
        <p className="absolute right-0 top-9 z-20 w-72 rounded bg-zinc-900 p-2 text-xs text-red-400 shadow-lg">
          {String(build.error)}
        </p>
      )}

      {open && (
        <div className="absolute right-0 top-9 z-20 max-h-[60vh] w-96 overflow-y-auto rounded border border-white/10 bg-zinc-900 p-3 text-sm shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-white/40">回答</span>
            <button
              className="text-xs text-white/40 hover:text-white"
              onClick={() => setOpen(false)}
            >
              关闭
            </button>
          </div>
          {ask.isPending && <p className="text-white/50">思考中…</p>}
          {ask.isError && (
            <p className="text-red-400">{String(ask.error)}</p>
          )}
          {ask.data && (
            <>
              <p className="whitespace-pre-wrap leading-relaxed">
                {ask.data.answer}
              </p>
              {ask.data.citations.length > 0 && (
                <div className="mt-3 space-y-1 border-t border-white/10 pt-2">
                  {ask.data.citations.map((c) => (
                    <button
                      key={c.index}
                      onClick={() => requestSeek(c.start_ms)}
                      className="block w-full rounded px-1 py-0.5 text-left text-xs hover:bg-white/5"
                    >
                      <span className="mr-1 text-primary">
                        [ref:{c.index}] {formatMs(c.start_ms)}
                      </span>
                      <span className="text-white/50">
                        {c.text.slice(0, 40)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
