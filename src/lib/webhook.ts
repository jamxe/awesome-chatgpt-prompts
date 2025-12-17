import { db } from "@/lib/db";
import { WEBHOOK_PLACEHOLDERS } from "@/lib/webhook-constants";
import { WebhookEvent } from "@prisma/client";

export { WEBHOOK_PLACEHOLDERS, SLACK_PRESET_PAYLOAD } from "@/lib/webhook-constants";

interface PromptData {
  id: string;
  title: string;
  description: string | null;
  content: string;
  type: string;
  mediaUrl: string | null;
  isPrivate: boolean;
  author: {
    username: string;
    name: string | null;
    avatar: string | null;
  };
  category: {
    name: string;
    slug: string;
  } | null;
  tags: { tag: { name: string; slug: string } }[];
}

function escapeJsonString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

function replacePlaceholders(template: string, prompt: PromptData): string {
  const siteUrl = process.env.NEXT_PUBLIC_APP_URL || "https://prompts.chat";
  const promptUrl = `${siteUrl}/prompts/${prompt.id}`;
  const defaultAvatar = `${siteUrl}/default-avatar.png`;
  const chatgptUrl = `https://chat.openai.com/?prompt=${encodeURIComponent(prompt.content)}`;

  const replacements: Record<string, string> = {
    [WEBHOOK_PLACEHOLDERS.PROMPT_ID]: prompt.id,
    [WEBHOOK_PLACEHOLDERS.PROMPT_TITLE]: escapeJsonString(prompt.title),
    [WEBHOOK_PLACEHOLDERS.PROMPT_DESCRIPTION]: escapeJsonString(prompt.description || "No description"),
    [WEBHOOK_PLACEHOLDERS.PROMPT_CONTENT]: escapeJsonString(truncate(prompt.content, 2000)),
    [WEBHOOK_PLACEHOLDERS.PROMPT_TYPE]: prompt.type,
    [WEBHOOK_PLACEHOLDERS.PROMPT_URL]: promptUrl,
    [WEBHOOK_PLACEHOLDERS.PROMPT_MEDIA_URL]: prompt.mediaUrl || "",
    [WEBHOOK_PLACEHOLDERS.AUTHOR_USERNAME]: prompt.author.username,
    [WEBHOOK_PLACEHOLDERS.AUTHOR_NAME]: escapeJsonString(prompt.author.name || prompt.author.username),
    [WEBHOOK_PLACEHOLDERS.AUTHOR_AVATAR]: prompt.author.avatar || defaultAvatar,
    [WEBHOOK_PLACEHOLDERS.CATEGORY_NAME]: prompt.category?.name || "Uncategorized",
    [WEBHOOK_PLACEHOLDERS.TAGS]: prompt.tags.map((t) => t.tag.name).join(", ") || "None",
    [WEBHOOK_PLACEHOLDERS.TIMESTAMP]: new Date().toLocaleDateString("en-US", {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
    [WEBHOOK_PLACEHOLDERS.SITE_URL]: siteUrl,
    [WEBHOOK_PLACEHOLDERS.CHATGPT_URL]: chatgptUrl,
  };

  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, "\\$&"), "g"), value);
  }

  return result;
}

export async function triggerWebhooks(event: WebhookEvent, prompt: PromptData): Promise<void> {
  try {
    // Get all enabled webhooks for this event
    const webhooks = await db.webhookConfig.findMany({
      where: {
        isEnabled: true,
        events: {
          has: event,
        },
      },
    });

    if (webhooks.length === 0) {
      return;
    }

    // Send webhooks in parallel (fire and forget)
    const promises = webhooks.map(async (webhook) => {
      try {
        const payload = replacePlaceholders(webhook.payload, prompt);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(webhook.headers as Record<string, string> || {}),
        };

        const response = await fetch(webhook.url, {
          method: webhook.method,
          headers,
          body: payload,
        });

        if (!response.ok) {
          console.error(`Webhook ${webhook.name} failed:`, response.status, await response.text());
        }
      } catch (error) {
        console.error(`Webhook ${webhook.name} error:`, error);
      }
    });

    // Don't await - fire and forget
    Promise.allSettled(promises);
  } catch (error) {
    console.error("Failed to trigger webhooks:", error);
  }
}
