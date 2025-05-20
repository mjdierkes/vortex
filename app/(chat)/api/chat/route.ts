import {
  appendClientMessage,
  appendResponseMessages,
  createDataStream,
  smoothStream,
  streamText,
} from 'ai';
import { auth, type UserType } from '@/app/(auth)/auth';
import { type RequestHints, systemPrompt } from '@/lib/ai/prompts';
import {
  createStreamId,
  deleteChatById,
  getChatById,
  getMessageCountByUserId,
  getMessagesByChatId,
  getStreamIdsByChatId,
  saveChat,
  saveMessages,
} from '@/lib/db/queries';
import { generateUUID, getTrailingMessageId } from '@/lib/utils';
import { generateTitleFromUserMessage } from '../../actions';
import { createDocument } from '@/lib/ai/tools/create-document';
import { updateDocument } from '@/lib/ai/tools/update-document';
import { requestSuggestions } from '@/lib/ai/tools/request-suggestions';
import { getWeather } from '@/lib/ai/tools/get-weather';
import { renderReact } from '@/lib/ai/tools/render-react';
import { isProductionEnvironment } from '@/lib/constants';
import { myProvider } from '@/lib/ai/providers';
import { entitlementsByUserType } from '@/lib/ai/entitlements';
import { postRequestBodySchema, type PostRequestBody } from './schema';
import { geolocation } from '@vercel/functions';
import {
  createResumableStreamContext,
  type ResumableStreamContext,
} from 'resumable-stream';
import { after } from 'next/server';
import type { Chat } from '@/lib/db/schema';
import { differenceInSeconds } from 'date-fns';
import { ChatSDKError } from '@/lib/errors';
import { z } from 'zod';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Assuming a type for what we expect from mcpTool.inputSchema.properties items
interface McpJsonSchemaProperty { 
  type?: string | string[]; // Can be a string (e.g., "string") or array (for union types like ["string", "null"])
  description?: string;
  items?: McpJsonSchemaProperty; // For type: 'array', describes the items in the array
  enum?: string[];             // For type: 'string' or array items with an enum constraint
  // other JSON schema fields might be here
  [key: string]: any; // Allow other properties for flexibility with varied JSON schemas
}

// Assuming a type for what we expect from mcpTool.inputSchema
interface McpJsonSchema { 
  type?: string;
  properties?: Record<string, McpJsonSchemaProperty>;
  required?: string[];
  // other JSON schema fields
  [key: string]: any; // Allow other properties
}

// Assuming a type for mcpTool from SDK (partial, based on usage)
interface McpTool {
  name: string;
  description?: string;
  inputSchema?: McpJsonSchema; 
  [key: string]: any; // Allow other properties
}

// Type for content items from MCP tool call result
interface McpToolResultContentItem {
  type: string;
  text?: string;
  // Other potential fields depending on content type
  [key: string]: any; 
}

// Type for the result of mcpClient.callTool
interface McpCallToolResult {
  content?: McpToolResultContentItem[];
  isError?: boolean;
  error?: any; // Or a more specific error type if known
}

export const maxDuration = 60;

let globalStreamContext: ResumableStreamContext | null = null;

function getStreamContext() {
  if (!globalStreamContext) {
    try {
      globalStreamContext = createResumableStreamContext({
        waitUntil: after,
      });
    } catch (error: any) {
      if (error.message.includes('REDIS_URL')) {
        console.log(
          ' > Resumable streams are disabled due to missing REDIS_URL',
        );
      } else {
        console.error(error);
      }
    }
  }

  return globalStreamContext;
}

interface DynamicToolDefinition {
  operationId: string;
  description: string;
  parametersSchema: z.ZodObject<any, any, any>;
  mcpServerUrl: string;
  mcpToolName: string;
}

async function loadToolsViaMcpSdk(url: string): Promise<Record<string, DynamicToolDefinition>> {
  const definitions: Record<string, DynamicToolDefinition> = {};
  let mcpClient: Client | null = null;
  let transport: StreamableHTTPClientTransport | null = null;

  console.log(`Attempting to load tools from MCP server: ${url}`);

  try {
    const serverUrl = new URL(url);

    mcpClient = new Client({
      name: "vortex-chat-client",
      version: "1.0.0",
    });

    transport = new StreamableHTTPClientTransport(serverUrl);
    console.log("MCP Transport created. Attempting to connect...");
    await mcpClient.connect(transport);
    console.log(`Successfully connected to MCP server: ${url}`);

    const toolsResult = await mcpClient.listTools(); // Assuming listTools returns { tools: McpTool[] }
    console.log("Tools listed from MCP server:", JSON.stringify(toolsResult, null, 2));

    if (toolsResult.tools && toolsResult.tools.length > 0) {
      for (const mcpTool of toolsResult.tools as McpTool[]) { // Cast to our McpTool interface
        const operationId = mcpTool.name;
        const description = mcpTool.description || 'No description provided by MCP server.';

        let paramShape: Record<string, z.ZodTypeAny> = {};
        const inputSchema = mcpTool.inputSchema;

        if (inputSchema && inputSchema.type === 'object' && inputSchema.properties) {
          for (const propName in inputSchema.properties) {
            const propSchema: McpJsonSchemaProperty = inputSchema.properties[propName];
            const isRequired = inputSchema.required?.includes(propName) ?? false;
            
            let zodType: z.ZodTypeAny;

            // Enhanced type mapping for arrays and enums
            if (propSchema.type === 'array') {
              let itemType: z.ZodTypeAny = z.any(); // Default for array items if not specified
              if (propSchema.items) {
                if (propSchema.items.type === 'string' && propSchema.items.enum && propSchema.items.enum.length > 0) {
                  // Zod enums need at least one value.
                  const enumValues = propSchema.items.enum as [string, ...string[]];
                  itemType = z.enum(enumValues);
                } else if (propSchema.items.type === 'string') {
                  itemType = z.string();
                } else if (propSchema.items.type === 'number' || propSchema.items.type === 'integer') {
                  itemType = z.number();
                } else if (propSchema.items.type === 'boolean') {
                  itemType = z.boolean();
                }
                // Add other primitive item types as needed
              }
              zodType = z.array(itemType);
            } else if (propSchema.type === 'string' && propSchema.enum && propSchema.enum.length > 0) {
               // Zod enums need at least one value.
              const enumValues = propSchema.enum as [string, ...string[]];
              zodType = z.enum(enumValues);
            } else if (propSchema.type === 'number' || propSchema.type === 'integer') {
              zodType = z.number();
            } else if (propSchema.type === 'boolean') {
              zodType = z.boolean();
            } else { // Default to string for other types or if type is not specified
              zodType = z.string();
            }

            if (!isRequired) {
              zodType = zodType.optional();
            }
            
            paramShape[propName] = zodType.describe(propSchema.description || '');
          }
        }
        const parametersSchema = z.object(paramShape);

        definitions[operationId] = {
          operationId,
          description,
          parametersSchema,
          mcpServerUrl: url,
          mcpToolName: mcpTool.name,
        };
      }
      console.log(`Successfully processed ${Object.keys(definitions).length} tools from ${url}`);
    } else {
      console.log(`No tools found on MCP server ${url} or tools array is empty.`);
    }
  } catch (error: any) {
    console.error(`Error in loadToolsViaMcpSdk for ${url}: ${error.message}`);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    // Log additional error details if available (e.g., from a fetch-like response)
    if (error.response && typeof error.response.text === 'function') {
      try {
        const errorBody = await error.response.text();
        console.error(`Error response body from MCP connection attempt: ${errorBody}`);
      } catch (e) { /* ignore if body can't be read */ }
    }
  } finally {
    // No isConnected check, rely on close() to handle state or throw if called inappropriately.
    if (mcpClient) { 
      try {
        console.log("Closing MCP client connection in loadToolsViaMcpSdk...");
        await mcpClient.close();
        console.log("MCP client connection closed in loadToolsViaMcpSdk.");
      } catch (e: any) {
        console.error("Error closing mcpClient in loadToolsViaMcpSdk:", e.message);
      }
    }
  }
  return definitions;
}

export async function POST(request: Request) {
  let requestBody: PostRequestBody;

  try {
    const json = await request.json();
    requestBody = postRequestBodySchema.parse(json);
  } catch (_) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  try {
    const { id, message, selectedChatModel, selectedVisibilityType, mcpServerUrl } =
      requestBody;

    const session = await auth();

    if (!session?.user) {
      return new ChatSDKError('unauthorized:chat').toResponse();
    }

    const userType: UserType = session.user.type;

    const messageCount = await getMessageCountByUserId({
      id: session.user.id,
      differenceInHours: 24,
    });

    if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
      return new ChatSDKError('rate_limit:chat').toResponse();
    }

    const chat = await getChatById({ id });

    if (!chat) {
      const title = await generateTitleFromUserMessage({
        message,
      });

      await saveChat({
        id,
        userId: session.user.id,
        title,
        visibility: selectedVisibilityType,
      });
    } else {
      if (chat.userId !== session.user.id) {
        return new ChatSDKError('forbidden:chat').toResponse();
      }
    }

    const previousMessages = await getMessagesByChatId({ id });

    const messages = appendClientMessage({
      // @ts-expect-error: todo add type conversion from DBMessage[] to UIMessage[]
      messages: previousMessages,
      message,
    });

    const { longitude, latitude, city, country } = geolocation(request);

    const requestHints: RequestHints = {
      longitude,
      latitude,
      city,
      country,
    };

    await saveMessages({
      messages: [
        {
          chatId: id,
          id: message.id,
          role: 'user',
          parts: message.parts,
          attachments: message.experimental_attachments ?? [],
          createdAt: new Date(),
        },
      ],
    });

    let toolDefinitions: Record<string, DynamicToolDefinition> = {};
    if (mcpServerUrl) {
      try {
        toolDefinitions = await loadToolsViaMcpSdk(mcpServerUrl);
        console.log(`Dynamic tool definitions loaded from ${mcpServerUrl}:`, Object.keys(toolDefinitions));
      } catch (e) {
        console.error("Failed to load tool definitions from MCP server URL during POST:", e);
      }
    }

    const streamId = generateUUID();
    await createStreamId({ streamId, chatId: id });

    const stream = createDataStream({
      execute: (dataStream) => {
        const dynamicTools: Record<string, any> = {};
        for (const opId in toolDefinitions) {
          const def = toolDefinitions[opId];
          dynamicTools[opId] = {
            description: def.description,
            parameters: def.parametersSchema,
            execute: async (args: any) => {
              let toolMcpClient: Client | null = null;
              let toolTransport: StreamableHTTPClientTransport | null = null;
              try {
                console.log(`Executing dynamic MCP tool: ${def.mcpToolName} from ${def.mcpServerUrl} with args:`, args);
                const serverUrl = new URL(def.mcpServerUrl);
                toolMcpClient = new Client({
                  name: "vortex-chat-tool-executor",
                  version: "1.0.0"
                });
                toolTransport = new StreamableHTTPClientTransport(serverUrl);
                await toolMcpClient.connect(toolTransport);
                console.log(`Connected to MCP server for tool execution: ${def.mcpToolName}`);

                const toolCallResult = await toolMcpClient.callTool({
                  name: def.mcpToolName,
                  arguments: args,
                }) as McpCallToolResult; // Cast to our defined interface
                console.log(`Result from MCP tool ${def.mcpToolName}:`, toolCallResult);

                let resultForAi = "Tool executed successfully."; // Default message
                let meaningfulDataProcessed = false;

                if (toolCallResult.content && toolCallResult.content.length > 0) {
                  for (const item of toolCallResult.content) {
                    if (item.type === 'text' && item.text) {
                      const jsonPrefix = " succeeded. Response:\n{"; // Marker for our JSON payload
                      const jsonStartIndex = item.text.indexOf(jsonPrefix);

                      if (jsonStartIndex !== -1) {
                        const jsonString = item.text.substring(jsonStartIndex + " succeeded. Response:\n".length);
                        try {
                          const jsonData = JSON.parse(jsonString);
                          meaningfulDataProcessed = true;

                          const props: Record<string, any> = {};
                          let componentName: string | null = null;

                          if (jsonData.error && (jsonData.error.message?.includes('Insufficient client scope') || jsonData.error.status === 403)) {
                            resultForAi = `The Spotify API reported an error: ${jsonData.error.message}. This often means the provided OAuth token does not have sufficient permissions (scopes) for this specific action.`;
                            componentName = null; // No component for a scope error
                          } else if (def.mcpToolName === 'get_a_list_of_current_users_playlists' && jsonData.items && Array.isArray(jsonData.items) && jsonData.items.length > 0) {
                            // Handling for a list of playlists (e.g., from get_a_list_of_current_users_playlists)
                            const firstPlaylist = jsonData.items[0];
                            componentName = 'SpotifyItemCard';
                            props.itemType = 'playlist';
                            props.name = firstPlaylist.name;
                            props.description = firstPlaylist.description || null;
                            props.trackCount = firstPlaylist.tracks?.total;
                            props.spotifyUrl = firstPlaylist.external_urls?.spotify;
                            props.imageUrl = firstPlaylist.images?.[0]?.url;
                          } else if (jsonData.type === 'track' || def.mcpToolName === 'get_track' || def.mcpToolName === 'get_an_artists_top_tracks' || (def.mcpToolName === 'search' && jsonData.tracks?.items?.[0]?.type === 'track')) {
                            // Handling for a single track (e.g., from get_track, search, or artist's top tracks)
                            const trackData = (def.mcpToolName === 'search' && jsonData.tracks?.items?.[0]) ? jsonData.tracks.items[0] : jsonData;
                            componentName = 'SpotifyItemCard';
                            props.itemType = 'track';
                            props.name = trackData.name;
                            props.artist = trackData.artists?.[0]?.name;
                            props.album = trackData.album?.name;
                            props.spotifyUrl = trackData.external_urls?.spotify;
                            props.imageUrl = trackData.album?.images?.[0]?.url || trackData.images?.[0]?.url; // Prefer album image for tracks
                          } else if (jsonData.type === 'album' || def.mcpToolName === 'get_an_album' || (def.mcpToolName === 'search' && jsonData.albums?.items?.[0]?.type === 'album')) {
                            // Handling for a single album (e.g., from get_an_album or search)
                            const albumData = (def.mcpToolName === 'search' && jsonData.albums?.items?.[0]) ? jsonData.albums.items[0] : jsonData;
                            componentName = 'SpotifyItemCard';
                            props.itemType = 'album';
                            props.name = albumData.name;
                            props.artist = albumData.artists?.[0]?.name;
                            props.spotifyUrl = albumData.external_urls?.spotify;
                            props.imageUrl = albumData.images?.[0]?.url;
                            props.trackCount = albumData.total_tracks ?? albumData.tracks?.total;
                          } else if (jsonData.type === 'playlist' || def.mcpToolName === 'get_playlist' || (def.mcpToolName === 'search' && jsonData.playlists?.items?.[0]?.type === 'playlist')) {
                            // Handling for a single playlist (e.g., from get_playlist or search)
                            const playlistData = (def.mcpToolName === 'search' && jsonData.playlists?.items?.[0]) ? jsonData.playlists.items[0] : jsonData;
                            componentName = 'SpotifyItemCard';
                            props.itemType = 'playlist';
                            props.name = playlistData.name;
                            props.description = playlistData.description || null;
                            props.spotifyUrl = playlistData.external_urls?.spotify;
                            props.imageUrl = playlistData.images?.[0]?.url;
                            props.trackCount = playlistData.tracks?.total;
                          } else if (jsonData.error) {
                            resultForAi = `Spotify API returned an error: ${jsonData.error.message || JSON.stringify(jsonData.error)}`;
                            componentName = null; // No component for an error
                          }
                          // Add more specific handlers for other mcpToolName values as needed
                          
                          if (componentName) {
                            // Clean up props: remove null/undefined values
                            Object.keys(props).forEach(key => (props[key] === undefined || props[key] === null) && delete props[key]);
                            resultForAi = `The tool call was successful. Use the renderReact tool to display a '${componentName}' with the following props: ${JSON.stringify(props)}.`;
                          } else if (!resultForAi.startsWith("Spotify API returned an error:")) {
                            // Generic fallback if specific parsing fails but JSON is valid and not an error
                            resultForAi = "Successfully fetched data from Spotify. The data is structured but not specifically formatted for a card display in this case.";
                          }
                          break; 
                        } catch (e) {
                          console.warn("Failed to parse JSON from tool result item:", item.text, e);
                          if (!meaningfulDataProcessed) {
                            resultForAi = "Received a response that included data, but it couldn't be fully parsed. The raw text started with: " + item.text.substring(0, 100) + "...";
                          }
                        }
                      } else if (!meaningfulDataProcessed) {
                        resultForAi = item.text;
                      }
                    } else if (!meaningfulDataProcessed && item) {
                       resultForAi = "Received non-text or empty content from tool.";
                       console.log("Non-text or empty content item:", item);
                    }
                  }
                } else if (toolCallResult.isError) {
                  resultForAi = `Tool execution failed: ${JSON.stringify(toolCallResult.error || 'Unknown error')}`;
                  if (typeof toolCallResult.error === 'string' && (toolCallResult.error.includes('Insufficient client scope') || toolCallResult.error.includes('403'))) {
                     resultForAi = `The Spotify API reported an error, likely due to insufficient OAuth token permissions (scopes) for this action. Details: ${toolCallResult.error}`;
                  } else if (toolCallResult.error && typeof toolCallResult.error === 'object' && 'message' in toolCallResult.error) {
                    const errorMessage = (toolCallResult.error as any).message as string;
                    if (errorMessage.includes('Insufficient client scope') || errorMessage.includes('403')){
                        resultForAi = `The Spotify API reported an error: ${errorMessage}. This often means the provided OAuth token does not have sufficient permissions (scopes) for this specific action.`;
                    } else {
                        resultForAi = `Tool execution failed: ${errorMessage}`;
                    }
                  }
                  meaningfulDataProcessed = true; 
                }
                
                if (!meaningfulDataProcessed && toolCallResult.content && toolCallResult.content.length > 0 && resultForAi === "Tool executed successfully.") {
                    const firstItem = toolCallResult.content[0];
                    if (firstItem && firstItem.type === 'text' && firstItem.text) {
                        resultForAi = firstItem.text;
                    } else if (firstItem) {
                        resultForAi = "Tool returned structured data that was not specifically parsed.";
                    }
                }
                
                dataStream.writeData({ type: 'tool-result', toolName: opId, result: resultForAi });
                return resultForAi;

              } catch (execError: any) {
                console.error(`Error executing MCP tool ${def.mcpToolName}:`, execError.message, execError.stack);
                dataStream.writeData({ type: 'error', content: `Tool ${opId} execution error: ${execError.message}` });
                return { error: `Error executing tool ${opId}: ${execError.message}` };
              } finally {
                // No isConnected check here either
                if (toolMcpClient) { 
                  console.log("Closing MCP client after tool execution...");
                  await toolMcpClient.close().catch(e => console.error("Error closing MCP client post-tool-execution:", e));
                  console.log("MCP client closed post-tool-execution.");
                }
              }
            }
          };
        }

        const result = streamText({
          model: myProvider.languageModel(selectedChatModel),
          system: systemPrompt({ selectedChatModel, requestHints }),
          messages,
          maxSteps: 5,
          experimental_activeTools: selectedChatModel === 'chat-model-reasoning'
              ? []
              : [
                  'getWeather',
                  'createDocument',
                  'updateDocument',
                  'requestSuggestions',
                  'renderReact',
                  ...(Object.keys(dynamicTools) as string[]),
                ] as any,
          experimental_transform: smoothStream({ chunking: 'word' }),
          experimental_generateMessageId: generateUUID,
          tools: {
            getWeather,
            createDocument: createDocument({ session, dataStream }),
            updateDocument: updateDocument({ session, dataStream }),
            requestSuggestions: requestSuggestions({
              session,
              dataStream,
            }),
            renderReact,
            ...dynamicTools,
          },
          onFinish: async ({ response }) => {
            if (session.user?.id) {
              try {
                const assistantId = getTrailingMessageId({
                  messages: response.messages.filter(
                    (message) => message.role === 'assistant',
                  ),
                });

                if (!assistantId) {
                  throw new Error('No assistant message found!');
                }

                const [, assistantMessage] = appendResponseMessages({
                  messages: [message], // The original user message
                  responseMessages: response.messages,
                });

                await saveMessages({
                  messages: [
                    {
                      id: assistantId,
                      chatId: id,
                      role: assistantMessage.role,
                      parts: assistantMessage.parts,
                      attachments:
                        assistantMessage.experimental_attachments ?? [],
                      createdAt: new Date(),
                    },
                  ],
                });
              } catch (_) {
                console.error('Failed to save chat');
              }
            }
          },
          experimental_telemetry: {
            isEnabled: isProductionEnvironment,
            functionId: 'stream-text',
          },
        });

        result.consumeStream();

        result.mergeIntoDataStream(dataStream, {
          sendReasoning: true,
        });
      },
      onError: () => {
        return 'Oops, an error occurred!';
      },
    });

    const streamContext = getStreamContext();

    if (streamContext) {
      return new Response(
        await streamContext.resumableStream(streamId, () => stream),
      );
    } else {
      return new Response(stream);
    }
  } catch (error) {
    if (error instanceof ChatSDKError) {
      return error.toResponse();
    }
    console.error('[CHAT_API_POST_ERROR]', error);
    return new Response('Internal Server Error', { status: 500 });
  }
}

export async function GET(request: Request) {
  const streamContext = getStreamContext();
  const resumeRequestedAt = new Date();

  if (!streamContext) {
    return new Response(null, { status: 204 });
  }

  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get('chatId');

  if (!chatId) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  let chat: Chat;

  try {
    chat = await getChatById({ id: chatId });
  } catch {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (!chat) {
    return new ChatSDKError('not_found:chat').toResponse();
  }

  if (chat.visibility === 'private' && chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const streamIds = await getStreamIdsByChatId({ chatId });

  if (!streamIds.length) {
    return new ChatSDKError('not_found:stream').toResponse();
  }

  const recentStreamId = streamIds.at(-1);

  if (!recentStreamId) {
    return new ChatSDKError('not_found:stream').toResponse();
  }

  const emptyDataStream = createDataStream({
    execute: () => {},
  });

  const stream = await streamContext.resumableStream(
    recentStreamId,
    () => emptyDataStream,
  );

  /*
   * For when the generation is streaming during SSR
   * but the resumable stream has concluded at this point.
   */
  if (!stream) {
    const messages = await getMessagesByChatId({ id: chatId });
    const mostRecentMessage = messages.at(-1);

    if (!mostRecentMessage) {
      return new Response(emptyDataStream, { status: 200 });
    }

    if (mostRecentMessage.role !== 'assistant') {
      return new Response(emptyDataStream, { status: 200 });
    }

    const messageCreatedAt = new Date(mostRecentMessage.createdAt);

    if (differenceInSeconds(resumeRequestedAt, messageCreatedAt) > 15) {
      return new Response(emptyDataStream, { status: 200 });
    }

    const restoredStream = createDataStream({
      execute: (buffer) => {
        buffer.writeData({
          type: 'append-message',
          message: JSON.stringify(mostRecentMessage),
        });
      },
    });

    return new Response(restoredStream, { status: 200 });
  }

  return new Response(stream, { status: 200 });
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return new ChatSDKError('bad_request:api').toResponse();
  }

  const session = await auth();

  if (!session?.user) {
    return new ChatSDKError('unauthorized:chat').toResponse();
  }

  const chat = await getChatById({ id });

  if (chat.userId !== session.user.id) {
    return new ChatSDKError('forbidden:chat').toResponse();
  }

  const deletedChat = await deleteChatById({ id });

  return Response.json(deletedChat, { status: 200 });
}
