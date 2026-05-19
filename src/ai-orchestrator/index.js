/**
 * Orchestrator - Function Calling Declarations
 * Contains function schemas and orchestration logic for AI-driven playlist building
 */

const chalk = require('chalk');
const registry = require('./registry');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

/**
 * Return whether a playlist object carries a non-empty legacy signature or
 * at least one v1.1.0 signature envelope. Empty `signatures: []` is not
 * treated as signed.
 *
 * @param {{ signature?: unknown; signatures?: unknown }} playlist - Playlist metadata from buildDP1Playlist
 * @returns {boolean} True when a signature field is present and non-empty
 */
function playlistHasCryptographicSignature(playlist) {
  const legacy = playlist.signature;
  if (typeof legacy === 'string' && legacy.length > 0) {
    return true;
  }
  const multi = playlist.signatures;
  return Array.isArray(multi) && multi.length > 0;
}

/**
 * Infer a query_requirement tool call from plain-text assistant content.
 *
 * Some model providers occasionally return JSON arguments in message content
 * instead of emitting a formal tool call. This helper extracts JSON payloads
 * and maps recognized shapes to a synthetic tool call.
 *
 * @param {string} content - Assistant text content
 * @param {number} iterationCount - Current loop iteration number
 * @returns {Object|null} Synthetic tool call object or null when not recognized
 */
function inferToolCallFromContent(content, iterationCount) {
  if (!content || typeof content !== 'string') {
    return null;
  }

  const trimmed = content.trim();
  const candidates = [trimmed];

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch && fencedMatch[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.requirement &&
        typeof parsed.requirement === 'object' &&
        typeof parsed.duration === 'number'
      ) {
        return {
          id: `synthetic_query_requirement_${iterationCount}`,
          type: 'function',
          function: {
            name: 'query_requirement',
            arguments: JSON.stringify({
              requirement: parsed.requirement,
              duration: parsed.duration,
            }),
          },
        };
      }
    } catch (_error) {
      // Ignore parse failures and continue trying other candidates.
    }
  }

  return null;
}

async function createCompletionWithRetry(client, requestParams, maxRetries = 0) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await client.chat.completions.create(requestParams);
    } catch (error) {
      const status = error?.response?.status ?? error?.status;
      if (status === 429 && attempt < maxRetries) {
        const retryAfterHeader =
          error?.response?.headers?.['retry-after'] || error?.response?.headers?.['Retry-After'];
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
 * Function schemas for playlist building
 */
const functionSchemas = [
  {
    type: 'function',
    function: {
      name: 'query_requirement',
      description:
        'Query data for a requirement. Supports build_playlist (blockchain NFTs), feral_file_artwork (Feral File artwork IDs/URLs), query_address (all NFTs from address), and fetch_feed (feed playlists) types.',
      parameters: {
        type: 'object',
        properties: {
          requirement: {
            type: 'object',
            description:
              'The COMPLETE requirement object from params. Pass ALL fields from the original requirement without modification, truncation, or omission.',
            properties: {
              type: {
                type: 'string',
                enum: ['build_playlist', 'feral_file_artwork', 'fetch_feed', 'query_address'],
                description: 'Type of requirement',
              },
              blockchain: {
                type: 'string',
                description: 'Blockchain network (REQUIRED for build_playlist)',
              },
              contractAddress: {
                type: 'string',
                description:
                  'FULL NFT contract address without truncation (REQUIRED for build_playlist)',
              },
              tokenIds: {
                type: 'array',
                description:
                  'COMPLETE array of ALL token IDs without truncation (REQUIRED for build_playlist)',
                items: {
                  type: 'string',
                },
              },
              artworkId: {
                type: 'string',
                description:
                  'Feral File public artwork id or /exhibitions/artwork/{id} URL (REQUIRED for feral_file_artwork)',
              },
              ownerAddress: {
                type: 'string',
                description:
                  'Owner wallet address (0x... for Ethereum, tz... for Tezos) - REQUIRED for query_address',
              },
              playlistName: {
                type: 'string',
                description: 'Feed playlist name (REQUIRED for fetch_feed)',
              },
              quantity: {
                type: ['number', 'string'],
                description:
                  'Maximum number of items to fetch. Can be a number for specific count, or "all" to fetch all available tokens with pagination (optional for all types, enables random selection for query_address when numeric)',
              },
            },
            required: ['type'],
          },
          duration: {
            type: 'number',
            description: 'Display duration per item in seconds',
          },
        },
        required: ['requirement', 'duration'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_feed_playlist',
      description:
        'Search for playlists across ALL configured feeds by name. Uses fuzzy matching to automatically find and return the BEST matching playlist name.',
      parameters: {
        type: 'object',
        properties: {
          playlistName: {
            type: 'string',
            description: 'Playlist name to search for',
          },
        },
        required: ['playlistName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_feed_playlist_items',
      description:
        'Fetch items from a specific feed playlist by NAME (not ID). Pass the exact playlist name you selected. Items will be shuffled and randomly selected based on quantity.',
      parameters: {
        type: 'object',
        properties: {
          playlistName: {
            type: 'string',
            description: 'Exact playlist name (title) selected from search results',
          },
          quantity: {
            type: 'number',
            description: 'Number of random items to fetch (will be shuffled)',
          },
          duration: {
            type: 'number',
            description: 'Duration per item in seconds',
          },
        },
        required: ['playlistName', 'quantity', 'duration'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'build_playlist',
      description:
        'Build a DP1 v1.0.0 compliant playlist from collected item IDs. Pass the id field from each item returned by query_requirement.',
      parameters: {
        type: 'object',
        properties: {
          itemIds: {
            type: 'array',
            description:
              'Array of item IDs (from id field) collected from query_requirement calls. Example: ["uuid-1", "uuid-2"]',
            items: {
              type: 'string',
            },
          },
          title: {
            type: ['string', 'null'],
            description: 'Playlist title. Pass null for auto-generation.',
          },
          slug: {
            type: ['string', 'null'],
            description: 'Playlist slug. Pass null for auto-generation.',
          },
          shuffle: {
            type: 'boolean',
            description: 'Whether to shuffle items',
          },
        },
        required: ['itemIds'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_to_device',
      description:
        'Send verified playlist to an FF1 device. Pass the playlistId from build_playlist.',
      parameters: {
        type: 'object',
        properties: {
          playlistId: {
            type: 'string',
            description: 'Playlist ID from build_playlist',
          },
          deviceName: {
            type: ['string', 'null'],
            description: 'Device name (pass null for first device)',
          },
        },
        required: ['playlistId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_domains',
      description:
        'Resolve blockchain domain names to their wallet addresses. Supports ENS (.eth) and TNS (.tez) domains. Processes domains in batch for efficiency.',
      parameters: {
        type: 'object',
        properties: {
          domains: {
            type: 'array',
            description: 'Array of domain names to resolve (e.g., ["vitalik.eth", "alice.tez"])',
            items: {
              type: 'string',
            },
          },
          displayResults: {
            type: 'boolean',
            description: 'Whether to display resolution results to user (default: true)',
          },
        },
        required: ['domains'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verify_playlist',
      description:
        'Validate DP-1 playlist structure (parse only); does not verify signatures. Pass the playlistId returned from build_playlist.',
      parameters: {
        type: 'object',
        properties: {
          playlistId: {
            type: 'string',
            description: 'Playlist ID returned from build_playlist (e.g., the playlistId field)',
          },
        },
        required: ['playlistId'],
      },
    },
  },
];

// Store playlistMap across function calls
let globalPlaylistMap = {};

/**
 * Execute a function call
 *
 * @param {string} functionName - Function name
 * @param {Object} args - Function arguments
 * @returns {Promise<any>} Function result
 */
async function executeFunction(functionName, args) {
  const utilities = require('../utilities');

  switch (functionName) {
    case 'query_requirement': {
      const items = await utilities.queryRequirement(args.requirement, args.duration);

      // Store full items in registry
      items.forEach((item) => {
        if (item.id) {
          registry.storeItem(item.id, item);
        }
      });

      // Return only minimal metadata for AI context
      return items.map((item) => ({
        id: item.id,
        title: item.title,
        source: item.source?.substring(0, 50) + '...',
        duration: item.duration,
        license: item.license,
        provenance: item.provenance
          ? {
              type: item.provenance.type,
              contract: item.provenance.contract
                ? {
                    chain: item.provenance.contract.chain,
                    address: item.provenance.contract.address?.substring(0, 10) + '...',
                    tokenId: item.provenance.contract.tokenId,
                  }
                : undefined,
            }
          : undefined,
      }));
    }

    case 'search_feed_playlist': {
      const result = await utilities.feedFetcher.searchFeedPlaylists(args.playlistName);
      // Store playlistMap for later lookup
      if (result.playlistMap) {
        globalPlaylistMap = result.playlistMap;
      }
      // Return best match found by fuzzy matching
      return {
        success: result.success,
        bestMatch: result.bestMatch,
        searchTerm: result.searchTerm,
        error: result.error,
        message: result.bestMatch
          ? `Found best matching playlist: "${result.bestMatch}"`
          : undefined,
      };
    }

    case 'fetch_feed_playlist_items':
      return await utilities.feedFetcher.fetchPlaylistItems(
        args.playlistName,
        args.quantity,
        args.duration,
        globalPlaylistMap
      );

    case 'build_playlist': {
      // Retrieve full items from registry using IDs
      const itemIds = args.itemIds;
      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        throw new Error('build_playlist requires itemIds array');
      }

      const fullItems = itemIds
        .map((id) => registry.getItem(id))
        .filter((item) => item !== undefined);

      if (fullItems.length === 0) {
        throw new Error('No valid items found in registry for provided IDs');
      }

      // Apply shuffle if requested
      const items = args.shuffle ? utilities.shuffleArray([...fullItems]) : fullItems;

      // Build playlist
      const title = args.title === 'null' || args.title === null ? null : args.title;
      const slug = args.slug === 'null' || args.slug === null ? null : args.slug;
      const playlist = await utilities.buildDP1Playlist(items, title, slug);

      // Store in registry
      registry.storePlaylist(playlist.id, playlist);

      // Return minimal metadata
      return {
        playlistId: playlist.id,
        itemCount: playlist.items.length,
        title: playlist.title,
        dpVersion: playlist.dpVersion,
        hasSigned: playlistHasCryptographicSignature(playlist),
        slug: playlist.slug,
      };
    }

    case 'send_to_device': {
      // Retrieve playlist from registry
      const playlistId = args.playlistId;
      if (!playlistId || !registry.hasPlaylist(playlistId)) {
        throw new Error('Invalid playlistId or playlist not found in registry');
      }

      const playlist = registry.getPlaylist(playlistId);
      const result = await utilities.sendToDevice(playlist, args.deviceName);

      // Return minimal response
      return {
        success: result.success,
        deviceName: result.deviceName,
        message: result.message,
        error: result.error,
      };
    }

    case 'resolve_domains':
      return await utilities.resolveDomains(args);

    case 'verify_playlist': {
      const { verifyPlaylist } = require('../utilities/functions');

      // Retrieve playlist from registry
      const playlistId = args.playlistId;
      if (!playlistId || !registry.hasPlaylist(playlistId)) {
        throw new Error('Invalid playlistId or playlist not found in registry');
      }

      const playlist = registry.getPlaylist(playlistId);
      const result = await verifyPlaylist({ playlist });

      // Return minimal response
      if (result.valid) {
        return {
          valid: true,
          playlistId: playlistId,
          itemCount: playlist.items.length,
        };
      } else {
        // Only return first 3 errors to save context
        return {
          valid: false,
          playlistId: playlistId,
          error: result.error,
          details: result.details?.slice(0, 3) || [],
        };
      }
    }

    default:
      throw new Error(`Unknown function: ${functionName}`);
  }
}

/**
 * Build system prompt for AI orchestrator
 *
 * @param {Object} params - Validated parameters from intent parser
 * @returns {string} System prompt
 */
function buildOrchestratorSystemPrompt(params) {
  const { requirements, playlistSettings } = params;

  const requirementsText = requirements
    .map((req, i) => {
      if (req.type === 'fetch_feed') {
        return `${i + 1}. Fetch ${req.quantity || 5} items from playlist "${req.playlistName}"`;
      } else if (req.type === 'feral_file_artwork') {
        return `${i + 1}. Resolve Feral File artwork ${req.artworkId}`;
      } else if (req.type === 'query_address') {
        const quantityText =
          req.quantity === 'all' ? 'all ' : req.quantity ? req.quantity + ' random ' : 'all ';
        return `${i + 1}. Query ${quantityText}tokens from address ${req.ownerAddress}`;
      } else {
        return (
          `${i + 1}. ${req.blockchain} - ${req.tokenIds?.length || 0} tokens` +
          (req.contractAddress ? ` from ${req.contractAddress.substring(0, 10)}...` : '')
        );
      }
    })
    .join('\n');

  const hasDevice = playlistSettings.deviceName !== undefined;
  const sendStep = hasDevice
    ? `6) If verification passed → you MUST call send_to_device({ playlistId: <the_playlistId>, deviceName: "${playlistSettings.deviceName || 'first-device'}" }) before finishing.
   CRITICAL: Pass the playlistId string from step 4.`
    : `6) Verification passed → you're done. Do not send to device.`;

  return `SYSTEM: FF1 Orchestrator (Function-Calling)

ROLE
- Execute parsed requirements deterministically and build a DP‑1 playlist. Keep outputs concise and operational.

REQUIREMENTS
${requirementsText}

PLAYLIST SETTINGS
- durationPerItem: ${playlistSettings.durationPerItem || 10}
- title: ${playlistSettings.title || 'auto'}
- slug: ${playlistSettings.slug || 'auto'}
- preserveOrder: ${playlistSettings.preserveOrder !== false ? 'true' : 'false'}
${hasDevice ? `- deviceName: ${playlistSettings.deviceName || 'first-device'}` : ''}

REASONING (private scratchpad)
- Use Plan→Check→Act→Reflect for each step.
- Default to a single deterministic path.
- Only branch in two cases:
  1) Multiple plausible feed candidates after search.
  2) Verification failure requiring targeted repair.
- When branching, keep BEAM_WIDTH=2, DEPTH_LIMIT=2.
- Score candidates by: correctness, coverage, determinism, freshness, cost.
- Keep reasoning hidden; publicly print one status sentence before each tool call.

KEY RULES
- Domains: ".eth" and ".tez" are OWNER DOMAINS. Resolve to addresses before querying ownership.
- Do not fabricate or truncate contract addresses or tokenIds.
- Title/slug: when calling build_playlist, pass actual null (not string "null"):
  • If title provided in settings → pass settings.title as-is
  • If title NOT provided → pass null (NOT the string "null")
  • If slug provided in settings → pass settings.slug as-is
  • If slug NOT provided → pass null (NOT the string "null")
- Shuffle: set shuffle = ${playlistSettings.preserveOrder === false ? 'true' : 'false'}.
- Build → verify_playlist (structure/parse only)${hasDevice ? ' → Send' : ''} (MANDATORY before${hasDevice ? ' sending' : ' finishing'}).

DECISION LOOP
1) For each requirement in order:
   - build_playlist: call query_requirement(requirement, duration=${playlistSettings.durationPerItem || 10}).
     Returns array with minimal item data including id field. Collect the id values.
   - feral_file_artwork: call query_requirement(requirement, duration=${playlistSettings.durationPerItem || 10}).
     Returns array with minimal item data including id field. Collect the id values.
   - query_address:
     • if ownerAddress endsWith .eth/.tez → resolve_domains([domain]); if resolved → use returned address; if not → mark failed and continue.
     • if ownerAddress is 0x…/tz… → call query_requirement(requirement, duration=${playlistSettings.durationPerItem || 10}).
   - fetch_feed: search_feed_playlist(name) → take bestMatch → fetch_feed_playlist_items(bestMatch, quantity, duration=${playlistSettings.durationPerItem || 10}).
   - Collect item IDs across all steps in an array (let's call it collectedItemIds).
2) If zero items → explain briefly and finish.
3) If some requirements failed and interactive mode → ask user; otherwise proceed with available items.
4) Call build_playlist({ itemIds: collectedItemIds, title: settings.title || null, slug: settings.slug || null, shuffle }).
   CRITICAL: 
   - Pass itemIds array containing the id field from each item
   - Pass actual null values for title/slug, NOT the string "null"
   - Returns: { playlistId, itemCount, title, dpVersion, hasSigned, slug }
   - Store the playlistId in a variable.
5) Call verify_playlist({ playlistId: <the_playlistId_from_step_4> }).
   CRITICAL: Pass the playlistId string, not an object.
   Returns: { valid: true/false, playlistId, itemCount } or { valid: false, error, details }
   If invalid ≤3 attempts, analyze error.details and rebuild; otherwise stop with clear error.
${sendStep}

KEY RULES
- NEVER pass full item objects or playlist objects to functions
- ALWAYS use item IDs (strings) and playlist IDs (strings)
- The registry system handles full objects internally

OUTPUT RULES
- Do NOT print JSON arguments.
- Before each function call, print exactly one sentence: "→ I'm …" describing the action.
- Call the function ONLY via tool calls and do not include tool names, JSON, or arguments in assistant content.
- No chain‑of‑thought or extra narration; keep public output minimal.

STOPPING CONDITIONS
- Finish only after: (items built → playlist built → verified${hasDevice ? ' → sent' : ''}) or after explaining why no progress is possible.`;
}

/**
 * Build playlist using AI orchestration (natural language path)
 *
 * @param {Object} params - Validated parameters from intent parser
 * @param {Object} options - Build options
 * @param {boolean} options.interactive - Whether in interactive mode (can ask user)
 * @returns {Promise<Object>} Result with playlist
 */
async function buildPlaylistWithAI(params, options = {}) {
  const {
    modelName,
    verbose = false,
    outputPath = 'playlist.json',
    interactive = false,
    conversationContext = null,
    defaultDeviceName,
  } = options;

  // Apply CLI --device fallback when the intent parser detected a send intent
  // (playlistSettings.deviceName !== undefined) but could not resolve the device
  // name from the user's text (null / empty / "null" sentinel).
  // If deviceName is undefined, no send was intended — ignore the CLI flag to
  // prevent implicit sends on every build-only `chat --device` invocation.
  if (
    params.playlistSettings &&
    params.playlistSettings.deviceName !== undefined &&
    (!params.playlistSettings.deviceName || params.playlistSettings.deviceName === 'null') &&
    defaultDeviceName
  ) {
    params = {
      ...params,
      playlistSettings: { ...params.playlistSettings, deviceName: defaultDeviceName },
    };
  }

  const OpenAI = require('openai');
  const { getModelConfig } = require('../config');

  const modelConfig = getModelConfig(modelName);

  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseURL,
    timeout: modelConfig.timeout,
    maxRetries: modelConfig.maxRetries,
  });

  let messages;

  if (conversationContext && conversationContext.messages) {
    // Continue from existing conversation
    messages = [...conversationContext.messages];
    messages.push({
      role: 'user',
      content: conversationContext.userResponse,
    });
  } else {
    // Start new conversation
    const systemPrompt = buildOrchestratorSystemPrompt(params);
    const interactiveNote = interactive
      ? '\n\nYou are in INTERACTIVE MODE. You can ask the user for confirmation when some requirements fail.'
      : '\n\nYou are in NON-INTERACTIVE MODE. If some requirements fail, automatically proceed with available items without asking.';

    // Build detailed user message with the actual requirements
    const requirementsDetail = params.requirements
      .map((req, i) => {
        if (req.type === 'fetch_feed') {
          return `${i + 1}. Fetch ${req.quantity || 5} items from playlist "${req.playlistName}"`;
        } else if (req.type === 'feral_file_artwork') {
          return `${i + 1}. Resolve Feral File artwork:\n   - artworkId: "${req.artworkId}"`;
        } else if (req.type === 'query_address') {
          const quantityDesc =
            req.quantity === 'all'
              ? 'all tokens (with pagination)'
              : req.quantity
                ? `${req.quantity} (random selection)`
                : 'all tokens';
          return `${i + 1}. Query tokens from address:\n   - ownerAddress: "${req.ownerAddress}"\n   - quantity: ${quantityDesc}`;
        } else {
          return `${i + 1}. Query tokens:\n   - blockchain: "${req.blockchain}"\n   - contractAddress: "${req.contractAddress}"\n   - tokenIds: ${JSON.stringify(req.tokenIds)}\n   - quantity: ${req.quantity}`;
        }
      })
      .join('\n');

    messages = [
      { role: 'system', content: systemPrompt + interactiveNote },
      {
        role: 'user',
        content: `Execute these requirements now. Use the EXACT values provided - do not modify or make up different values:\n\n${requirementsDetail}\n\nStart by calling query_requirement for each requirement with these EXACT values.`,
      },
    ];
  }

  let finalPlaylist = null;
  let iterationCount = 0;
  let collectedItems = [];
  let verificationFailures = 0;
  let sentToDevice = false;
  const queryRequirementCache = new Map();
  const maxIterations = 20;
  const maxVerificationRetries = 3;

  while (iterationCount < maxIterations) {
    iterationCount++;

    const requestParams = {
      model: modelConfig.model,
      messages,
      tools: functionSchemas,
      tool_choice: 'auto',
      stream: false,
    };

    if (modelConfig.temperature !== undefined) {
      requestParams.temperature = modelConfig.temperature;
    }

    if (modelConfig.model.startsWith('gpt-')) {
      requestParams.max_completion_tokens = 4000;
    } else {
      requestParams.max_tokens = 4000;
    }

    let response;

    try {
      response = await createCompletionWithRetry(client, requestParams, modelConfig.maxRetries);
    } catch (error) {
      const status = error?.response?.status ?? error?.status;
      const statusText = error?.response?.statusText;
      const responseDetails =
        error?.response?.data && typeof error.response.data === 'string'
          ? error.response.data
          : error?.response?.data
            ? JSON.stringify(error.response.data)
            : null;
      const detailParts = [
        error.message,
        status ? `status ${status}${statusText ? ` ${statusText}` : ''}` : null,
        responseDetails ? `response ${responseDetails}` : null,
      ].filter(Boolean);
      const hint = status === 429 ? 'rate limited by model provider' : null;
      throw new Error(
        `AI orchestrator failed (model=${modelConfig.model}, baseURL=${modelConfig.baseURL}): ${detailParts.join(' | ')}${hint ? ` | ${hint}` : ''}`
      );
    }

    const message = response.choices[0].message;

    // Gemini workaround: If AI finished without calling build_playlist despite having items
    // This handles cases where:
    // - finish_reason is 'stop' but no content/tool_calls
    // - finish_reason includes 'MALFORMED_FUNCTION_CALL' (Gemini tried but failed)
    // - Any other case where we have items but no playlist
    if (verbose) {
      console.log(chalk.dim(`→ finish_reason: ${response.choices[0].finish_reason}`));
      console.log(chalk.dim(`→ has content: ${!!message.content}`));
      console.log(chalk.dim(`→ has tool_calls: ${!!message.tool_calls}`));
      console.log(
        chalk.dim(`→ collectedItems: ${collectedItems.length}, finalPlaylist: ${!!finalPlaylist}`)
      );
    }

    if (!message.tool_calls && collectedItems.length > 0 && !finalPlaylist) {
      const finishReason = response.choices[0].finish_reason || '';

      // If Gemini keeps failing with MALFORMED_FUNCTION_CALL, call build_playlist directly
      if (finishReason.includes('MALFORMED_FUNCTION_CALL') || finishReason.includes('filter')) {
        if (verbose) {
          console.log(chalk.yellow(`AI function call malformed. Calling build_playlist directly.`));
        }

        // Call build_playlist directly with the collected item IDs
        try {
          const utilities = require('../utilities');
          // Retrieve full items from registry using IDs
          const fullItems = collectedItems
            .map((id) => registry.getItem(id))
            .filter((item) => item !== undefined);

          if (fullItems.length > 0) {
            const result = await utilities.buildDP1Playlist(
              fullItems,
              params.playlistSettings?.title || null,
              params.playlistSettings?.slug || null
            );

            if (result.dpVersion) {
              finalPlaylist = result;
              const { savePlaylist } = require('../utils');
              await savePlaylist(result, outputPath);

              if (verbose) {
                console.log(chalk.green(`✓ Successfully built playlist directly`));
              }
              break; // Exit the loop
            }
          }
        } catch (error) {
          if (verbose) {
            console.log(chalk.red(`Failed to build playlist directly: ${error.message}`));
          }
        }
      } else if (iterationCount < maxIterations - 1) {
        // Try one more time with a system message
        if (verbose) {
          console.log(
            chalk.yellow(
              `AI stopped without calling build_playlist (reason: ${finishReason}). Forcing it to continue.`
            )
          );
        }
        messages.push({
          role: 'system',
          content: `CRITICAL: You have collected ${collectedItems.length} items but have NOT called build_playlist yet. You MUST call the build_playlist function NOW with these items.`,
        });
        continue; // Go to next iteration
      }
    }

    const contentText = message.content || '';
    const looksLikeToolAttempt =
      !message.tool_calls &&
      contentText &&
      (contentText.includes("→ I'm") ||
        contentText.includes('"requirement"') ||
        contentText.trim().startsWith('{'));

    if (looksLikeToolAttempt) {
      const inferredToolCall = inferToolCallFromContent(contentText, iterationCount);
      if (inferredToolCall) {
        if (verbose) {
          console.log(
            chalk.yellow('AI returned JSON in text. Executing inferred query_requirement.')
          );
        }
        message.tool_calls = [inferredToolCall];
      } else if (iterationCount < maxIterations - 1) {
        if (verbose) {
          console.log(
            chalk.yellow(
              'AI returned tool arguments in text. Forcing function call with a system reminder.'
            )
          );
        }
        messages.push(message);
        messages.push({
          role: 'system',
          content:
            'CRITICAL: You MUST call the required function via tool_calls. Do not output JSON or arguments in plain text. Call the function now.',
        });
        continue;
      }
    }

    messages.push(message);

    // Only print non-json assistant content while keeping function-call noise low.
    if (message.content) {
      const trimmed = message.content.trim();
      const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
      const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');

      if (!isJson && (verbose || !hasToolCalls)) {
        console.log(chalk.cyan(trimmed));
      }
    }
    if (verbose) {
      console.log(chalk.dim(`\nIteration ${iterationCount}:`));
    }

    // Execute function calls if any
    if (message.tool_calls && message.tool_calls.length > 0) {
      if (verbose) {
        console.log(chalk.dim(`→ Executing ${message.tool_calls.length} function(s)...`));
      }

      for (const toolCall of message.tool_calls) {
        const functionName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        if (verbose) {
          console.log(chalk.dim(`\n  • Function: ${chalk.bold(functionName)}`));
          console.log(
            chalk.dim(`    Input: ${JSON.stringify(args, null, 2).split('\n').join('\n    ')}`)
          );
        }

        try {
          let result;
          let usedCache = false;

          if (functionName === 'query_requirement') {
            const cacheKey = stableStringify({
              requirement: args.requirement,
              duration: args.duration,
            });
            if (queryRequirementCache.has(cacheKey)) {
              result = queryRequirementCache.get(cacheKey);
              usedCache = true;
              if (verbose) {
                console.log(chalk.dim('    ↺ Using cached result for duplicate query_requirement'));
              }
            } else {
              result = await executeFunction(functionName, args);
              queryRequirementCache.set(cacheKey, result);
            }
          } else {
            result = await executeFunction(functionName, args);
          }

          if (verbose) {
            console.log(
              chalk.dim(`    Output: ${JSON.stringify(result, null, 2).split('\n').join('\n    ')}`)
            );
          }

          // Track collected item IDs from query_requirement
          if (functionName === 'query_requirement' && Array.isArray(result) && !usedCache) {
            // Result now contains minimal item objects with id field
            const itemIds = result.map((item) => item.id).filter((id) => id);
            collectedItems = collectedItems.concat(itemIds); // Now storing IDs, not full items
            if (verbose) {
              console.log(
                chalk.green(
                  `    ✓ Collected ${result.length} item IDs (total: ${collectedItems.length})`
                )
              );
            }
          }

          // Track final playlist by retrieving it from registry
          if (functionName === 'build_playlist' && result.playlistId) {
            // Retrieve full playlist from registry
            finalPlaylist = registry.getPlaylist(result.playlistId);

            // Save playlist
            const { savePlaylist } = require('../utils');
            await savePlaylist(finalPlaylist, outputPath);
          }

          // Track device sending
          if (functionName === 'send_to_device') {
            if (result && result.success) {
              sentToDevice = true;
              if (verbose) {
                console.log(chalk.green(`✓ Playlist sent to device`));
              }
            }
          }

          // Handle verification results
          if (functionName === 'verify_playlist') {
            if (result.valid) {
              if (verbose) {
                console.log(chalk.green(`✓ Playlist verification passed`));
              }
              // Check if verification passed - don't break yet, let AI continue (may need to call send_to_device)
              // The loop will naturally end when AI has no more tool calls or we hit iteration limit
              // if (verificationPassed) {
              //   break;
              // }
            } else {
              verificationFailures++;
              if (verbose) {
                console.log(
                  chalk.yellow(
                    `Playlist verification failed (attempt ${verificationFailures}/${maxVerificationRetries})`
                  )
                );
              }
              // Check if we've exceeded max retries
              if (verificationFailures >= maxVerificationRetries) {
                if (verbose) {
                  console.log(
                    chalk.red(`Playlist validation failed after ${maxVerificationRetries} retries`)
                  );
                }
                return {
                  success: false,
                  error: `Playlist validation failed: ${result.error}`,
                  details: result.details,
                  playlist: null,
                };
              }
              // Add verification error to messages so AI can fix it
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({
                  valid: false,
                  error: result.error,
                  details: result.details,
                  message: `Playlist validation failed. Please fix the issues and rebuild the playlist.\n\nErrors: ${JSON.stringify(result.details, null, 2)}`,
                }),
              });
              // Ask AI to fix and rebuild
              const fixPrompt = `The playlist validation failed with these errors:\n\n${result.error}\n\nDetails:\n${result.details ? result.details.map((d) => `- ${d.path}: ${d.message}`).join('\n') : 'N/A'}\n\nPlease fix these issues and rebuild the playlist. You can rebuild it by calling build_playlist again with corrected data.`;
              messages.push({
                role: 'user',
                content: fixPrompt,
              });
              continue; // Don't finish, let AI try again
            }
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        } catch (error) {
          if (verbose) {
            console.log(chalk.red(`    Error: ${error.message}`));
          }
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: error.message, success: false }),
          });
        }
      }
      // Check if verification passed - don't break yet, let AI continue (may need to call send_to_device)
      // The loop will naturally end when AI has no more tool calls or we hit iteration limit
      // if (verificationPassed) {
      //   break;
      // }
    } else {
      // AI has finished
      if (verbose) {
        console.log(chalk.dim('\n→ AI has finished (no more tool calls)'));
        if (!message.content) {
          console.log(chalk.red('→ AI sent NO content and NO tool calls!'));
        }
      }
      if (finalPlaylist) {
        // Deterministic fallback: if user requested device sending but AI forgot,
        // send here before returning (only if NOT already sent by AI)
        try {
          const deviceNameRequested =
            params.playlistSettings && params.playlistSettings.deviceName !== undefined;
          if (deviceNameRequested && !sentToDevice) {
            console.log(chalk.cyan('\n→ Sending to device...'));
            const utilities = require('../utilities');
            const sendResult = await utilities.sendToDevice(
              finalPlaylist,
              params.playlistSettings.deviceName || null
            );
            if (sendResult && sendResult.success) {
              sentToDevice = true;
              console.log(chalk.green(`✓ Sent to device: ${sendResult.deviceName}`));
            } else {
              // Device sending failed - this is a failure condition
              return {
                success: false,
                error: `Failed to send playlist to device: ${sendResult?.error || 'Unknown error'}`,
                playlist: finalPlaylist,
                sentToDevice: false,
              };
            }
          }
        } catch (error) {
          return {
            success: false,
            error: `Failed to send to device: ${error && error.message ? error.message : error}`,
            playlist: finalPlaylist,
            sentToDevice: false,
          };
        }

        // Publish to feed server if requested
        let publishResult = null;
        if (params.playlistSettings && params.playlistSettings.feedServer) {
          console.log(chalk.cyan('\n→ Publishing to feed server...'));
          try {
            const { publishPlaylist } = require('../utilities/playlist-publisher');
            publishResult = await publishPlaylist(
              outputPath,
              params.playlistSettings.feedServer.baseUrl,
              params.playlistSettings.feedServer.apiKey
            );

            if (publishResult.success) {
              console.log(chalk.green(`✓ Published to feed server`));
              if (publishResult.playlistId) {
                console.log(chalk.dim(`   Playlist ID: ${publishResult.playlistId}`));
              }
              if (publishResult.feedServer) {
                console.log(chalk.dim(`   Server: ${publishResult.feedServer}`));
              }
            } else {
              console.error(chalk.red(`Publish failed: ${publishResult.error}`));
              if (publishResult.message) {
                console.error(chalk.dim(`   ${publishResult.message}`));
              }
            }
          } catch (error) {
            console.error(chalk.red(`Publish failed: ${error.message}`));
            if (verbose) {
              console.error(chalk.dim(error.stack));
            }
          }
        }

        // Clear registries after successful build
        registry.clearRegistries();

        return {
          playlist: finalPlaylist,
          sentToDevice,
          published: publishResult?.success || false,
          publishResult,
        };
      }
      // AI finished without building a playlist - check if it provided an explanation
      if (message.content) {
        // Check if AI is asking for confirmation (interactive mode)
        const isAskingConfirmation =
          interactive &&
          message.content.toLowerCase().includes('would you like') &&
          (message.content.toLowerCase().includes('proceed') ||
            message.content.toLowerCase().includes('build') ||
            message.content.toLowerCase().includes('cancel'));

        if (isAskingConfirmation) {
          // Return with needsConfirmation flag
          return {
            needsConfirmation: true,
            question: message.content,
            messages: messages,
            params: params,
          };
        }

        // AI has explained why no playlist was built (e.g., no matching items found)
        // Content already printed above, just return the result
        return {
          success: false,
          message: message.content,
          playlist: null,
        };
      }
      break;
    }
  }

  if (!finalPlaylist) {
    registry.clearRegistries(); // Clear on failure
    throw new Error(
      'Failed to build playlist - No items found or AI did not complete the task. Check if the requirements match any available data.'
    );
  }

  return { playlist: finalPlaylist, sentToDevice };
}

module.exports = {
  functionSchemas,
  executeFunction,
  buildOrchestratorSystemPrompt,
  buildPlaylistWithAI,
};
