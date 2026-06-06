const iconColors = {
  Read: "text-green-500",
  Grep: "text-blue-500",
  Write: "text-blue-500",
  Run: "text-blue-500",
};

const badgeColors = {
  TSX: "bg-blue-100 text-blue-600",
  TS: "bg-blue-100 text-blue-600",
  default: "bg-gray-100 text-gray-600",
};

function ToolIcon({ type }) {
  if (type === "Read") {
    return (
      <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
        <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (type === "Grep") {
    return (
      <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-blue-100">
        <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 111 11a6 6 0 0116 0z" />
        </svg>
      </div>
    );
  }
  if (type === "Write") {
    return (
      <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-blue-100">
        <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
      </div>
    );
  }
  // Run
  return (
    <div className="w-5 h-5 rounded flex items-center justify-center flex-shrink-0 bg-blue-100">
      <svg className="w-3 h-3 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    </div>
  );
}

function ToolRow({ tool }) {
  const badgeClass = badgeColors[tool.badge] || badgeColors.default;
  return (
    <div className="flex items-center gap-3 py-2">
      <ToolIcon type={tool.type} />
      <div className="flex items-center gap-1 min-w-[80px]">
        <span className="text-xs text-gray-500">{tool.label}</span>
      </div>
      <svg className="w-3 h-3 text-gray-300 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
      </svg>
      <span className="text-xs text-gray-700 flex-1 truncate">{tool.path}</span>
      {tool.badge && (
        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${badgeClass}`}>{tool.badge}</span>
      )}
      {tool.lines && (
        <span className="text-xs text-gray-400">{tool.lines}</span>
      )}
      {tool.result && (
        <span className={`text-xs font-medium ${tool.resultColor || "text-gray-500"}`}>{tool.result}</span>
      )}
    </div>
  );
}

export function ToolCallBlock({ title, count, time, tools }) {
  return (
    <div className="mx-4 my-2 border border-gray-100 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 border-b border-gray-100">
        <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="text-xs font-medium text-gray-700">{title}</span>
        {count && <span className="text-xs text-gray-400">{count} 个</span>}
        <span className="ml-auto text-xs text-gray-400">{time}</span>
      </div>
      <div className="px-3 divide-y divide-gray-50 bg-white">
        {tools.map((tool, i) => (
          <ToolRow key={i} tool={tool} />
        ))}
      </div>
    </div>
  );
}
