import { z } from 'zod';
import {
  FocusSchema,
  MessageKindSchema,
  SessionNameSchema,
  SessionStatusSchema,
  UlidSchema,
  MAX_ATTACHMENTS,
  sanitizeText,
  type PeerInfo,
} from '@orchvis/protocol';

/** One tool's MCP listing. */
export interface ToolListing {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool result. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * A tool failure with a stable code at the start of the result text, such as
 * `broker_unreachable`, `rejected`, `too_large` or `invalid_arguments`.
 */
export class ToolError extends Error {
  /** Stable code, first word of the result. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
  }
}

/** Arguments of `register`. */
export const RegisterArgs = z.object({
  name: SessionNameSchema.describe('Short stable name, e.g. ORCH-UI. Letters, digits, . _ @ - only.'),
  focus: FocusSchema.describe('One line describing what this session works on.'),
  repos: z
    .array(z.string().min(1).max(1024))
    .max(31)
    .optional()
    .describe('Extra repos this session works in: git remote URLs, repo keys, or local repo directories.'),
});

/** Arguments of `list_peers`. */
export const ListPeersArgs = z.object({
  repo: z.string().min(1).optional().describe('Only peers in this repo (key or name, case-insensitive).'),
});

/** Arguments of `send_message`. */
export const SendMessageArgs = z.object({
  to: z.string().min(1).max(256).describe('Peer name, peer session ID, or "owner".'),
  body: z.string().describe('Self-contained message text: repo, branch, file paths, exact error text.'),
  kind: MessageKindSchema.optional().describe('chat (default), request, response, or notice.'),
  reply_to: UlidSchema.optional().describe('msg_id of the message this answers.'),
  attachments: z
    .array(
      z.object({
        path: z.string().min(1).describe('Local file path.'),
        caption: z.string().min(1).describe('Required. Fully describes what the media shows or says.'),
      }),
    )
    .max(MAX_ATTACHMENTS)
    .optional()
    .describe('Files to attach, each with a required caption.'),
});

/** Arguments of `check_inbox`. */
export const CheckInboxArgs = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Maximum messages to return (default all).'),
});

/** Arguments of `get_thread`. */
export const GetThreadArgs = z.object({
  peer: z.string().min(1).max(256).describe('Peer name, peer session ID, or "owner".'),
  limit: z.number().int().min(1).max(500).optional().describe('Most recent messages to return (default 50).'),
});

/** Arguments of `fetch_media`. */
export const FetchMediaArgs = z.object({
  media_id: z.string().min(1).max(64).describe('A media_id from a received message.'),
});

/** Arguments of `set_status`. */
export const SetStatusArgs = z.object({
  status: SessionStatusSchema.describe('idle, working, or blocked.'),
  focus: FocusSchema.optional().describe('New one-line focus.'),
});

/** Arguments of `confirm_channel`. */
export const ConfirmChannelArgs = z.object({
  nonce: z.string().min(1).max(128).describe('The nonce from the probe event.'),
});

/** What the tools need from the running shim. Implemented in `app.ts`. */
export interface ShimApi {
  /** Unread message count, for the `Unread: N` suffix. */
  unreadCount(): number;
  register(args: z.infer<typeof RegisterArgs>): Promise<string>;
  listPeers(args: z.infer<typeof ListPeersArgs>): Promise<string>;
  sendMessage(args: z.infer<typeof SendMessageArgs>): Promise<string>;
  checkInbox(args: z.infer<typeof CheckInboxArgs>): Promise<string>;
  getThread(args: z.infer<typeof GetThreadArgs>): Promise<string>;
  fetchMedia(args: z.infer<typeof FetchMediaArgs>): Promise<string>;
  setStatus(args: z.infer<typeof SetStatusArgs>): Promise<string>;
  confirmChannel(args: z.infer<typeof ConfirmChannelArgs>): Promise<string>;
}

type ToolSpec = {
  description: string;
  args: z.ZodType;
  run: (api: ShimApi, args: never) => Promise<string>;
};

const TOOLS: Record<string, ToolSpec> = {
  register: {
    description:
      'Join the Orchestration Visualizer under a short stable name with a one-line focus. Call once at session start; calling again changes name or focus and re-runs the delivery probe. Returns the assigned name, the peer list, and the delivery mode.',
    args: RegisterArgs,
    run: (api, a: z.infer<typeof RegisterArgs>) => api.register(a),
  },
  list_peers: {
    description: "List other sessions on the visualizer: each peer's name, focus, repos, host, status and delivery mode.",
    args: ListPeersArgs,
    run: (api, a: z.infer<typeof ListPeersArgs>) => api.listPeers(a),
  },
  send_message: {
    description:
      'Send a message to a peer session (by name or ID) or to the Owner ("owner"). Attach files with a required caption each. Returns the message ID, or a rejection code with a plain explanation. Sends are never queued: if the broker is unreachable the call fails.',
    args: SendMessageArgs,
    run: (api, a: z.infer<typeof SendMessageArgs>) => api.sendMessage(a),
  },
  check_inbox: {
    description: 'Return unread messages, oldest first, and mark them seen. Poll-mode sessions call this at the start of each task, after each major step, and before ending a turn.',
    args: CheckInboxArgs,
    run: (api, a: z.infer<typeof CheckInboxArgs>) => api.checkInbox(a),
  },
  get_thread: {
    description: "Recent history with one peer (or the Owner) from the broker's buffer, oldest first.",
    args: GetThreadArgs,
    run: (api, a: z.infer<typeof GetThreadArgs>) => api.getThread(a),
  },
  fetch_media: {
    description:
      'Download an attachment by media_id to a local temp file, verify it, and return its path (forward slashes), MIME type and caption. Open images with the Read tool.',
    args: FetchMediaArgs,
    run: (api, a: z.infer<typeof FetchMediaArgs>) => api.fetchMedia(a),
  },
  set_status: {
    description: 'Report this session as idle, working, or blocked, optionally with a new one-line focus.',
    args: SetStatusArgs,
    run: (api, a: z.infer<typeof SetStatusArgs>) => api.setStatus(a),
  },
  confirm_channel: {
    description: 'Answer an orchvis delivery probe with its nonce. Switches this session to push delivery.',
    args: ConfirmChannelArgs,
    run: (api, a: z.infer<typeof ConfirmChannelArgs>) => api.confirmChannel(a),
  },
};

/** Tool names, in listing order. */
export const TOOL_NAMES = Object.keys(TOOLS);

/** JSON Schema for a zod schema, as MCP `inputSchema`. */
function inputSchemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json['$schema'];
  return json;
}

/** The `tools/list` answer. */
export function listTools(): ToolListing[] {
  return Object.entries(TOOLS).map(([name, spec]) => ({
    name,
    description: spec.description,
    inputSchema: inputSchemaOf(spec.args),
  }));
}

/** Appends `Unread: N` when N is above zero. */
export function withUnread(text: string, unread: number): string {
  return unread > 0 ? `${text}\n\nUnread: ${unread}` : text;
}

/**
 * Runs one tool call. Validates arguments, maps {@link ToolError} and other
 * failures to error results, and ends every result with `Unread: N` when there
 * are unread messages.
 */
export async function callTool(api: ShimApi, name: string, rawArgs: unknown): Promise<ToolResult> {
  const spec = TOOLS[name];
  const finish = (text: string, isError: boolean): ToolResult => {
    const result: ToolResult = { content: [{ type: 'text', text: withUnread(text, api.unreadCount()) }] };
    if (isError) result.isError = true;
    return result;
  };
  if (!spec) return finish(`unknown_tool: ${sanitizeText(name)}`, true);
  const parsed = spec.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`);
    return finish(`invalid_arguments: ${issues.join('; ')}`, true);
  }
  try {
    return finish(await spec.run(api, parsed.data as never), false);
  } catch (err) {
    if (err instanceof ToolError) return finish(`${err.code}: ${err.message}`, true);
    return finish(`error: ${(err as Error).message}`, true);
  }
}

/** A peer as tools report it. */
export function peerView(peer: PeerInfo): Record<string, unknown> {
  return {
    name: peer.name,
    id: peer.id,
    focus: sanitizeText(peer.focus),
    repos: peer.repos.map((r) => (r.branch ? `${r.key} (${r.branch})` : r.key)),
    host: peer.hostname,
    platform: peer.platform,
    status: peer.status,
    delivery: peer.delivery,
    connected: peer.connected,
  };
}

/** Whether a peer is in a repo, matched by key or name, case-insensitively. */
export function peerInRepo(peer: PeerInfo, repo: string): boolean {
  const needle = repo.trim().toLowerCase();
  return peer.repos.some((r) => r.key.toLowerCase() === needle || r.name.toLowerCase() === needle);
}
