/**
 * Intent Parser
 * Parses user intent and breaks down into structured requirements.
 * Each requirement specifies: blockchain, contract address, token ID, source (media URL).
 */

import OpenAI from 'openai';
import chalk from 'chalk';
import { getConfig, getModelConfig, getFF1DeviceConfig, getFeedConfig } from '../config';
import { applyConstraints } from './utils';
import * as logger from '../logger';
import type { Requirement, PlaylistSettings } from '../types';
import type { Stream } from 'openai/streaming';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';

// Cache for AI clients
const clientCache = new Map<string, OpenAI>();

interface ConversationContext {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
}

interface IntentParserOptions {
  modelName?: string;
  conversationContext?: ConversationContext;
  /** CLI --device flag value; used as fallback when the model omits deviceName. */
  defaultDeviceName?: string;
}

interface IntentParserResult {
  approved: boolean;
  params?: Record<string, unknown>;
  needsMoreInfo: boolean;
  question?: string;
  messages?: OpenAI.Chat.ChatCompletionMessageParam[];
}

interface RequirementParams {
  requirements: Requirement[];
  playlistSettings?: Partial<PlaylistSettings>;
}

/**
 * Create AI client for intent parser
 *
 * @param {string} [modelName] - Model name
 * @returns {OpenAI} OpenAI client
 */
function createIntentParserClient(modelName?: string): OpenAI {
  const config = getConfig();
  const selectedModel = modelName || config.defaultModel;

  if (clientCache.has(selectedModel)) {
    return clientCache.get(selectedModel)!;
  }

  const modelConfig = getModelConfig(selectedModel);
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL,
    timeout: modelConfig.timeout,
    maxRetries: modelConfig.maxRetries,
  });

  clientCache.set(selectedModel, client);
  return client;
}

/**
 * Build intent parser system prompt
 *
 * @returns {string} System prompt for intent parser
 */
function buildIntentParserSystemPrompt(): string {
  const deviceConfig = getFF1DeviceConfig();
  const hasDevices = deviceConfig.devices && deviceConfig.devices.length > 0;

  let deviceInfo = '';
  if (hasDevices) {
    const deviceList = deviceConfig.devices
      .map((d, i) => `  ${i + 1}. ${d.name || d.host}`)
      .filter((line) => !line.includes('undefined'))
      .join('\n');

    if (deviceList) {
      deviceInfo = `\n\nAVAILABLE FF1 DEVICES:\n${deviceList}`;
    }
  }

  return `SYSTEM: FF1 Intent Parser

ROLE
- Turn user text into deterministic parameters for non‑AI execution. Keep public output minimal and structured.

REASONING (private scratchpad)
- Use Plan→Check→Act→Reflect for each step.
- Default to a single deterministic path.
- Only branch in two cases:
  1) Multiple plausible feed candidates after search.
  2) Verification failure requiring targeted repair.
- When branching, keep BEAM_WIDTH=2, DEPTH_LIMIT=2.
- Score candidates by: correctness, coverage, determinism, freshness, cost.
- Keep reasoning hidden; publicly print one status sentence before each tool call.

OUTPUT CONTRACT
- BUILD → call parse_requirements with { requirements: Requirement[], playlistSettings?: { title?: string | null, slug?: string | null, durationPerItem?: number, preserveOrder?: boolean, deviceName?: string, feedServer?: { baseUrl: string, apiKey?: string } } }
- SEND → call confirm_send_playlist with { filePath: string, deviceName?: string }
- PUBLISH (existing file) → call confirm_publish_playlist with { filePath: string, feedServer: { baseUrl: string, apiKey?: string } }
- QUESTION → answer briefly (no tool call)
- Use correct types; never truncate addresses/tokenIds; tokenIds are strings; quantity is a number.

REQUIREMENT TYPES (BUILD)
- build_playlist: { type, blockchain: "ethereum"|"tezos", contractAddress, tokenIds?: string[], quantity?: number, source?: string }
  • USE THIS when user mentions "contract" with a quantity: "N items from [blockchain] contract [address]"
  • tokenIds is OPTIONAL - omit it when user wants random tokens from a contract
  • Examples:
    - "tokens 1, 2, 3 from contract 0x123" → build_playlist with tokenIds: ["1", "2", "3"]
    - "100 items from ethereum contract 0xABC" → build_playlist with quantity: 100, NO tokenIds
    - "50 random tokens from tezos contract KT1..." → build_playlist with quantity: 50, NO tokenIds
- feral_file_artwork: { type, artworkId } for Feral File artwork URLs or public artwork ids.
  • USE THIS only for feralfile.com/exhibitions/artwork URLs or explicit Feral File public artwork ids
  • Do not use this for ordinary blockchain contract prompts
- query_address: { type, ownerAddress: 0x…|tz…|domain.eth|domain.tez, quantity?: number | "all" }
  • USE THIS for owner/wallet addresses WITHOUT the word "contract"
  • Patterns: "N items from [address]", "NFTs from [address]", "tokens owned by [address]"
  • Domains (.eth/.tez) are ALWAYS owner addresses
  • Example: "100 items from 0xABC" (without mentioning "contract") → query_address
  • When user says "all", "all tokens", "all NFTs" → use quantity="all" (string, not number)
- fetch_feed: { type, playlistName: string, quantity?: number (default 5) }

CRITICAL DISTINCTION:
- User says "contract" + address → build_playlist (queries tokens FROM that contract)
- User says just address (no "contract" word) → query_address (queries tokens OWNED by that address)
- User says ".eth" or ".tez" domain → ALWAYS query_address (owner domain)

DOMAIN OWNER RULES (CRITICAL)
- Interpret \`*.eth\` as an Ethereum OWNER DOMAIN → produce \`query_address\` with \`ownerAddress\` set to the domain string (e.g., \`reas.eth\`).
- Interpret \`*.tez\` as a Tezos OWNER DOMAIN → produce \`query_address\` with \`ownerAddress\` set to the domain string (e.g., \`einstein-rosen.tez\`).
- Never treat \.eth or \.tez as a contract or collection identifier.
- Never invent or request \`tokenIds\` for \.eth/\.tez domains. Use \`quantity\` only.

EXAMPLES (query_address - owner/wallet addresses)
- "Pick 3 artworks from reas.eth" → \`query_address\` { ownerAddress: "reas.eth", quantity: 3 }
- "3 from einstein-rosen.tez and play on my FF1" → \`query_address\` { ownerAddress: "einstein-rosen.tez", quantity: 3 } and set \`playlistSettings.deviceName\`
- "create a playlist of 30 items from 0xABC" → \`query_address\` { ownerAddress: "0xABC", quantity: 30 }
- "get 20 NFTs from 0x123" → \`query_address\` { ownerAddress: "0x123", quantity: 20 }
- "get all NFTs from 0xABC" → \`query_address\` { ownerAddress: "0xABC", quantity: "all" }

EXAMPLES (build_playlist - contract addresses)
- "tokens 5, 10, 15 from contract 0xABC on ethereum" → \`build_playlist\` { blockchain: "ethereum", contractAddress: "0xABC", tokenIds: ["5", "10", "15"] }
- "create a playlist of 100 items from ethereum contract 0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270" → \`build_playlist\` { blockchain: "ethereum", contractAddress: "0xa7d8d9ef8d8ce8992df33d8b8cf4aebabd5bd270", quantity: 100 }
- "100 random tokens from tezos contract KT1abc" → \`build_playlist\` { blockchain: "tezos", contractAddress: "KT1abc", quantity: 100 }
- "get 50 from contract 0xDEF" → \`build_playlist\` { blockchain: "ethereum", contractAddress: "0xDEF", quantity: 50 }

EXAMPLES (feral_file_artwork - public artwork URLs)
- "build a playlist from https://feralfile.com/exhibitions/artwork/abc123" → \`feral_file_artwork\` { artworkId: "abc123" }
- "play Feral File artwork f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf" → \`feral_file_artwork\` { artworkId: "f0240e04d64717e319584957f6a83954b029254ad1260b6320472ea8c0c5b1cf" }

EXAMPLES (fetch_feed)
- "Pick 3 artworks from Social Codes and 2 from a2p. Mix them up." → \`fetch_feed\` { playlistName: "Social Codes", quantity: 3 } + \`fetch_feed\` { playlistName: "a2p", quantity: 2 }, and set \`playlistSettings.preserveOrder\` = false

PLAYLIST SETTINGS EXTRACTION
- durationPerItem: parse phrases (e.g., "6 seconds each" → 6)
- preserveOrder: default true; synonyms ("shuffle", "randomize", "mix", "mix them up", "scramble") → false
- title/slug: optional; include only if provided by the user
- deviceName: from phrases like "send to", "display on", "play on", "push to"${hasDevices ? '\n- available devices:\n' + deviceInfo.replace('\n\nAVAILABLE FF1 DEVICES:\n', '') : ''}

GENERIC DEVICE RESOLUTION (CRITICAL)
- When the user references a generic device like "FF1", "my FF1", "my device", "my display", or similar (without a specific name), you MUST:
  1. Immediately call get_configured_devices() to retrieve the list of devices
  2. Extract the first device's name from the returned list
  3. Use that exact device name in playlistSettings.deviceName
  4. After resolving, acknowledge the resolved device name in your bullet summary (e.g., "send to device: Living Room")
- Example: "push to my FF1" → call get_configured_devices() → use devices[0].name as deviceName → show "device: Living Room" in bullets
- Do NOT ask the user which device to use when they say generic names like "FF1" or "my device"

MISSING INFO POLICY (ASK AT MOST ONE QUESTION)
- build_playlist: ask for blockchain/contract/tokenIds if unclear
- fetch_feed: ask for playlistName if unclear
- query_address: ask for owner/domain if unclear
- send: ask for device name only if user specifies a device by name and it's ambiguous; for generic references, always use get_configured_devices

ADDRESS VALIDATION (CRITICAL)
- When user enters any Ethereum (0x...) or Tezos (tz.../KT1/KT...) addresses, IMMEDIATELY call verify_addresses() BEFORE parsing requirements
- This includes: contract addresses in build_playlist, owner addresses in query_address, or any wallet/contract address mentioned
- Example: user says "get tokens from 0xABC" → first call verify_addresses(['0xABC']) → get validation result → then parse_requirements
- If verify_addresses returns valid=false, show user the error and ask them to provide the correct address
- If valid=true, the validation result shows the blockchain type (ethereum or tezos) - use this information when parsing requirements
- IMPORTANT: When user explicitly mentions blockchain (e.g., "ethereum contract" or "tezos contract"), you already know the blockchain type - DO NOT ask for it again

FREE‑FORM COLLECTION NAMES
- Treat as fetch_feed; do not guess contracts. If user says "some", default quantity = 5.

FEED NAME HEURISTICS (CRITICAL)
- If a source is named without an address or domain (no 0x… / tz… / *.eth / *.tez), interpret it as a feed playlist name and produce \`fetch_feed\` immediately.
- Prefer acting over asking: only ask when there are zero matches or multiple plausible feed candidates after search.
- Multi‑source phrasing like "X and Y" should yield multiple \`fetch_feed\` requirements, each with its own \`quantity\` when specified.
- Never convert a plain name into a contract query; keep it as \`fetch_feed\`.

SEND INTENT
- Triggers: display/push/send/cast/send to device/play on FF1
- Always call confirm_send_playlist with filePath (default "./playlist.json") and optional deviceName
- Device selection: exact match → case‑insensitive → if multiple/none → ask user to choose

PUBLISH INTENT (CRITICAL)
- Triggers: "publish", "publish to my feed", "push to feed", "send to feed", "publish to feed"
- Distinguish from FF1 device commands: "publish" = feed server, "display/send to device" = FF1 device
- TWO MODES:
  
  MODE 1: BUILD AND PUBLISH (user includes sources/requirements)
  - Example: "Get tokens from 0xabc and publish to feed"
  - When user mentions publishing WITH sources/requirements:
    1. Immediately call get_feed_servers() to retrieve available feed servers
    2. If only 1 server → use it directly in playlistSettings.feedServer
    3. If 2+ servers → ask user "Which feed server?" with numbered list (e.g., "1) https://feed.feralfile.com 2) http://localhost:8787")
    4. After selection, set playlistSettings.feedServer = { baseUrl, apiKey } from selected server
    5. Acknowledge in Settings bullets (e.g., "publish to: https://dp1-feed-operator-api-prod.autonomy-system.workers.dev/api/v1")
  - User can request both device display AND publishing (e.g., "send to FF1 and publish to feed") → set both deviceName and feedServer
  - Publishing happens automatically after playlist verification passes
  
  MODE 2: PUBLISH EXISTING FILE (user mentions "publish playlist" or "publish the playlist")
  - Triggers: "publish playlist", "publish the playlist", "publish this playlist", "publish last playlist"
  - Default file path: "./playlist.json" (unless user specifies a different path like "publish ./playlist-temp.json")
  - When user wants to publish an existing file WITHOUT specifying sources:
    1. Immediately call get_feed_servers() to retrieve available feed servers
    2. If only 1 server → use it directly
    3. If 2+ servers → ask user "Which feed server?" with numbered list
    4. After selection, call confirm_publish_playlist with { filePath: "./playlist.json" (or user-specified path), feedServer: { baseUrl, apiKey } }
  - DO NOT ask for sources/requirements in this mode—user wants to publish an already-created playlist file

COMMUNICATION STYLE
- Acknowledge briefly: "Got it." or "Understood." (one line).
- Do not repeat the user's request; do not paraphrase it.
- Bullet the extracted facts using friendly labels (no camelCase):
  • What we're building (sources/collections/addresses)
  • Settings (duration per item, keep order or shuffle, device, title/slug if provided)
- Prefer human units and plain words (e.g., "2 minutes per item", "send to device: Living Room").
- When device is resolved via get_configured_devices, ALWAYS show the resolved device name in Settings bullets (e.g., "send to device: Living Room").
- Use clear, direct language; no filler or corporate jargon; neutral, warm tone.
- Immediately call the function when ready. No extra narration.`;
}

/**
 * Intent parser function schemas
 */
const intentParserFunctionSchemas: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_configured_devices',
      description:
        'Get the list of configured FF1 devices. Call this IMMEDIATELY when the user references a generic device name like "FF1", "my FF1", "my device", "my display", or similar. Use the first device from the returned list.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_feed_servers',
      description:
        'Get the list of configured feed servers for publishing playlists. Call this IMMEDIATELY when the user mentions "publish", "push to feed", "send to feed", or "publish to my feed". Return list of available feed servers.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parse_requirements',
      description:
        'Parse validated and complete requirements. Only call this when you have all required information for each requirement, such as blockchain/contract/token IDs, Feral File artwork id, feed playlist name, or owner address.',
      parameters: {
        type: 'object',
        properties: {
          requirements: {
            type: 'array',
            description:
              'Array of parsed requirements. Each can be build_playlist (specific NFTs), feral_file_artwork (Feral File public artwork id or URL), fetch_feed (feed playlist), or query_address (all NFTs from address)',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['build_playlist', 'feral_file_artwork', 'fetch_feed', 'query_address'],
                  description:
                    'Type of requirement: build_playlist (specific NFTs), feral_file_artwork (Feral File artwork), fetch_feed (feed playlist), or query_address (all NFTs from address)',
                },
                blockchain: {
                  type: 'string',
                  description:
                    'Blockchain network (ethereum, tezos) - only for build_playlist type',
                },
                contractAddress: {
                  type: 'string',
                  description: 'NFT contract address - only for build_playlist type',
                },
                tokenIds: {
                  type: 'array',
                  description:
                    'Array of specific token IDs to fetch - only for build_playlist type. OPTIONAL: omit this field when user wants random tokens from the contract (e.g., "100 items from contract"). Only include when user specifies exact token IDs (e.g., "tokens 1, 2, 3").',
                  items: {
                    type: 'string',
                  },
                },
                artworkId: {
                  type: 'string',
                  description:
                    'Feral File public artwork id or artwork URL - only for feral_file_artwork type',
                },
                ownerAddress: {
                  type: 'string',
                  description:
                    'Owner wallet address (0x... for Ethereum, tz... for Tezos) - only for query_address type',
                },
                source: {
                  type: 'string',
                  description: 'Media URL or source identifier - optional for build_playlist type',
                },
                playlistName: {
                  type: 'string',
                  description:
                    'Playlist name in the feed (can be any playlist name) - only for fetch_feed type',
                },
                quantity: {
                  type: ['number', 'string'],
                  description:
                    'Number of items to fetch. Can be a number for specific count, or "all" to fetch all available tokens (default: 5 for fetch_feed, all for query_address unless specified)',
                },
              },
              required: ['type'],
            },
          },
          playlistSettings: {
            type: 'object',
            description: 'Playlist configuration settings',
            properties: {
              title: {
                type: 'string',
                description: 'Playlist title (null for auto-generation)',
              },
              slug: {
                type: 'string',
                description: 'Playlist slug (null for auto-generation)',
              },
              durationPerItem: {
                type: 'number',
                description: 'Duration per item in seconds (e.g., 5 for "5 seconds each")',
              },
              totalDuration: {
                type: 'number',
                description: 'Total playlist duration in seconds (optional)',
              },
              preserveOrder: {
                type: 'boolean',
                description: 'Whether to preserve source order (true) or randomize (false)',
              },
              deviceName: {
                type: 'string',
                description:
                  'Device name to display on (null for first device, omit if no display requested)',
              },
              feedServer: {
                type: 'object',
                description:
                  'Feed server for publishing playlist (omit if no publishing requested)',
                properties: {
                  baseUrl: {
                    type: 'string',
                    description: 'Feed server base URL',
                  },
                  apiKey: {
                    type: 'string',
                    description: 'Optional API key for authentication',
                  },
                },
                required: ['baseUrl'],
              },
            },
          },
        },
        required: ['requirements'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_send_playlist',
      description:
        'Confirm the playlist file path or hosted URL and device name for sending. This function is called after the user mentions "send" or similar phrases.',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to playlist file or playlist URL (default: "./playlist.json")',
          },
          deviceName: {
            type: 'string',
            description:
              'Name of the device to send to (omit or leave empty if no specific device)',
          },
        },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'confirm_publish_playlist',
      description:
        'Confirm the playlist file path and feed server for publishing. This function is called when the user wants to publish an existing playlist file (e.g., "publish playlist", "publish the playlist").',
      parameters: {
        type: 'object',
        properties: {
          filePath: {
            type: 'string',
            description: 'Path to the playlist file (default: "./playlist.json")',
          },
          feedServer: {
            type: 'object',
            description: 'Feed server configuration for publishing',
            properties: {
              baseUrl: {
                type: 'string',
                description: 'Feed server base URL',
              },
              apiKey: {
                type: 'string',
                description: 'Optional API key for authentication',
              },
            },
            required: ['baseUrl'],
          },
        },
        required: ['filePath', 'feedServer'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_addresses',
      description:
        'Verify and validate Ethereum (0x...) and Tezos (tz1/tz2/tz3/KT1) wallet addresses. Call this when you detect the user has entered addresses and need to validate them before proceeding to parse requirements. This helps catch format errors early.',
      parameters: {
        type: 'object',
        properties: {
          addresses: {
            type: 'array',
            description: 'Array of Ethereum or Tezos addresses to verify',
            items: {
              type: 'string',
            },
          },
        },
        required: ['addresses'],
      },
    },
  },
];

/**
 * Format markdown text for terminal display
 *
 * @param {string} text - Markdown text
 * @returns {string} Formatted text with styling
 */
function formatMarkdown(text: string): string {
  if (!text) {
    return '';
  }

  let formatted = text;

  // Headings: # text, ## text, ### text, etc.
  formatted = formatted.replace(/^(#{1,6})\s+(.+)$/gm, (_, hashes, content) => {
    const level = hashes.length;
    if (level === 1) {
      return chalk.bold.underline(content);
    } else if (level === 2) {
      return chalk.bold(content);
    } else {
      return chalk.bold(content);
    }
  });

  // Bold: **text** or __text__
  formatted = formatted.replace(/\*\*(.+?)\*\*/g, (_, p1) => chalk.bold(p1));
  formatted = formatted.replace(/__(.+?)__/g, (_, p1) => chalk.bold(p1));

  // Italic: *text* or _text_
  formatted = formatted.replace(/\*([^*]+)\*/g, (_, p1) => chalk.italic(p1));
  formatted = formatted.replace(/(?<!\w)_([^_]+)_(?!\w)/g, (_, p1) => chalk.italic(p1));

  // Inline code: `code` - light grey color
  formatted = formatted.replace(/`([^`]+)`/g, (_, p1) => chalk.dim(p1));

  // Links: [text](url) - show text in blue
  formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, (_, p1) => chalk.blue(p1));

  return formatted;
}

function printMarkdownContent(content: string): void {
  if (!content) {
    return;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (line.trim()) {
      logger.verbose(formatMarkdown(line));
    } else if (line === '') {
      logger.verbose();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractDomains(text: string): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(/[a-z0-9-]+\.(eth|tez)/gi);
  return matches ? matches.map((match) => match.toLowerCase()) : [];
}

function normalizeDomainInput(address: string, userDomains: string[]): string {
  if (!address || userDomains.length === 0) {
    return address;
  }

  const lower = address.toLowerCase();
  if (!lower.endsWith('.eth') && !lower.endsWith('.tez')) {
    return address;
  }

  const baseName = lower.replace(/\.(eth|tez)$/i, '');
  const match = userDomains.find((domain) => domain.replace(/\.(eth|tez)$/i, '') === baseName);
  return match || address;
}

function normalizeRequirementDomains(
  params: RequirementParams,
  userDomains: string[]
): RequirementParams {
  if (userDomains.length === 0) {
    return params;
  }

  const normalized = params.requirements.map((req) => {
    if (req.type !== 'query_address' || typeof req.ownerAddress !== 'string') {
      return req;
    }
    return {
      ...req,
      ownerAddress: normalizeDomainInput(req.ownerAddress, userDomains),
    };
  });

  return {
    ...params,
    requirements: normalized,
  };
}

function buildToolResponseMessages(
  toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[],
  responses: Record<string, unknown>
): OpenAI.Chat.ChatCompletionToolMessageParam[] {
  return toolCalls
    .filter((toolCall) => toolCall.id)
    .map((toolCall) => {
      const content =
        toolCall.id && Object.prototype.hasOwnProperty.call(responses, toolCall.id)
          ? responses[toolCall.id]
          : { error: `Unknown function: ${toolCall.function.name}` };
      return {
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(content),
      };
    });
}

async function processNonStreamingResponse(
  response: OpenAI.Chat.ChatCompletion
): Promise<{ message: OpenAI.Chat.ChatCompletionMessage }> {
  const message = response.choices[0]?.message;

  if (!message) {
    return { message: { role: 'assistant', content: null, refusal: null } };
  }

  if (message.content) {
    printMarkdownContent(message.content);
    logger.verbose();
  }

  return { message };
}

async function createChatCompletion(
  client: OpenAI,
  requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming,
  baseURL?: string,
  maxRetries = 0
): Promise<{ message: OpenAI.Chat.ChatCompletionMessage }> {
  const isGoogle = Boolean(baseURL && baseURL.includes('generativelanguage.googleapis.com'));
  const shouldStream = !isGoogle;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      if (shouldStream) {
        const stream = await client.chat.completions.create({
          ...requestParams,
          stream: true,
        });
        return await processStreamingResponse(stream);
      }

      const response = (await client.chat.completions.create({
        ...requestParams,
        stream: false,
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming)) as OpenAI.Chat.ChatCompletion;

      return await processNonStreamingResponse(response);
    } catch (error) {
      const err = error as Error & {
        status?: number;
        response?: { status?: number; headers?: Record<string, string> };
      };
      const status = err.response?.status ?? err.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfterHeader =
          err.response?.headers?.['retry-after'] || err.response?.headers?.['Retry-After'];
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : null;
        const backoffMs = Math.min(10000, 2000 * Math.pow(2, attempt));
        const delayMs = retryAfterMs && !Number.isNaN(retryAfterMs) ? retryAfterMs : backoffMs;
        await sleep(delayMs);
        continue;
      }
      throw error;
    }
  }

  throw new Error('Failed to create chat completion');
}

/**
 * Process streaming response from AI
 *
 * @param {AsyncIterator} stream - OpenAI streaming response
 * @returns {Promise<Object>} Collected message with content and tool calls
 */
async function processStreamingResponse(
  stream: Stream<ChatCompletionChunk>
): Promise<{ message: OpenAI.Chat.ChatCompletionMessage }> {
  let contentBuffer = '';
  let toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
  const toolCallsMap: Record<
    number,
    {
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }
  > = {};
  let role = 'assistant';
  let printedUpTo = 0;

  try {
    for await (const chunk of stream) {
      if (process.env.DEBUG_STREAMING) {
        console.log('\n[DEBUG] Chunk:', JSON.stringify(chunk, null, 2));
      }

      const delta = chunk.choices[0]?.delta;

      if (!delta) {
        continue;
      }

      if (delta.role) {
        role = delta.role;
      }

      // Collect content and print line by line
      if (delta.content) {
        contentBuffer += delta.content;

        const lastNewlineIndex = contentBuffer.lastIndexOf('\n', contentBuffer.length - 1);

        if (lastNewlineIndex >= printedUpTo) {
          const textToPrint = contentBuffer.substring(printedUpTo, lastNewlineIndex + 1);
          const lines = textToPrint.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const formatted = formatMarkdown(line);
              logger.verbose(formatted);
            } else if (line === '') {
              logger.verbose();
            }
          }
          printedUpTo = lastNewlineIndex + 1;
        }
      }

      // Collect tool calls
      if (delta.tool_calls) {
        for (const toolCallDelta of delta.tool_calls) {
          const index = toolCallDelta.index;

          if (!toolCallsMap[index]) {
            toolCallsMap[index] = {
              id: '',
              type: 'function',
              function: {
                name: '',
                arguments: '',
              },
            };
          }

          if (toolCallDelta.id) {
            toolCallsMap[index].id = toolCallDelta.id;
          }

          if (toolCallDelta.function) {
            if (toolCallDelta.function.name) {
              toolCallsMap[index].function.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function.arguments) {
              toolCallsMap[index].function.arguments += toolCallDelta.function.arguments;
            }
          }
        }
      }
    }
  } catch (error) {
    // Log streaming error but continue with what we have
    if (process.env.DEBUG) {
      console.error(chalk.red('\n[Streaming Error]'), (error as Error).message);
    }
  }

  // Print remaining content
  if (printedUpTo < contentBuffer.length) {
    const remainingText = contentBuffer.substring(printedUpTo);
    if (remainingText.trim()) {
      const formatted = formatMarkdown(remainingText);
      logger.verbose(formatted);
    }
  }

  if (contentBuffer.length > 0) {
    logger.verbose(); // Extra newline after AI response
  }

  // Convert toolCallsMap to array
  toolCalls = Object.values(toolCallsMap).filter(
    (tc) => tc.id
  ) as OpenAI.Chat.ChatCompletionMessageToolCall[];

  const message: OpenAI.Chat.ChatCompletionMessage = {
    role: role as 'assistant',
    content: contentBuffer.trim() || null,
    refusal: null,
  };

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  return { message };
}

/**
 * Process intent parser conversation
 *
 * @param {string} userRequest - User's natural language request
 * @param {Object} options - Options
 * @param {string} [options.modelName] - Model to use
 * @param {Object} [options.conversationContext] - Previous conversation context
 * @returns {Promise<Object>} Intent parser result
 */
export async function processIntentParserRequest(
  userRequest: string,
  options: IntentParserOptions = {}
): Promise<IntentParserResult> {
  const { modelName, conversationContext, defaultDeviceName } = options;
  const userDomains = extractDomains(userRequest);
  const client = createIntentParserClient(modelName);
  const modelConfig = getModelConfig(modelName);
  const config = getConfig();

  const systemMessage = buildIntentParserSystemPrompt();
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemMessage },
  ];

  // Add conversation context if continuing
  if (conversationContext && conversationContext.messages) {
    messages.push(...conversationContext.messages);
  }

  messages.push({ role: 'user', content: userRequest });

  try {
    const requestParams: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: modelConfig.model,
      messages,
      tools: intentParserFunctionSchemas,
      tool_choice: 'auto',
      stream: true,
    };

    // Set temperature based on model
    if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
      requestParams.temperature = modelConfig.temperature;
    } else if (modelConfig.temperature === 1) {
      requestParams.temperature = 1;
    }

    if (modelConfig.model.startsWith('gpt-')) {
      (requestParams as unknown as Record<string, unknown>).max_completion_tokens = 2000;
    } else {
      (requestParams as unknown as Record<string, unknown>).max_tokens = 2000;
    }

    const { message } = await createChatCompletion(
      client,
      requestParams,
      modelConfig.baseURL,
      modelConfig.maxRetries
    );

    // Check if AI wants to pass parsed requirements
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCall = message.tool_calls[0];
      if (toolCall.function.name === 'get_configured_devices') {
        // Get the list of configured devices
        const { getConfiguredDevices } = await import('../utilities/functions');
        const result = await getConfiguredDevices();

        const toolResultMessages = buildToolResponseMessages(message.tool_calls, {
          [toolCall.id]: result,
        });

        const updatedMessages = [...messages, message, ...toolResultMessages];

        // Continue the conversation with the device list
        const followUpRequest: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: modelConfig.model,
          messages: updatedMessages,
          tools: intentParserFunctionSchemas,
          tool_choice: 'auto',
          stream: true,
        };

        if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
          followUpRequest.temperature = modelConfig.temperature;
        } else if (modelConfig.temperature === 1) {
          followUpRequest.temperature = 1;
        }

        if (modelConfig.model.startsWith('gpt-')) {
          (followUpRequest as unknown as Record<string, unknown>).max_completion_tokens = 2000;
        } else {
          (followUpRequest as unknown as Record<string, unknown>).max_tokens = 2000;
        }

        const { message: followUpMessage } = await createChatCompletion(
          client,
          followUpRequest,
          modelConfig.baseURL,
          modelConfig.maxRetries
        );

        // Check if AI now wants to parse requirements
        if (followUpMessage.tool_calls && followUpMessage.tool_calls.length > 0) {
          const followUpToolCall = followUpMessage.tool_calls[0];
          if (followUpToolCall.function.name === 'parse_requirements') {
            const params = normalizeRequirementDomains(
              JSON.parse(followUpToolCall.function.arguments),
              userDomains
            );

            // Apply constraints and defaults
            const validatedParams = applyConstraints(params, config);

            return {
              approved: true,
              params: validatedParams as unknown as Record<string, unknown>,
              needsMoreInfo: false,
            };
          } else if (followUpToolCall.function.name === 'get_feed_servers') {
            // Get the list of configured feed servers
            const feedConfig = getFeedConfig();

            // Build the server list for the AI
            const serverList =
              feedConfig.servers?.map((server) => ({
                baseUrl: server.baseUrl,
                apiKey: server.apiKey,
              })) ||
              feedConfig.baseURLs.map((url) => ({ baseUrl: url, apiKey: feedConfig.apiKey }));

            const feedToolResultMessages = buildToolResponseMessages(followUpMessage.tool_calls, {
              [followUpToolCall.id]: { servers: serverList },
            });

            const feedUpdatedMessages = [
              ...updatedMessages,
              followUpMessage,
              ...feedToolResultMessages,
            ];

            // Continue the conversation with the feed server list
            const feedFollowUpRequest: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
              model: modelConfig.model,
              messages: feedUpdatedMessages,
              tools: intentParserFunctionSchemas,
              tool_choice: 'auto',
              stream: true,
            };

            if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
              feedFollowUpRequest.temperature = modelConfig.temperature;
            } else if (modelConfig.temperature === 1) {
              feedFollowUpRequest.temperature = 1;
            }

            if (modelConfig.model.startsWith('gpt-')) {
              (feedFollowUpRequest as unknown as Record<string, unknown>).max_completion_tokens =
                2000;
            } else {
              (feedFollowUpRequest as unknown as Record<string, unknown>).max_tokens = 2000;
            }

            const { message: feedFollowUpMessage } = await createChatCompletion(
              client,
              feedFollowUpRequest,
              modelConfig.baseURL,
              modelConfig.maxRetries
            );

            // Check if AI now wants to parse requirements or publish
            if (feedFollowUpMessage.tool_calls && feedFollowUpMessage.tool_calls.length > 0) {
              const feedToolCall = feedFollowUpMessage.tool_calls[0];
              if (feedToolCall.function.name === 'parse_requirements') {
                const params = normalizeRequirementDomains(
                  JSON.parse(feedToolCall.function.arguments),
                  userDomains
                );

                // Apply constraints and defaults
                const validatedParams = applyConstraints(params, config);

                return {
                  approved: true,
                  params: validatedParams as unknown as Record<string, unknown>,
                  needsMoreInfo: false,
                };
              } else if (feedToolCall.function.name === 'confirm_publish_playlist') {
                const args = JSON.parse(feedToolCall.function.arguments);
                const { publishPlaylist } = await import('../utilities/playlist-publisher');

                console.log();
                console.log(chalk.cyan('Publishing to feed server...'));

                const publishResult = await publishPlaylist(
                  args.filePath,
                  args.feedServer.baseUrl,
                  args.feedServer.apiKey
                );

                if (publishResult.success) {
                  console.log(chalk.green('Published to feed server'));
                  if (publishResult.playlistId) {
                    console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
                  }
                  if (publishResult.feedServer) {
                    console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
                  }
                  console.log();

                  return {
                    approved: true,
                    params: {
                      action: 'publish_playlist',
                      filePath: args.filePath,
                      feedServer: args.feedServer,
                      playlistId: publishResult.playlistId,
                      success: true,
                    } as unknown as Record<string, unknown>,
                    needsMoreInfo: false,
                  };
                } else {
                  console.error(chalk.red('Publish failed: ' + publishResult.error));
                  if (publishResult.message) {
                    console.error(chalk.dim(`   ${publishResult.message}`));
                  }
                  console.log();

                  return {
                    approved: false,
                    needsMoreInfo: false,
                    params: {
                      action: 'publish_playlist',
                      success: false,
                      error: publishResult.error,
                    } as unknown as Record<string, unknown>,
                  };
                }
              }
            }

            // AI might be asking a question or needs more info
            return {
              approved: false,
              needsMoreInfo: true,
              question: feedFollowUpMessage.content || undefined,
              messages: [...feedUpdatedMessages, feedFollowUpMessage],
            };
          } else if (followUpToolCall.function.name === 'confirm_publish_playlist') {
            // Handle publish after feed server selection
            const args = JSON.parse(followUpToolCall.function.arguments);
            const { publishPlaylist } = await import('../utilities/playlist-publisher');

            console.log();
            console.log(chalk.cyan('Publishing to feed server...'));

            const publishResult = await publishPlaylist(
              args.filePath,
              args.feedServer.baseUrl,
              args.feedServer.apiKey
            );

            if (publishResult.success) {
              console.log(chalk.green('Published to feed server'));
              if (publishResult.playlistId) {
                console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
              }
              if (publishResult.feedServer) {
                console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
              }
              console.log();

              return {
                approved: true,
                params: {
                  action: 'publish_playlist',
                  filePath: args.filePath,
                  feedServer: args.feedServer,
                  playlistId: publishResult.playlistId,
                  success: true,
                } as unknown as Record<string, unknown>,
                needsMoreInfo: false,
              };
            } else {
              console.error(chalk.red('Publish failed: ' + publishResult.error));
              if (publishResult.message) {
                console.error(chalk.dim(`   ${publishResult.message}`));
              }
              console.log();

              return {
                approved: false,
                needsMoreInfo: false,
                params: {
                  action: 'publish_playlist',
                  success: false,
                  error: publishResult.error,
                } as unknown as Record<string, unknown>,
              };
            }
          } else {
            const toolResultMessages = buildToolResponseMessages(followUpMessage.tool_calls, {});
            const validMessages = [...updatedMessages, followUpMessage, ...toolResultMessages];

            // AI is still asking for more information after the error
            return {
              approved: false,
              needsMoreInfo: true,
              question:
                followUpMessage.content ||
                `Encountered unknown function: ${followUpToolCall.function.name}`,
              messages: validMessages,
            };
          }
        }

        // AI is still asking for more information
        return {
          approved: false,
          needsMoreInfo: true,
          question: followUpMessage.content || undefined,
          messages: [...updatedMessages, followUpMessage],
        };
      } else if (toolCall.function.name === 'get_feed_servers') {
        // Get the list of configured feed servers
        const feedConfig = getFeedConfig();

        // Build the server list for the AI
        const serverList =
          feedConfig.servers?.map((server) => ({
            baseUrl: server.baseUrl,
            apiKey: server.apiKey,
          })) || feedConfig.baseURLs.map((url) => ({ baseUrl: url, apiKey: feedConfig.apiKey }));

        const toolResultMessages = buildToolResponseMessages(message.tool_calls, {
          [toolCall.id]: { servers: serverList },
        });

        const updatedMessages = [...messages, message, ...toolResultMessages];

        // Continue the conversation with the feed server list
        const followUpRequest: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: modelConfig.model,
          messages: updatedMessages,
          tools: intentParserFunctionSchemas,
          tool_choice: 'auto',
          stream: true,
        };

        if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
          followUpRequest.temperature = modelConfig.temperature;
        } else if (modelConfig.temperature === 1) {
          followUpRequest.temperature = 1;
        }

        if (modelConfig.model.startsWith('gpt-')) {
          (followUpRequest as unknown as Record<string, unknown>).max_completion_tokens = 2000;
        } else {
          (followUpRequest as unknown as Record<string, unknown>).max_tokens = 2000;
        }

        const { message: followUpMessage } = await createChatCompletion(
          client,
          followUpRequest,
          modelConfig.baseURL,
          modelConfig.maxRetries
        );

        // Check if AI now wants to parse requirements or publish
        if (followUpMessage.tool_calls && followUpMessage.tool_calls.length > 0) {
          const followUpToolCall = followUpMessage.tool_calls[0];
          if (followUpToolCall.function.name === 'parse_requirements') {
            const params = normalizeRequirementDomains(
              JSON.parse(followUpToolCall.function.arguments),
              userDomains
            );

            // Apply constraints and defaults
            const validatedParams = applyConstraints(params, config);

            return {
              approved: true,
              params: validatedParams as unknown as Record<string, unknown>,
              needsMoreInfo: false,
            };
          } else if (followUpToolCall.function.name === 'confirm_publish_playlist') {
            const args = JSON.parse(followUpToolCall.function.arguments);
            const { publishPlaylist } = await import('../utilities/playlist-publisher');

            console.log();
            console.log(chalk.cyan('Publishing to feed server...'));

            const publishResult = await publishPlaylist(
              args.filePath,
              args.feedServer.baseUrl,
              args.feedServer.apiKey
            );

            if (publishResult.success) {
              console.log(chalk.green('Published to feed server'));
              if (publishResult.playlistId) {
                console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
              }
              if (publishResult.feedServer) {
                console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
              }
              console.log();

              return {
                approved: true,
                params: {
                  action: 'publish_playlist',
                  filePath: args.filePath,
                  feedServer: args.feedServer,
                  playlistId: publishResult.playlistId,
                  success: true,
                } as unknown as Record<string, unknown>,
                needsMoreInfo: false,
              };
            } else {
              console.error(chalk.red('Publish failed: ' + publishResult.error));
              if (publishResult.message) {
                console.error(chalk.dim(`   ${publishResult.message}`));
              }
              console.log();

              return {
                approved: false,
                needsMoreInfo: false,
                params: {
                  action: 'publish_playlist',
                  success: false,
                  error: publishResult.error,
                } as unknown as Record<string, unknown>,
              };
            }
          }
        }

        // AI might be asking a question or needs more info
        return {
          approved: false,
          needsMoreInfo: true,
          question: followUpMessage.content || undefined,
          messages: [...updatedMessages, followUpMessage],
        };
      } else if (toolCall.function.name === 'parse_requirements') {
        const params = normalizeRequirementDomains(
          JSON.parse(toolCall.function.arguments),
          userDomains
        );

        // Apply constraints and defaults
        const validatedParams = applyConstraints(params, config);

        return {
          approved: true,
          params: validatedParams as unknown as Record<string, unknown>,
          needsMoreInfo: false,
        };
      } else if (toolCall.function.name === 'confirm_send_playlist') {
        const args = JSON.parse(toolCall.function.arguments);
        const { confirmPlaylistForSending } = await import('../utilities/playlist-send');

        // Validate and confirm the playlist.
        // args.deviceName may be null/undefined/"null" when the model omits it;
        // fall back to the CLI --device flag so `ff-cli chat --device kitchen` works.
        const resolvedDeviceName =
          args.deviceName && args.deviceName !== 'null' ? args.deviceName : defaultDeviceName;
        const confirmation = await confirmPlaylistForSending(args.filePath, resolvedDeviceName);

        if (!confirmation.success) {
          const toolResultMessages = buildToolResponseMessages(message.tool_calls, {
            [toolCall.id]: {
              success: false,
              error: confirmation.error,
              message: confirmation.message,
            },
          });
          const validMessages = [...messages, message, ...toolResultMessages];

          // Check if this is a device selection needed case
          if (confirmation.needsDeviceSelection) {
            // Multiple devices available - ask user to choose
            console.log();
            return {
              approved: false,
              needsMoreInfo: true,
              question: confirmation.message || 'Please choose a device',
              messages: validMessages,
            };
          }

          // File not found or playlist invalid - ask user for more info
          console.log();
          return {
            approved: false,
            needsMoreInfo: true,
            question: confirmation.message || `Failed to send playlist: ${confirmation.error}`,
            messages: validMessages,
          };
        }

        // Playlist is valid - return as approved with send_playlist action
        return {
          approved: true,
          params: {
            action: 'send_playlist',
            filePath: confirmation.filePath,
            deviceName: confirmation.deviceName,
            playlist: confirmation.playlist,
            message: confirmation.message,
          } as unknown as Record<string, unknown>,
          needsMoreInfo: false,
        };
      } else if (toolCall.function.name === 'confirm_publish_playlist') {
        const args = JSON.parse(toolCall.function.arguments);
        const { publishPlaylist } = await import('../utilities/playlist-publisher');

        // Publish the playlist
        console.log();
        console.log(chalk.cyan('Publishing to feed server...'));

        const publishResult = await publishPlaylist(
          args.filePath,
          args.feedServer.baseUrl,
          args.feedServer.apiKey
        );

        if (publishResult.success) {
          console.log(chalk.green('Published to feed server'));
          if (publishResult.playlistId) {
            console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
          }
          if (publishResult.feedServer) {
            console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
          }
          console.log();

          return {
            approved: true,
            params: {
              action: 'publish_playlist',
              filePath: args.filePath,
              feedServer: args.feedServer,
              playlistId: publishResult.playlistId,
              success: true,
            } as unknown as Record<string, unknown>,
            needsMoreInfo: false,
          };
        } else {
          console.error(chalk.red('Publish failed: ' + publishResult.error));
          if (publishResult.message) {
            console.error(chalk.dim(`   ${publishResult.message}`));
          }
          console.log();

          return {
            approved: false,
            needsMoreInfo: false,
            params: {
              action: 'publish_playlist',
              success: false,
              error: publishResult.error,
            } as unknown as Record<string, unknown>,
          };
        }
      } else if (toolCall.function.name === 'verify_addresses') {
        const args = JSON.parse(toolCall.function.arguments);
        if (Array.isArray(args.addresses) && userDomains.length > 0) {
          args.addresses = args.addresses.map((address: string) =>
            normalizeDomainInput(address, userDomains)
          );
        }
        const { verifyAddresses } = await import('../utilities/functions');

        const verificationResult = await verifyAddresses({ addresses: args.addresses });

        if (!verificationResult.valid) {
          const toolResultMessages = buildToolResponseMessages(message.tool_calls, {
            [toolCall.id]: {
              valid: false,
              errors: verificationResult.errors,
              results: verificationResult.results,
            },
          });
          const validMessages = [...messages, message, ...toolResultMessages];

          // Ask user to correct the addresses
          return {
            approved: false,
            needsMoreInfo: true,
            question: `Some addresses are invalid. ${verificationResult.errors.join(' ')} Please provide correct addresses.`,
            messages: validMessages,
          };
        }

        const toolResultMessages = buildToolResponseMessages(message.tool_calls, {
          [toolCall.id]: {
            valid: true,
            results: verificationResult.results,
          },
        });
        const validMessages = [...messages, message, ...toolResultMessages];

        // Continue conversation after validation
        const followUpRequest: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
          model: modelConfig.model,
          messages: validMessages,
          tools: intentParserFunctionSchemas,
          tool_choice: 'auto',
          stream: true,
        };

        if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
          followUpRequest.temperature = modelConfig.temperature;
        } else if (modelConfig.temperature === 1) {
          followUpRequest.temperature = 1;
        }

        if (modelConfig.model.startsWith('gpt-')) {
          (followUpRequest as unknown as Record<string, unknown>).max_completion_tokens = 2000;
        } else {
          (followUpRequest as unknown as Record<string, unknown>).max_tokens = 2000;
        }

        const { message: followUpMessage } = await createChatCompletion(
          client,
          followUpRequest,
          modelConfig.baseURL,
          modelConfig.maxRetries
        );

        // Check if AI now wants to parse requirements or get feed servers
        if (followUpMessage.tool_calls && followUpMessage.tool_calls.length > 0) {
          const followUpToolCall = followUpMessage.tool_calls[0];
          if (followUpToolCall.function.name === 'parse_requirements') {
            const params = normalizeRequirementDomains(
              JSON.parse(followUpToolCall.function.arguments),
              userDomains
            );

            // Apply constraints and defaults
            const validatedParams = applyConstraints(params, config);

            return {
              approved: true,
              params: validatedParams as unknown as Record<string, unknown>,
              needsMoreInfo: false,
            };
          } else if (followUpToolCall.function.name === 'get_feed_servers') {
            // Get the list of configured feed servers
            const feedConfig = getFeedConfig();

            // Build the server list for the AI
            const serverList =
              feedConfig.servers?.map((server) => ({
                baseUrl: server.baseUrl,
                apiKey: server.apiKey,
              })) ||
              feedConfig.baseURLs.map((url) => ({ baseUrl: url, apiKey: feedConfig.apiKey }));

            // Add tool result to messages and continue conversation
            const feedToolResultMessages = buildToolResponseMessages(followUpMessage.tool_calls, {
              [followUpToolCall.id]: { servers: serverList },
            });

            const feedUpdatedMessages = [
              ...validMessages,
              followUpMessage,
              ...feedToolResultMessages,
            ];

            // Continue the conversation with the feed server list
            const feedFollowUpRequest: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
              model: modelConfig.model,
              messages: feedUpdatedMessages,
              tools: intentParserFunctionSchemas,
              tool_choice: 'auto',
              stream: true,
            };

            if (modelConfig.temperature !== undefined && modelConfig.temperature !== 1) {
              feedFollowUpRequest.temperature = modelConfig.temperature;
            } else if (modelConfig.temperature === 1) {
              feedFollowUpRequest.temperature = 1;
            }

            if (modelConfig.model.startsWith('gpt-')) {
              (feedFollowUpRequest as unknown as Record<string, unknown>).max_completion_tokens =
                2000;
            } else {
              (feedFollowUpRequest as unknown as Record<string, unknown>).max_tokens = 2000;
            }

            const { message: feedFollowUpMessage } = await createChatCompletion(
              client,
              feedFollowUpRequest,
              modelConfig.baseURL,
              modelConfig.maxRetries
            );

            // Check if AI now wants to parse requirements or publish
            if (feedFollowUpMessage.tool_calls && feedFollowUpMessage.tool_calls.length > 0) {
              const feedToolCall = feedFollowUpMessage.tool_calls[0];
              if (feedToolCall.function.name === 'parse_requirements') {
                const params = normalizeRequirementDomains(
                  JSON.parse(feedToolCall.function.arguments),
                  userDomains
                );

                // Apply constraints and defaults
                const validatedParams = applyConstraints(params, config);

                return {
                  approved: true,
                  params: validatedParams as unknown as Record<string, unknown>,
                  needsMoreInfo: false,
                };
              } else if (feedToolCall.function.name === 'confirm_publish_playlist') {
                const args = JSON.parse(feedToolCall.function.arguments);
                const { publishPlaylist } = await import('../utilities/playlist-publisher');

                console.log();
                console.log(chalk.cyan('Publishing to feed server...'));

                const publishResult = await publishPlaylist(
                  args.filePath,
                  args.feedServer.baseUrl,
                  args.feedServer.apiKey
                );

                if (publishResult.success) {
                  console.log(chalk.green('Published to feed server'));
                  if (publishResult.playlistId) {
                    console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
                  }
                  if (publishResult.feedServer) {
                    console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
                  }
                  console.log();

                  return {
                    approved: true,
                    params: {
                      action: 'publish_playlist',
                      filePath: args.filePath,
                      feedServer: args.feedServer,
                      playlistId: publishResult.playlistId,
                      success: true,
                    } as unknown as Record<string, unknown>,
                    needsMoreInfo: false,
                  };
                } else {
                  console.error(chalk.red('Publish failed: ' + publishResult.error));
                  if (publishResult.message) {
                    console.error(chalk.dim(`   ${publishResult.message}`));
                  }
                  console.log();

                  return {
                    approved: false,
                    needsMoreInfo: false,
                    params: {
                      action: 'publish_playlist',
                      success: false,
                      error: publishResult.error,
                    } as unknown as Record<string, unknown>,
                  };
                }
              }
            }

            // AI might be asking a question or needs more info
            return {
              approved: false,
              needsMoreInfo: true,
              question: feedFollowUpMessage.content || undefined,
              messages: [...feedUpdatedMessages, feedFollowUpMessage],
            };
          }
        }

        // AI might be asking a question or needs more info
        if (followUpMessage.content) {
          return {
            approved: false,
            needsMoreInfo: true,
            question: followUpMessage.content,
            messages: [...validMessages, followUpMessage],
          };
        }

        return {
          approved: false,
          needsMoreInfo: false,
        };
      } else {
        const toolResultMessages = buildToolResponseMessages(message.tool_calls, {});
        const validMessages = [...messages, message, ...toolResultMessages];

        return {
          approved: false,
          needsMoreInfo: true,
          question: message.content || `Encountered unknown function: ${toolCall.function.name}`,
          messages: validMessages,
        };
      }
    }

    // AI is asking for more information
    return {
      approved: false,
      needsMoreInfo: true,
      question: message.content || undefined,
      messages: [...messages, message],
    };
  } catch (error) {
    const err = error as Error & {
      status?: number;
      response?: { status?: number; statusText?: string; data?: unknown };
    };
    const status = err.response?.status ?? err.status;
    const statusText = err.response?.statusText;
    const responseDetails =
      err.response?.data && typeof err.response.data === 'string'
        ? err.response.data
        : err.response?.data
          ? JSON.stringify(err.response.data)
          : null;
    const context = `model=${modelConfig.model}, baseURL=${modelConfig.baseURL}`;
    const detailParts = [
      err.message,
      status ? `status ${status}${statusText ? ` ${statusText}` : ''}` : null,
      responseDetails ? `response ${responseDetails}` : null,
    ].filter(Boolean);
    throw new Error(`Intent parser failed (${context}): ${detailParts.join(' | ')}`);
  }
}

export { buildIntentParserSystemPrompt, intentParserFunctionSchemas };
