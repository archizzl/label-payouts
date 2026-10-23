"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { buttonClass } from "@/components/ui";
import { type AbelChatListItem, type AbelMessage, type AbelStreamEvent, WORKING_ON } from "@/lib/abel";
import { AbelText } from "./abel-text";
import { ConfirmCard } from "./confirm-card";

/*
 * Abel, the assistant: a button at the bottom right that opens a chat panel (the whole screen on a
 * phone). Talks to /api/abel, which streams Abel's reply back.
 */

/** Abel's photo: cropped to his head and chest, at twice the button's size for sharp screens. */
const ABEL_PHOTO = "https://res.cloudinary.com/xtdtnygr/image/upload/c_crop,w_230,h_230,x_85,y_20/f_auto,q_auto,w_112,h_112/abel";

/** Abel's photo in a circle. */
function AbelPhoto({ className }: { className: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={ABEL_PHOTO} alt="" className={`shrink-0 rounded-full bg-surface-2 object-cover ${className}`} />;
}

/** Something from Abel: his photo, then it. */
function FromAbel({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <AbelPhoto className="mt-0.5 h-6 w-6" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

type Send = { message: string } | { confirmation: { id: string; confirmed: boolean } };

export function AbelPanel() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [chats, setChats] = useState<AbelChatListItem[] | null>(null);
  const [chatId, setChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AbelMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open || chats) return;
    fetch("/api/abel")
      .then((r) => r.json())
      .then((d: { chats?: AbelChatListItem[] }) => setChats(d.chats ?? []))
      .catch(() => setChats([]));
  }, [open, chats]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages, draft, working]);
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, chatId]);

  async function openChat(id: number) {
    setError(null);
    const r = await fetch(`/api/abel?chat=${id}`);
    const d = (await r.json()) as { messages?: AbelMessage[]; error?: string };
    if (!r.ok) return setError(d.error ?? "Couldn’t open that chat.");
    setChatId(id);
    setMessages(d.messages ?? []);
  }

  function newChat() {
    setChatId(null);
    setMessages([]);
    setError(null);
    setChats(null);
  }

  async function send(what: Send) {
    setBusy(true);
    setError(null);
    setDraft("");
    // A confirmed change: the page behind is refreshed to show it.
    const changed = "confirmation" in what && what.confirmation.confirmed;
    try {
      const r = await fetch("/api/abel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chatId, ...what }),
      });
      if (!r.ok || !r.body) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error ?? "Abel couldn’t answer that just now.");
      }
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const e = JSON.parse(line.slice(6)) as AbelStreamEvent;
          if (e.type === "chat") setChatId(e.chatId);
          else if (e.type === "working") setWorking(e.tool);
          else if (e.type === "text") {
            setWorking(null);
            if (e.partial) {
              text += e.text;
              setDraft(text);
            } else {
              const whole = e.text;
              text = "";
              setDraft("");
              setMessages((m) => [...m, { kind: "abel", text: whole }]);
            }
          } else if (e.type === "confirm") setMessages((m) => [...m, { kind: "confirm", id: e.id, summary: e.summary, answer: null }]);
          else if (e.type === "error") setError(e.message);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Abel couldn’t answer that just now.");
    } finally {
      setBusy(false);
      setWorking(null);
      setDraft("");
      if (changed) router.refresh();
    }
  }

  function ask() {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setMessages((m) => [...m, { kind: "user", text: message }]);
    void send({ message });
  }

  function answer(id: string, confirmed: boolean) {
    setMessages((m) => m.map((x) => (x.kind === "confirm" && x.id === id ? { ...x, answer: confirmed ? "confirmed" : "declined" } : x)));
    void send({ confirmation: { id, confirmed } });
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open Abel"
        className="no-print fixed right-4 bottom-4 z-40 h-14 w-14 overflow-hidden rounded-full border-2 border-accent bg-surface-2 shadow-lg transition hover:scale-105"
      >
        <AbelPhoto className="h-full w-full" />
      </button>
    );
  }

  const empty = !messages.length && !draft && !busy;
  return (
    <section
      aria-label="Abel"
      className="no-print fixed inset-0 z-40 flex flex-col border-border bg-surface shadow-2xl sm:inset-auto sm:right-4 sm:bottom-4 sm:h-[min(640px,calc(100vh-2rem))] sm:w-[400px] sm:rounded-md sm:border"
    >
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <AbelPhoto className="h-7 w-7" />
        <h2 className="flex-1 font-bold">Abel</h2>
        {(chatId || messages.length > 0) && (
          <button type="button" className={buttonClass("ghost", "sm")} onClick={newChat} disabled={busy}>
            new chat
          </button>
        )}
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(false)} aria-label="Close Abel">
          close
        </button>
      </header>

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
        {empty && !chatId && (
          <>
            {chats === null ? null : chats.length === 0 ? (
              <p className="text-muted">No chats yet.</p>
            ) : (
              <ul className="space-y-1">
                {chats.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => openChat(c.id)} className="w-full truncate rounded-sm px-2 py-1.5 text-left hover:bg-surface-2">
                      {c.title || "Chat"}
                      <span className="ml-2 text-xs text-muted">{c.updatedAt.slice(0, 10)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        {messages.map((m, i) =>
          m.kind === "user" ? (
            <p key={i} className="ml-8 rounded-md bg-surface-2 px-3 py-2 whitespace-pre-wrap">
              {m.text}
            </p>
          ) : m.kind === "abel" ? (
            <FromAbel key={i}>
              <AbelText text={m.text} onNavigate={() => window.innerWidth < 640 && setOpen(false)} />
            </FromAbel>
          ) : (
            <FromAbel key={m.id}>
              <ConfirmCard summary={m.summary} answer={m.answer} disabled={busy} onAnswer={(yes) => answer(m.id, yes)} />
            </FromAbel>
          ),
        )}
        {draft && (
          <FromAbel>
            <AbelText text={draft} />
          </FromAbel>
        )}
        {busy && !draft && (
          <FromAbel>
            <p className="text-muted">{(working && WORKING_ON[working]) || "Thinking"}…</p>
          </FromAbel>
        )}
        {error && <p className="text-bad">{error}</p>}
        <div ref={end} />
      </div>

      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              ask();
            }
          }}
          rows={2}
          maxLength={4000}
          aria-label="Message Abel"
          className="min-h-0 flex-1 resize-none"
        />
        <button type="submit" className={buttonClass("primary")} disabled={busy || !input.trim()}>
          send
        </button>
      </form>
    </section>
  );
}
