import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyAgentWorkflowState } from './state.js';
import { createSuperpowersRoutingNodes } from './superpowers-routing-nodes.js';
import type { WorkflowArtifactVersionType } from '../../types.js';

test('routeSkills records answer route and completes through answer node', async () => {
  const createdArtifacts: Array<{ artifact_type: WorkflowArtifactVersionType; structured_data: unknown }> = [];
  const nodes = createSuperpowersRoutingNodes({
    createArtifactVersionDraft(input) {
      createdArtifacts.push({ artifact_type: input.artifact_type, structured_data: input.structured_data });
      return { id: `artifact-${createdArtifacts.length}` };
    },
    createAssistantMessage() {
      return { id: 'message-answer-1' };
    },
  });
  const initial = emptyAgentWorkflowState({
    workflowRunId: 'run-1',
    projectId: 'project-1',
    roomId: 'room-1',
    taskId: 'task-1',
    userGoal: '这个项目是什么？',
    projectPath: '/tmp/project',
  });

  const intake = await nodes.intake(initial);
  const routed = await nodes.routeSkills({
    ...intake,
    selectedIntent: 'answer',
  });
  const answered = await nodes.answer(routed);

  assert.equal(routed.selectedIntent, 'answer');
  assert.deepEqual(routed.selectedPath, ['intake', 'route_skills', 'answer']);
  assert.equal(answered.status, 'completed');
  assert.equal(answered.currentNode, 'answer');
  assert.equal(createdArtifacts.some((artifact) => artifact.artifact_type === 'intent_routing'), true);
});
