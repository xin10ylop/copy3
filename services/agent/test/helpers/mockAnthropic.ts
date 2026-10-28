/**
 * Scripted Anthropic API for tests: a custom `fetch` that answers each POST /v1/messages
 * with a server-sent-event stream built from the next scripted turn. The real SDK client,
 * tool runner, stream accumulator and zod validation all run unchanged.
 */
import Anthropic from '@anthropic-ai/sdk';

export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; name: string; input: Record<string, unknown> };

export interface ScriptedTurn {
  blocks: ScriptedBlock[];
  stop: 'tool_use' | 'end_turn' | 'refusal' | 'max_tokens';
  stopDetails?: { type: 'refusal'; category: string | null; explanation: string | null };
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export interface RecordedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown> & {
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<Record<string, unknown>>;
  };
}

export const DEFAULT_USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };

function turnEvents(turn: ScriptedTurn, n: number): Array<Record<string, unknown>> {
  const usage = turn.usage ?? DEFAULT_USAGE;
  const ev: Array<Record<string, unknown>> = [
    {
      type: 'message_start',
      message: {
        id: `msg_${n}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: 1,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        },
      },
    },
  ];
  turn.blocks.forEach((b, index) => {
    if (b.type === 'text') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else if (b.type === 'thinking') {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: `sig_${n}_${index}` } });
    } else {
      ev.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: `toolu_${n}_${index}`, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      // eager input streaming: the input arrives in several fragments
      const cut = Math.max(1, Math.floor(json.length / 2));
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } });
      ev.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } });
    }
    ev.push({ type: 'content_block_stop', index });
  });
  ev.push({
    type: 'message_delta',
    delta: { stop_reason: turn.stop, stop_sequence: null, ...(turn.stopDetails ? { stop_details: turn.stopDetails } : {}) },
    usage: {
      output_tokens: usage.output_tokens,
      input_tokens: usage.input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  });
  ev.push({ type: 'message_stop' });
  return ev;
}

export interface MockClient {
  client: Anthropic;
  requests: RecordedRequest[];
  remaining: () => number;
}

export function mockAnthropic(script: ScriptedTurn[]): MockClient {
  const requests: RecordedRequest[] = [];
  let i = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(String(init?.body ?? '{}')) as RecordedRequest['body'];
    requests.push({ url, headers: new Headers(init?.headers), body });
    const turn = script[i];
    if (!turn) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'script exhausted' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    const n = i++;
    const sse = turnEvents(turn, n)
      .map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': `req_${n}` } });
  };
  const client = new Anthropic({ apiKey: 'sk-ant-test', fetch: fetchImpl, maxRetries: 0 });
  return { client, requests, remaining: () => script.length - i };
}
