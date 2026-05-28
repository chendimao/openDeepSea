#!/usr/bin/env node
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type PromptRequest,
} from '@agentclientprotocol/sdk';
import { writeFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

if (process.env.OPENCLAW_FAKE_ACP_PID_FILE) {
  writeFileSync(process.env.OPENCLAW_FAKE_ACP_PID_FILE, String(process.pid), 'utf-8');
}

if (process.env.OPENCLAW_FAKE_ACP_IGNORE_SIGTERM === '1') {
  process.on('SIGTERM', () => undefined);
}

class FakeAgent implements Agent {
  constructor(private readonly connection: AgentConnection) {}

  async initialize() {
    if (process.env.OPENCLAW_FAKE_ACP_HANG_INITIALIZE === '1') {
      await new Promise(() => undefined);
    }

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
      authMethods: [],
    };
  }

  async newSession() {
    return {
      sessionId: 'fake-session-1',
    };
  }

  async authenticate() {
    return {};
  }

  async prompt(params: PromptRequest) {
    if (process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT === '1') {
      throw new Error(process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_MESSAGE ?? 'stream disconnected before completion: Transport error: network error: error decoding response body');
    }

    if (
      process.env.OPENCLAW_FAKE_ACP_REQUIRE_SUPERPOWERS_DISABLED === '1' &&
      process.env.SUPERPOWERS_BOOTSTRAP_DISABLED !== '1'
    ) {
      throw new Error('missing SUPERPOWERS_BOOTSTRAP_DISABLED env');
    }

    if (process.env.OPENCLAW_FAKE_ACP_STDERR_DISCONNECT === '1') {
      process.stderr.write('stream disconnected before completion: Transport error: network error: error decoding response body\n');
      await new Promise(() => undefined);
    }

    if (process.env.OPENCLAW_FAKE_ACP_STDERR_HANDLED_RECONNECT === '1') {
      process.stderr.write('Handled error during turn: Reconnecting... 1/5 Some(ResponseStreamDisconnected { http_status_code: None }) Some("stream disconnected before completion: Transport error: network error: error decoding response body")\n');
    }

    if (process.env.OPENCLAW_FAKE_ACP_HANG_PROMPT === '1') {
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'partial answer before timeout',
          },
        },
      });
      await new Promise(() => undefined);
    }

    if (process.env.OPENCLAW_FAKE_ACP_PERMISSION === '1') {
      await this.connection.requestPermission({
        sessionId: params.sessionId,
        toolCall: {
          toolCallId: 'permission-tool-1',
          title: process.env.OPENCLAW_FAKE_ACP_PERMISSION_TITLE ?? 'Edit package.json',
          kind: (process.env.OPENCLAW_FAKE_ACP_PERMISSION_KIND ?? 'edit') as 'edit',
        },
        options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
          { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
        ],
      });
    }

    if (process.env.OPENCLAW_FAKE_ACP_READ_PATH) {
      await this.connection.readTextFile({
        sessionId: params.sessionId,
        path: process.env.OPENCLAW_FAKE_ACP_READ_PATH,
      });
    }

    if (process.env.OPENCLAW_FAKE_ACP_WRITE_PATH) {
      await this.connection.writeTextFile({
        sessionId: params.sessionId,
        path: process.env.OPENCLAW_FAKE_ACP_WRITE_PATH,
        content: process.env.OPENCLAW_FAKE_ACP_WRITE_CONTENT ?? 'fake write',
      });
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: '先分析请求',
        },
      },
    });

    if (process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT === '1') {
      throw new Error('fake failure after event');
    }

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'plan',
        entries: [
          {
            content: '执行 fake ACP 流',
            priority: 'high',
            status: 'in_progress',
          },
        ],
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read package.json',
        kind: 'read',
        rawInput: {
          path: 'package.json',
        },
        status: 'in_progress',
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        title: 'Read package.json',
        status: 'completed',
        rawOutput: {
          ok: true,
        },
      },
    });

    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'fake answer',
        },
      },
    });

    return {
      stopReason: process.env.OPENCLAW_FAKE_ACP_STOP_REASON_CANCELLED === '1' ? 'cancelled' as const : 'end_turn' as const,
    };
  }

  async cancel() {
    return undefined;
  }

  async closeSession() {
    if (process.env.OPENCLAW_FAKE_ACP_HANG_CLOSE_SESSION === '1') {
      await new Promise(() => undefined);
    }
    return {};
  }
}

new AgentSideConnection(
  (connection) => new FakeAgent(connection),
  ndJsonStream(
    WritableStreamFromNode(process.stdout),
    ReadableStreamFromNode(process.stdin),
  ),
);

function ReadableStreamFromNode(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as unknown as Readable) as ReadableStream<Uint8Array>;
}

function WritableStreamFromNode(stream: NodeJS.WritableStream): WritableStream<Uint8Array> {
  return Writable.toWeb(stream as unknown as Writable) as WritableStream<Uint8Array>;
}
