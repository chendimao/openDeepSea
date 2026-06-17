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
} else {
  process.on('SIGTERM', () => process.exit(0));
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
        sessionCapabilities: process.env.OPENCLAW_FAKE_ACP_CAN_RESUME === '1'
          ? { resume: {} }
          : undefined,
      },
      authMethods: [],
    };
  }

  async newSession() {
    return {
      sessionId: 'fake-session-1',
    };
  }

  async resumeSession() {
    if (process.env.OPENCLAW_FAKE_ACP_FAIL_RESUME === '1') {
      throw new Error(process.env.OPENCLAW_FAKE_ACP_FAIL_RESUME_MESSAGE ?? 'fake resumeSession failure');
    }
    return {};
  }

  async authenticate() {
    return {};
  }

  async prompt(params: PromptRequest) {
    if (process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_BEFORE_EVENT === '1') {
      throw new Error(process.env.OPENCLAW_FAKE_ACP_FAIL_PROMPT_MESSAGE ?? 'stream disconnected before completion: Transport error: network error: error decoding response body');
    }

    if (
      process.env.OPENCLAW_FAKE_ACP_FAIL_OLD_SESSION_SYSTEM_ROLE === '1' &&
      params.sessionId !== 'fake-session-1'
    ) {
      throw new Error('Internal error: API Error: 400 Failed to deserialize the JSON body into the target type: messages[1].role: unknown variant `system`, expected `user` or `assistant` at line 1 column 19981');
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

    if (process.env.OPENCLAW_FAKE_ACP_WORKFLOW_STAGE_OUTPUTS === '1') {
      const workflowOutput = fakeWorkflowStageOutput(params);
      if (workflowOutput) {
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: workflowOutput,
            },
          },
        });
        return {
          stopReason: 'end_turn' as const,
        };
      }
    }

    if (process.env.OPENCLAW_FAKE_ACP_ECHO_PROMPT === '1') {
      const firstText = params.prompt.find((block) => block.type === 'text');
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: firstText?.text ?? '',
          },
        },
      });
      return {
        stopReason: 'end_turn' as const,
      };
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

    if (process.env.OPENCLAW_FAKE_ACP_FAIL_AFTER_EVENT_SYSTEM_ROLE === '1') {
      throw new Error("Internal error: API Error: 400 messages[1].role must be either 'user' or 'assistant', but got 'system'");
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

function fakeWorkflowStageOutput(params: PromptRequest): string | null {
  const prompt = params.prompt
    .flatMap((block) => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n');
  if (!prompt) return null;

  const routingPlannerOutput = fakeRoutingPlannerStageOutput(prompt);
  if (routingPlannerOutput) return routingPlannerOutput;

  if (prompt.includes('代码审查智能体') || prompt.includes('spec_compliance_review') || prompt.includes('code_quality_review')) {
    return JSON.stringify({
      verdict: 'pass',
      findings: [],
      requiredFixes: [],
      riskLevel: 'low',
    });
  }

  if (prompt.includes('功能验收智能体') || prompt.includes('方案/文档验收智能体')) {
    return JSON.stringify({
      verdict: 'pass',
      acceptedCriteria: ['fake ACP workflow stage completed'],
      failedCriteria: [],
      notes: 'Accepted by fake ACP workflow stage output.',
    });
  }

  if (prompt.includes('brainstorming 阶段智能体')) {
    return JSON.stringify({
      superpowers: {
        designDocPath: 'docs/superpowers/specs/fake-workflow-design.md',
        designReviewVerdict: 'approved',
      },
    });
  }

  if (prompt.includes('writing_plans 阶段智能体')) {
    return [
      '```json',
      JSON.stringify(fakeWritingPlansPlan(prompt)),
      '```',
      '```json',
      JSON.stringify({
        superpowers: {
          implementationPlanPath: 'docs/superpowers/plans/fake-workflow-plan.md',
          planReviewVerdict: 'approved',
        },
      }),
      '```',
    ].join('\n');
  }

  if (prompt.includes('执行智能体') || prompt.includes('tdd_execute')) {
    return [
      'implementation completed',
      '',
      '```json',
      JSON.stringify({
        superpowers: {
          tddEvidence: [
            { stage: 'RED', command: 'node --test fake-workflow', passed: false, summary: 'failed as expected' },
            { stage: 'GREEN', command: 'node --test fake-workflow', passed: true, summary: 'passed' },
          ],
        },
      }),
      '```',
    ].join('\n');
  }

  if (prompt.includes('worktree 阶段智能体')) {
    return JSON.stringify({
      superpowers: {
        worktree: {
          path: process.cwd(),
          branchName: 'fake-workflow',
          baseRef: 'fake',
        },
      },
    });
  }

  return null;
}

function fakeRoutingPlannerStageOutput(prompt: string): string | null {
  const stage = prompt.match(/当前 Superpowers 路由阶段：([a-z_]+)/u)?.[1];
  if (!stage) return null;
  const goal = prompt.match(/用户目标：\n([\s\S]*?)\n\n当前 workflow state 摘要：/u)?.[1]?.trim() ?? '';
  if (stage === 'intake') {
    return fencedJson({
      intent: inferFakeRoutingIntent(goal),
      confidence: 0.97,
      reason: 'fake ACP planner routing evidence',
    });
  }
  if (stage === 'answer') {
    return fencedJson({
      answer: `fake ACP planner answer: ${goal}`,
    });
  }
  if (stage === 'analysis_plan') {
    return fencedJson({
      conclusion: `fake ACP planner analysis: ${goal}`,
      evidence: ['fake ACP routing planner evidence'],
      risks: [],
      recommendations: ['continue with workflow-first evidence'],
    });
  }
  if (stage === 'lightweight_plan') {
    return fencedJson({ plan: fakeSingleTaskPlan(goal, 'fake ACP lightweight plan', 'lightweight-executor') });
  }
  if (stage === 'debug_plan') {
    return fencedJson({ plan: fakeSingleTaskPlan(goal, 'fake ACP debug plan', 'debug-executor') });
  }
  if (stage === 'review_plan') {
    return fencedJson({
      goal,
      mode: 'review_only',
      reviewScope: ['fake ACP review scope'],
      verificationRequired: false,
    });
  }
  return null;
}

function inferFakeRoutingIntent(goal: string): string {
  const normalized = goal.toLowerCase();
  if (/分析|调研|评估|audit|analysis/.test(normalized)) return 'analysis';
  if (/怎么|为什么|解释|what|why|how/.test(normalized)) return 'answer';
  if (/debug|报错|失败|异常|排查|修复.*bug/.test(normalized)) return 'debug';
  if (/review|审查|代码审查/.test(normalized)) return 'review_only';
  if (/文案|readme|轻量|小改|配置/.test(normalized)) return 'lightweight_task';
  return 'standard_development';
}

function fakeSingleTaskPlan(goal: string, summary: string, suggestedRole: string) {
  return {
    goal,
    summary,
    assumptions: ['fake ACP deterministic browser validation'],
    tasks: [{
      title: summary,
      description: goal,
      suggestedRole,
      priority: 'normal',
      acceptance: ['workflow artifact can be approved from the browser'],
      scopeRead: ['.'],
      scopeWrite: [],
      dependsOn: [],
    }],
    reviewFocus: ['routing evidence'],
    verification: ['npm run build -w @openclaw-room/backend'],
    verificationCommands: [{
      command: 'npm run build -w @openclaw-room/backend',
      reason: 'backend compilation',
      required: true,
    }],
    risks: [],
    needsApproval: false,
  };
}

function fakeWritingPlansPlan(prompt: string) {
  const goal = prompt.match(/任务：\n([\s\S]*?)\n\n/u)?.[1]?.trim() ||
    prompt.match(/用户目标：\n([\s\S]*?)\n\n/u)?.[1]?.trim() ||
    'fake ACP writing plans task';
  return {
    goal,
    summary: 'fake ACP writing plans implementation plan',
    assumptions: ['fake ACP deterministic browser validation'],
    steps: [{
      title: 'Implement workflow-first routing',
      intent: goal,
      assigneeRole: 'executor',
      scopeRead: ['packages/backend/src/workflows'],
      scopeWrite: ['packages/backend/src/workflows'],
      acceptance: ['workflow-first path can proceed after plan approval'],
      dependsOn: [],
    }],
    risks: [],
    verification: [{
      command: 'npm run build -w @openclaw-room/backend',
      reason: 'backend compilation',
      required: true,
    }],
    needsApproval: false,
  };
}

function fencedJson(value: unknown): string {
  return ['```json', JSON.stringify(value), '```'].join('\n');
}
