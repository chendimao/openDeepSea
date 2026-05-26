#!/usr/bin/env node
import {
  AgentSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent,
  type AgentSideConnection as AgentConnection,
  type PromptRequest,
} from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';

class FakeAgent implements Agent {
  constructor(private readonly connection: AgentConnection) {}

  async initialize() {
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
      stopReason: 'end_turn' as const,
    };
  }

  async cancel() {
    return undefined;
  }

  async closeSession() {
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
