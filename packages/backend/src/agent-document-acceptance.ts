export type AgentDocumentAcceptanceCategory =
  | 'trigger_timing'
  | 'message_source'
  | 'context_requirements'
  | 'hard_exclusions'
  | 'score_thresholds'
  | 'duplicate_archive'
  | 'manual_save'
  | 'cancel_archive'
  | 'asset_type_boundary'
  | 'implementation_scope';

export interface AgentDocumentAcceptanceCriterion {
  id: string;
  category: AgentDocumentAcceptanceCategory;
  standard: string;
  acceptanceChecks: string[];
}

export const AGENT_DOCUMENT_ACCEPTANCE_CRITERIA: AgentDocumentAcceptanceCriterion[] = [
  {
    id: 'trigger-after-agent-message-complete',
    category: 'trigger_timing',
    standard: '自动归档评估只允许在智能体消息完整结束后触发，不得在流式输出、partial delta、typing 或运行进度事件中归档。',
    acceptanceChecks: [
      '给定 messageComplete=false，判定结果必须是不归档。',
      '给定流式输出中途的消息片段，不得创建 agent_document。',
      '只有最终完整消息内容可以进入硬排除和评分流程。',
    ],
  },
  {
    id: 'only-agent-message-can-auto-archive',
    category: 'message_source',
    standard: '自动归档只处理 sender_type=agent 的智能体消息，不对用户消息、系统消息、工具日志或状态事件自动归档。',
    acceptanceChecks: [
      '给定 sender_type=user，即使内容像文档，也必须是不归档。',
      '给定 sender_type=system 或工具事件，必须是不归档。',
      '用户上传文件不通过自动归档判定流程生成 agent_document。',
    ],
  },
  {
    id: 'requires-traceable-context',
    category: 'context_requirements',
    standard: '进入自动归档评估前必须具备 project_id、room_id、message_id 和 agent_id，缺任一字段都不得归档。',
    acceptanceChecks: [
      '缺少 project_id 时不归档。',
      '缺少 room_id 时不归档。',
      '缺少 message_id 或 agent_id 时不归档。',
      '归档资源必须能通过 source_message_id、source_room_id、source_agent_id 追溯来源。',
    ],
  },
  {
    id: 'hard-exclusions-run-before-scoring',
    category: 'hard_exclusions',
    standard: '硬排除必须先于评分执行；短回复、普通聊天、日志输出、错误堆栈、纯代码块、代码占比过高、进度播报、无结构且无文档关键词的内容不得自动归档。',
    acceptanceChecks: [
      '内容长度小于 500 字符时不归档。',
      '代码块内容占比超过 70% 时不归档。',
      '日志、终端输出或错误堆栈特征明显时不归档。',
      '无 Markdown 结构且无文档关键词时不归档。',
      '命中硬排除后不得继续用评分项把结果提升为自动归档。',
    ],
  },
  {
    id: 'score-thresholds-are-conservative',
    category: 'score_thresholds',
    standard: '通过硬排除后再按标题、章节、列表/表格/任务清单、文档关键词、内容长度、智能体角色和用户文档化意图评分；score>=5 自动归档，score 3-4 仅建议手动保存，score<3 不归档。',
    acceptanceChecks: [
      'score>=5 时结果为 auto_archive。',
      'score 3-4 时结果为 suggest_manual_save，不得自动创建资源。',
      'score<3 时结果为 do_not_archive。',
      '单个弱信号不得触发自动归档。',
    ],
  },
  {
    id: 'duplicate-source-message-is-not-archived-twice',
    category: 'duplicate_archive',
    standard: '同一个 source_message_id 已存在 agent_document 时，不得再次自动归档或手动保存为第二份同源文档。',
    acceptanceChecks: [
      '重复评估同源消息时返回不归档。',
      '资源库中同一 source_message_id 和 asset_type=agent_document 只允许一条有效记录。',
      '重复场景不得影响原始聊天消息。',
    ],
  },
  {
    id: 'manual-save-covers-non-auto-archived-agent-documents',
    category: 'manual_save',
    standard: '未自动归档但用户认为有价值的智能体消息，可以由用户手动保存为 agent_document；score 3-4 的灰区内容默认只提示手动保存。',
    acceptanceChecks: [
      '手动保存对象必须是可追溯的智能体消息。',
      '手动保存后的资源 asset_type=agent_document，group_key=agent_documents。',
      '手动保存元数据应区分 manual_saved=true 和 auto_archived=false。',
      'score 3-4 不自动写库，只提供保存入口。',
    ],
  },
  {
    id: 'cancel-archive-removes-resource-only',
    category: 'cancel_archive',
    standard: '已归档的 agent_document 可以取消归档或从资源库移除；取消只影响资源记录，不删除原始聊天消息，也不影响用户上传文件。',
    acceptanceChecks: [
      '取消归档后资源库不再展示该 agent_document。',
      '取消归档不得删除或修改原始 messages 记录。',
      '取消归档不得删除 uploaded_file 或文件表记录。',
      '用户文案必须区分移除归档文档和删除聊天消息。',
    ],
  },
  {
    id: 'uploaded-file-and-agent-document-are-separate-assets',
    category: 'asset_type_boundary',
    standard: 'uploaded_file 与 agent_document 必须保持资源类型和分组边界：用户上传文件走 uploaded_file/uploaded_files，智能体生成文档走 agent_document/agent_documents。',
    acceptanceChecks: [
      '用户上传文件必须保持 asset_type/group_key=uploaded_file/uploaded_files。',
      '智能体文档必须保持 asset_type/group_key=agent_document/agent_documents。',
      '用户上传文件不得被自动归档判定改写为 agent_document。',
      'agent_document 使用 text/markdown 和来源消息字段表达智能体文档资产。',
      'uploaded_file 使用文件记录、file_id、url、mime_type 和上传者字段表达上传资产。',
      '资源列表可以合并展示两类资产，但筛选和删除语义必须区分。',
    ],
  },
  {
    id: 'acceptance-only-does-not-complete-auto-archive-implementation',
    category: 'implementation_scope',
    standard: '本轮只形成后续实现和测试可直接使用的验收标准，不要求完成消息完成事件接入、数据库迁移、自动创建资源、前端保存入口或取消归档 UI。',
    acceptanceChecks: [
      '本轮不得声称自动归档功能已完整实现。',
      '后续实现仍需单独接入消息完成事件和资源创建流程。',
      '后续实现仍需补充接口、前端交互和端到端验证。',
    ],
  },
];
