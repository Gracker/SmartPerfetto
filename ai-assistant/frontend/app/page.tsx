// SPDX-License-Identifier: AGPL-3.0-or-later

"use client";

import type { FormEvent, KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";
const STORAGE_KEY = "ai-assistant.conversations";

type ChatRole = "user" | "assistant";

type Message = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
};

type ApiChatResponse = {
  conversation_id: string;
  message: {
    id: string;
    role: "assistant";
    content: string;
  };
  model: string;
};

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  const randomId =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2);

  return `${prefix}_${randomId.replaceAll("-", "")}`;
}

function createConversation(): Conversation {
  const createdAt = nowIso();

  return {
    id: createId("conv"),
    title: "New conversation",
    messages: [],
    updatedAt: createdAt,
  };
}

function titleFromMessage(content: string) {
  const trimmed = content.trim().replace(/\s+/g, " ");

  if (!trimmed) {
    return "New conversation";
  }

  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}...` : trimmed;
}

function formatConversationTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

async function parseError(response: Response) {
  try {
    const body = (await response.json()) as { detail?: unknown };
    if (typeof body.detail === "string") {
      return body.detail;
    }
  } catch {
    // Use the status text when the API does not return JSON.
  }

  return response.statusText || "Request failed";
}

export default function Home() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const activeConversation = useMemo(
    () =>
      conversations.find(
        (conversation) => conversation.id === activeConversationId,
      ) ?? conversations[0],
    [activeConversationId, conversations],
  );

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);

    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Conversation[];

        if (Array.isArray(parsed) && parsed.length > 0) {
          setConversations(parsed);
          setActiveConversationId(parsed[0].id);
          setHydrated(true);
          return;
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    const firstConversation = createConversation();
    setConversations([firstConversation]);
    setActiveConversationId(firstConversation.id);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
    }
  }, [conversations, hydrated]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages.length, isSending]);

  function startConversation() {
    const conversation = createConversation();

    setConversations((current) => [conversation, ...current]);
    setActiveConversationId(conversation.id);
    setError(null);
    setSidebarOpen(false);
  }

  function selectConversation(conversationId: string) {
    setActiveConversationId(conversationId);
    setError(null);
    setSidebarOpen(false);
  }

  function updateConversation(
    conversationId: string,
    updater: (conversation: Conversation) => Conversation,
  ) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? updater(conversation) : conversation,
      ),
    );
  }

  async function sendMessage(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    const content = input.trim();
    if (!content || !activeConversation || isSending) {
      return;
    }

    const sentAt = nowIso();
    const userMessage: Message = {
      id: createId("msg"),
      role: "user",
      content,
      createdAt: sentAt,
    };
    const messagesForApi = [...activeConversation.messages, userMessage];

    setInput("");
    setError(null);
    setIsSending(true);
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      title:
        conversation.messages.length === 0
          ? titleFromMessage(content)
          : conversation.title,
      messages: [...conversation.messages, userMessage],
      updatedAt: sentAt,
    }));

    try {
      const response = await fetch(`${API_BASE_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          conversation_id: activeConversation.id,
          messages: messagesForApi.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });

      if (!response.ok) {
        throw new Error(await parseError(response));
      }

      const data = (await response.json()) as ApiChatResponse;
      const assistantMessage: Message = {
        id: data.message.id,
        role: "assistant",
        content: data.message.content,
        createdAt: nowIso(),
      };

      updateConversation(activeConversation.id, (conversation) => ({
        ...conversation,
        messages: [...conversation.messages, assistantMessage],
        updatedAt: assistantMessage.createdAt,
      }));
    } catch (unknownError) {
      const message =
        unknownError instanceof Error
          ? unknownError.message
          : "Unable to reach the assistant backend.";
      setError(message);
    } finally {
      setIsSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const hasMessages = (activeConversation?.messages.length ?? 0) > 0;

  return (
    <main className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <div>
            <p className="eyebrow">AI Assistant</p>
            <h1>Chats</h1>
          </div>
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}>
            Close
          </button>
        </div>

        <button className="new-chat-button" onClick={startConversation}>
          + New chat
        </button>

        <nav className="conversation-list" aria-label="Conversation history">
          {conversations.map((conversation) => (
            <button
              className={`conversation-item ${
                conversation.id === activeConversation?.id ? "active" : ""
              }`}
              key={conversation.id}
              onClick={() => selectConversation(conversation.id)}
            >
              <span>{conversation.title}</span>
              <small>{formatConversationTime(conversation.updatedAt)}</small>
            </button>
          ))}
        </nav>
      </aside>

      {sidebarOpen ? (
        <button
          aria-label="Close conversation sidebar"
          className="scrim"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      <section className="chat-panel">
        <header className="chat-header">
          <button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}>
            Menu
          </button>
          <div>
            <p className="eyebrow">OpenAI powered</p>
            <h2>{activeConversation?.title ?? "New conversation"}</h2>
          </div>
          <div className="status-pill">FastAPI</div>
        </header>

        <div className="messages" aria-live="polite">
          {!hasMessages ? (
            <div className="empty-state">
              <div className="empty-icon">AI</div>
              <h3>Ask anything</h3>
              <p>
                Start a conversation with the assistant. Your chat history is stored
                locally in this browser.
              </p>
            </div>
          ) : null}

          {activeConversation?.messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-avatar">
                {message.role === "user" ? "You" : "AI"}
              </div>
              <div className="message-bubble">
                <p>{message.content}</p>
              </div>
            </article>
          ))}

          {isSending ? (
            <article className="message assistant">
              <div className="message-avatar">AI</div>
              <div className="message-bubble typing">
                <span />
                <span />
                <span />
              </div>
            </article>
          ) : null}

          <div ref={messagesEndRef} />
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <form className="composer" onSubmit={sendMessage}>
          <textarea
            aria-label="Message"
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Type your message..."
            rows={1}
            value={input}
          />
          <button disabled={!input.trim() || isSending} type="submit">
            {isSending ? "Sending" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
