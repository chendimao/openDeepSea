import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'openclaw-monitor-service-'));
const projectDir = join(tempDir, 'project');
mkdirSync(projectDir);
process.env.OPENCLAW_ROOM_DB = join(tempDir, 'test.db');

const { agentRunRepo } = await import('../repos/agent-runs.js');
const { messageRepo } = await import('../repos/messages.js');
const { projectRepo } = await import('../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowIncidentRepo } = await import('../repos/workflow-incidents.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { runWorkflowMonitorOnce, recoverWorkflowStartupOrphans, startWorkflowMonitorService } = await import('./workflow-monitor-service.js');

test('runWorkflowMonitorOnce scans, decides, executes, and records chat message', async () => {
  const fixture = createFixture('run once');
  workflowRepo.blockRun(fixture.workflow.id, 'No executor available for implementation');

  const count = await runWorkflowMonitorOnce({ disableModel: true });

  assert.equal(count, 1);
  assert.equal(workflowIncidentRepo.listByWorkflow(fixture.workflow.id)[0]?.incident_type, 'executor_unavailable');
  assert.ok(roomAgentRepo.listByRoom(fixture.room.id).some((agent) => agent.agent_id === 'backend-executor'));
  assert.equal(recoveryMessages(fixture.room.id).length, 1);
});

test('startWorkflowMonitorService skips overlapping scans with lock', async () => {
  let release!: () => void;
  let calls = 0;
  const service = startWorkflowMonitorService({
    intervalMs: 60_000,
    scanner: () => [{ id: 'incident-1' } as never],
    recoveryHandler: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: 'executed' };
    },
  });

  const first = service.runOnce();
  const second = await service.runOnce();
  release();
  const firstCount = await first;
  service.stop();

  assert.equal(second, 0);
  assert.equal(firstCount, 1);
  assert.equal(calls, 1);
});

test('recoverWorkflowStartupOrphans turns active run and running step into monitor incidents', async () => {
  const fixture = createFixture('startup orphans');
  const step = workflowRepo.createStep({
    workflow_run_id: fixture.workflow.id,
    task_id: fixture.childTask.id,
    stage: 'implementation',
    status: 'running',
    room_agent_id: fixture.agent.id,
    sort_order: 1,
  });
  agentRunRepo.create({
    room_id: fixture.room.id,
    room_agent_id: fixture.agent.id,
    agent_id: fixture.agent.agent_id,
    backend: 'codex',
    task_id: fixture.childTask.id,
    workflow_run_id: fixture.workflow.id,
    workflow_step_id: step.id,
    workflow_stage: 'implementation',
    prompt: 'implement',
  });

  const recovered = await recoverWorkflowStartupOrphans({
    buildInterruptedRunReason: async () => 'Backend restarted before agent run completed',
  });
  const incidents = workflowIncidentRepo.listByWorkflow(fixture.workflow.id);

  assert.ok(recovered.interruptedAgentRuns >= 1);
  assert.ok(recovered.orphanedSteps >= 1);
  assert.ok(incidents.some((incident) => incident.incident_type === 'backend_restart_interrupted'));
});

function createFixture(name: string) {
  const fixtureProjectDir = join(projectDir, name.replace(/\s+/g, '-'));
  mkdirSync(fixtureProjectDir, { recursive: true });
  const project = projectRepo.create({ name: `Project ${name}`, path: fixtureProjectDir });
  const room = roomRepo.create({ project_id: project.id, name: `Room ${name}` });
  const agent = configureExecutor(roomAgentRepo.add({
    room_id: room.id,
    agent_id: `codex-${name.replace(/\s+/g, '-')}`,
    agent_name: 'Codex Agent',
  }));
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: `Parent ${name}`,
  });
  taskRepo.updateStatus(task.id, 'in_progress');
  const childTask = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    parent_task_id: task.id,
    title: `Child ${name}`,
    description: 'packages/backend implementation',
    assigned_agent_id: agent.id,
  });
  taskRepo.updateStatus(childTask.id, 'in_progress');
  const workflow = workflowRepo.createRun({
    room_id: room.id,
    project_id: project.id,
    task_id: task.id,
    status: 'running',
    current_stage: 'implementation',
  });
  return { project, room, agent, task, childTask, workflow };
}

function configureExecutor(agent: ReturnType<typeof roomAgentRepo.add>) {
  const withRole = roomAgentRepo.setWorkflowRole(agent.id, 'executor') ?? agent;
  const withAcp = roomAgentRepo.setAcp(withRole.id, {
    acp_enabled: true,
    acp_backend: 'codex',
    acp_session_id: null,
    acp_session_label: null,
  }) ?? withRole;
  return roomAgentRepo.setCapabilitiesAndRuntime(withAcp.id, {
    capabilities: ['backend'],
    default_runtime: 'acp',
  }) ?? withAcp;
}

function recoveryMessages(roomId: string) {
  return messageRepo.listByRoom(roomId).filter((message) => {
    if (!message.metadata) return false;
    const metadata = JSON.parse(message.metadata) as Record<string, unknown>;
    return metadata.event_type === 'workflow_recovery_decided';
  });
}
